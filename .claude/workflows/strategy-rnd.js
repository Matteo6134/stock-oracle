export const meta = {
  name: 'strategy-rnd',
  description: 'Iterative strategy R&D: backtest new algorithm variants vs the monkey baseline, fold in current news signals, and propose the smartest VALIDATED improvement. Never auto-edits live trading code — winners come back as a ranked report + ready-to-apply code.',
  whenToUse: 'Run repeatedly to make the bot smarter over time — each run reads the prior R&D log, tries NEW ideas, and records what beat the baseline.',
  phases: [
    { title: 'Recon & baseline' },
    { title: 'Ideate variants' },
    { title: 'Backtest variants' },
    { title: 'News signals' },
    { title: 'Judge & synthesize' },
  ],
}

// ─────────────────────────────────────────────────────────────
// Iterative strategy R&D loop for the stock-oracle trading bot.
// Tooling it builds on (all real, present in the repo):
//   python/backtest/historical_replay.py   multi-strategy backtest + monkey baseline (lookahead-safe, slippage)
//   python/backtest/backtest_predictions.py per-signal attribution from Supabase
//   python/backtest/archive/ohlcv_daily.parquet   238-symbol x 3y price archive
//   python/backtest/replay_results/replay_report.json   latest baseline replay
//   python/backtest/signal_attribution.json   latest signal edge readout
//   server/services/news.js / Finnhub          current news
// Accumulator: python/backtest/rnd_log.json (best-so-far + tried ideas) — read at start, appended at end.
// ─────────────────────────────────────────────────────────────

const ROOT = 'c:/Users/pc2/Desktop/binance-bot'
const PYDIR = `${ROOT}/python/backtest`
const focus = (args && args.focus) || 'general edge improvement (return + Sharpe + monkey percentile)'

// ── Schemas ──────────────────────────────────────────────────
const RECIPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    howStrategiesAreDefined: { type: 'string', description: 'Exactly where/how a strategy is registered in historical_replay.py (dict name, function signature, what it receives and returns)' },
    featureLagNote: { type: 'string', description: 'How features are lagged to stay look-ahead-safe — a new strategy MUST follow this' },
    runCommand: { type: 'string', description: 'Exact CLI to run one or more strategies, including flags for window/slippage/min-dollar-volume' },
    outFlag: { type: 'string', description: 'Whether --out or an output-dir flag exists so a copy can avoid clobbering replay_results/replay_report.json; the exact flag, or "none"' },
    addStrategyExample: { type: 'string', description: 'A concrete code snippet showing how to add one new strategy function/entry' },
  },
  required: ['summary', 'howStrategiesAreDefined', 'featureLagNote', 'runCommand', 'outFlag', 'addStrategyExample'],
}

const BASELINE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    spyReturnPct: { type: 'number' },
    monkeyMedianPct: { type: 'number' },
    monkeyP75Pct: { type: 'number' },
    strategies: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' }, totalReturnPct: { type: 'number' }, sharpe: { type: 'number' },
        winRate: { type: 'number' }, maxDrawdownPct: { type: 'number' }, monkeyPercentile: { type: 'number' },
      }, required: ['name', 'totalReturnPct', 'monkeyPercentile'],
    } },
    bestSignals: { type: 'array', items: { type: 'string' }, description: 'top signals "name hit% avgRet% n"' },
    worstSignals: { type: 'array', items: { type: 'string' } },
    killerCombos: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['strategies', 'bestSignals', 'worstSignals', 'notes'],
}

const HISTORY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    hasLog: { type: 'boolean' },
    triedIdeas: { type: 'array', items: { type: 'string' }, description: 'short descriptions of variants already tested in prior runs (avoid repeating)' },
    bestSoFar: { type: 'string', description: 'best variant + metric from prior runs, or "none"' },
  },
  required: ['hasLog', 'triedIdeas', 'bestSoFar'],
}

const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: { type: 'array', minItems: 3, maxItems: 5, items: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'snake_case strategy name for the harness, e.g. vol_contraction_combo' },
        hypothesis: { type: 'string' },
        spec: { type: 'string', description: 'Precise, implementable rule: entry condition, ranking/score, exit — expressed in terms the harness can compute from lagged features' },
        groundedIn: { type: 'string', description: 'Which baseline finding (signal edge / combo / weakness) motivates this' },
      }, required: ['name', 'hypothesis', 'spec', 'groundedIn'],
    } },
  },
  required: ['candidates'],
}

const VARIANT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    harnessFile: { type: 'string', description: 'path to the R&D copy that was run' },
    results: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' }, totalReturnPct: { type: 'number' }, sharpe: { type: 'number' },
        winRate: { type: 'number' }, maxDrawdownPct: { type: 'number' }, monkeyPercentile: { type: 'number' },
        nTrades: { type: 'number' }, implemented: { type: 'boolean' }, error: { type: 'string' },
      }, required: ['name', 'implemented'],
    } },
    candidateCode: { type: 'string', description: 'The exact strategy code added, so winners can be reused' },
    notes: { type: 'string' },
  },
  required: ['results', 'candidateCode', 'notes'],
}

const NEWS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    themes: { type: 'array', items: { type: 'string' }, description: 'current market/sector/ticker news themes relevant to the bot universe' },
    proposedRule: { type: 'string', description: 'A concrete news-gating or news-boost rule for entries/exits' },
    codeLocation: { type: 'string', description: 'Where it would go (file + function), e.g. server/services/news.js + autoTrader.js processSignals' },
    historicallyBacktestable: { type: 'boolean', description: 'false if point-in-time news is unavailable (it is — say so honestly)' },
    forwardTestPlan: { type: 'string' },
  },
  required: ['themes', 'proposedRule', 'codeLocation', 'historicallyBacktestable', 'forwardTestPlan'],
}

const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    ranking: { type: 'array', items: { type: 'string' }, description: 'variants ranked best→worst with key metric vs baseline + monkey percentile' },
    winner: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' }, beatsBaseline: { type: 'boolean' }, beatsMonkey50: { type: 'boolean' },
        metrics: { type: 'string' }, whyItWins: { type: 'string' }, overfitRisk: { type: 'string' },
        code: { type: 'string', description: 'ready-to-apply strategy code' },
      }, required: ['name', 'beatsBaseline', 'beatsMonkey50', 'metrics', 'overfitRisk'],
    },
    newsRecommendation: { type: 'string' },
    nextStep: { type: 'string', description: 'concrete recommended action for the bot owner (NOT auto-applied)' },
    logAppended: { type: 'boolean' },
  },
  required: ['headline', 'ranking', 'winner', 'newsRecommendation', 'nextStep', 'logAppended'],
}

// ── Phase 1: Recon & baseline (parallel) ─────────────────────
phase('Recon & baseline')
const [recipe, baseline, history] = await parallel([
  () => agent(
    `Read ${PYDIR}/historical_replay.py IN FULL. Return the exact "recipe" a teammate needs to add a NEW backtest strategy and run it without breaking look-ahead safety.
Specifically: how strategies are registered (the dict/function names), the strategy function signature and what columns/features it receives (and which are already lagged), how to run one or more strategies from the CLI (exact flags for window, slippage, min-dollar-volume, and whether an --out/output-dir flag exists so a COPY won't clobber replay_results/replay_report.json), and a concrete snippet adding one new strategy. Use the schema.`,
    { label: 'recon:recipe', phase: 'Recon & baseline', schema: RECIPE_SCHEMA }
  ),
  () => agent(
    `Read ${PYDIR}/replay_results/replay_report.json and ${PYDIR}/signal_attribution.json. Return the current BASELINE: SPY buy&hold return, monkey distribution (median, p75), each existing strategy's total return / sharpe / win rate / max drawdown / monkey percentile, and from signal attribution the best & worst signals (as "name hit% avgRet% n") and the top killer combos. Use the schema. This is "where we are" — what any new variant must beat.`,
    { label: 'recon:baseline', phase: 'Recon & baseline', schema: BASELINE_SCHEMA }
  ),
  () => agent(
    `Check whether ${PYDIR}/rnd_log.json exists (this workflow's accumulator of prior R&D runs). If it exists, read it and summarize which variant ideas were already tried (so we don't repeat them) and the best-so-far result. If it does not exist, return hasLog=false, empty triedIdeas, bestSoFar="none". Use the schema.`,
    { label: 'recon:history', phase: 'Recon & baseline', schema: HISTORY_SCHEMA }
  ),
])

// ── Branch X (ideate → backtest) and Branch Y (news) run concurrently ──
const variantBranch = async () => {
  phase('Ideate variants')
  const ideas = await agent(
    `You are a quant proposing NEW trading-strategy variants to backtest for the stock-oracle bot. Focus: ${focus}.

BASELINE (what to beat):
${JSON.stringify(baseline, null, 2)}

ALREADY TRIED (do NOT repeat):
${JSON.stringify(history, null, 2)}

HARNESS RECIPE (variants must be implementable within this; features are lagged for look-ahead safety):
${JSON.stringify(recipe, null, 2)}

Propose 3-5 DISTINCT, concrete, implementable candidate strategies. Ground each in a baseline finding (e.g. a high-edge signal, a killer combo, or a known weakness like the gem-score buckets where medium scores beat high). Each spec must be expressible as entry condition + ranking/score + exit using only lagged features the harness can compute. Prefer ideas that exploit the strongest signals/combos and avoid the proven-weak ones. Use the schema.`,
    { label: 'ideate', phase: 'Ideate variants', schema: IDEAS_SCHEMA }
  )

  phase('Backtest variants')
  const results = await agent(
    `You are implementing and backtesting candidate strategies for the stock-oracle bot. Work in ${PYDIR}.

RECIPE (follow exactly for registration + look-ahead safety):
${JSON.stringify(recipe, null, 2)}

CANDIDATES to implement & test:
${JSON.stringify(ideas.candidates, null, 2)}

Steps:
1. Copy historical_replay.py to historical_replay_rnd.py (so the original stays untouched). Use Bash: cp.
2. Implement EVERY candidate strategy in the copy, following the recipe's registration pattern and lagging features exactly as the original does (NO look-ahead).
3. Run the copy over the existing archive (${PYDIR}/archive/ohlcv_daily.parquet) for ALL candidates PLUS 'composite' (baseline) and 'random' (monkey check). POLICY: always backtest the FULL archive history (~2016 -> latest), NOT a recent slice — full history across multiple regimes (2018 selloff, 2020 crash, 2022 bear, 2024-25 bull) is the only honest test and prevents regime-overfit. OMIT --start/--end so the harness defaults to the full window (it now does). Use --min-dollar-volume 20000000 --slippage-pct 0.10. If the recipe says an --out/output-dir flag exists, use a SEPARATE output (e.g. replay_results_rnd/) so the live baseline report is not overwritten; otherwise note that you accepted overwrite. NOTE: the full-history run is memory-heavy and the machine is RAM-constrained during active desktop use — if you hit a numpy ArrayMemoryError, report it clearly (the heavy run is meant for overnight when RAM is free); do NOT silently fall back to a shorter window.
4. Parse the resulting report JSON and return per-strategy total return / sharpe / win rate / max drawdown / monkey percentile / n_trades for each candidate and for composite+random. If a candidate fails to implement or run, set implemented=false with the error and continue with the others.
5. Return the exact candidate code you added (candidateCode) so winners can be reused. Use the schema. Be honest about failures — do not fabricate metrics.`,
    { label: 'backtest', phase: 'Backtest variants', schema: VARIANT_SCHEMA }
  )
  return { ideas, results }
}

const newsBranch = async () => {
  phase('News signals')
  return agent(
    `You are deriving a NEWS-based edge for the stock-oracle trading bot (paper). Find CURRENT, real news — do not invent it.

How to get news (try in order, use what works):
  - Run the bot's own news service, e.g. from ${ROOT}: node --input-type=module -e "import('./server/services/news.js').then(m=>console.log(Object.keys(m)))" then call the relevant exported function for a few tickers / 'market'. FINNHUB_API_KEY is in .env.
  - If that's unclear, load a web-search tool via ToolSearch ("select:WebSearch") and search for today's market-moving news, sector rotation, and catalysts relevant to small/mid-cap momentum & squeeze names.
  - Also consider the bot's universe themes (AI, quantum, biotech, crypto-miners, nuclear).

Then: identify the top current news THEMES, and propose ONE concrete, implementable news rule that would make entries/exits smarter (e.g. gate entries when broad-market news is risk-off; boost gemScore on a positive catalyst within N hours; block entries into a stock with pending dilution/offering news). Specify exactly WHERE it goes (file + function — news.js already exists; autoTrader.processSignals gates entries).
IMPORTANT — be honest: the historical price archive has NO point-in-time news, so this rule canNOT be cleanly backtested historically. Set historicallyBacktestable=false and give a concrete FORWARD-test plan (Telegram-only shadow test for N weeks, compare entry win-rate with vs without the news gate). Use the schema.`,
    { label: 'news', phase: 'News signals', schema: NEWS_SCHEMA }
  )
}

const [variant, news] = await parallel([variantBranch, newsBranch])

// ── Phase 5: Judge & synthesize ──────────────────────────────
phase('Judge & synthesize')
const final = await agent(
  `You are the lead quant deciding what (if anything) actually makes the stock-oracle bot smarter, and recording it for next time. Be rigorous and skeptical — a backtest edge is necessary but not sufficient.

BASELINE: ${JSON.stringify(baseline, null, 2)}
PRIOR RUNS: ${JSON.stringify(history, null, 2)}
VARIANT BACKTESTS: ${JSON.stringify(variant.results, null, 2)}
NEWS PROPOSAL: ${JSON.stringify(news, null, 2)}

Do this:
1. Rank all tested variants best→worst by a blend of total return, Sharpe, and monkey percentile. A variant only "wins" if it BEATS the composite baseline AND sits above the 50th monkey percentile AND has enough trades (>= ~100) to not be noise. Flag overfit risk for anything with very few trades or implausibly high returns.
2. Pick the winner (or state honestly that NOTHING beat baseline this run — that is a valid, useful result).
3. Summarize the news recommendation and its forward-test plan.
4. Give ONE concrete nextStep for the bot owner. Do NOT claim anything was applied to live trading — it was not; this is a proposal.
5. APPEND this run's results to ${PYDIR}/rnd_log.json (create it if missing) as a new entry: { run id, focus, candidates tried (names + one-line spec), per-variant metrics, winner, and the news rule}. Use Read then Write so prior entries are preserved. Set logAppended accordingly.
Use the schema.`,
  { label: 'synthesize', phase: 'Judge & synthesize', schema: FINAL_SCHEMA }
)

return { final, variantResults: variant.results, news, baseline }
