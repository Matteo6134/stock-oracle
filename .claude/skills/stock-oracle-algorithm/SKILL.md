---
name: stock-oracle-algorithm
description: Reference for HOW the stock-oracle Node trading algorithm at C:/Users/pc2/Desktop/binance-bot works — signal detection, scoring, agent voting, Claude validation, position sizing, exit logic, adaptive learning. Use when developing a v2/v3, refactoring scoring, tuning thresholds, debugging trade decisions, or proposing strategy changes. Triggers: "stock oracle algorithm", "gem score", "auto trader logic", "v2", "v3", "rewrite scoring", "why didn't it buy/sell", "calibration", "signal weights".
---

# Stock-Oracle Algorithm — Ground Truth Reference

> All citations: `file.js:LINE`. Codebase root: `C:/Users/pc2/Desktop/binance-bot/server/`.

## Pipeline at a glance

```
Universe ~300 syms ─┐
Yahoo screeners ────┼─► tomorrowMovers / pennyScanner / premarketScanner
Earnings cal       ─┘            │
                                 ▼
                         analyzeGem()  ── 5 rule-based agent personas vote
                                 │
                                 ▼  (calibration may upgrade Buy→Strong Buy)
                  signal enrichment overlays:
                  options · congress · darkPool · insider · analyst · social · VIX
                                 │
                                 ▼
                         claudeBrain.analyzeStock()  (Gemini primary, Claude fallback)
                                 │  (can VETO via SKIP, or upgrade Buy→Strong Buy)
                                 ▼
                         autoTrader.processSignals() → Alpaca paper limit + broker stop
                                 │
                                 ▼
                         autoTrader.checkExitSignals()  every 2 min  ("sell only in profit")
                                 │
                                 ▼
                         gemHistory → outcomes resolved → signalLearner adjusts weights
```

`scorer.js` (692 lines) is a **separate** earnings-quality engine for `/api/score` style research; NOT in the trading path. The trading path uses `tomorrowMovers.calculateGemScore`.

---

## 1. tomorrowMovers.js — Gem Finder (heart of strategy)

**Pre-gates**: `price ≥ $1` and `regularMarketVolume ≥ 100k` (`:508-509`).

**18 signal detectors** (`_scan` `:506-742`) — each adds to `setupScore` and pushes to `signals[]`:

| Signal | Trigger | Bump |
|---|---|---|
| unusual_volume | volRatio≥2 && \|chg\|<3 (stealth) | min(20, vr×3) `:533` |
| multi_day_accumulation | volTrend>1.3 && streak≥2d | min(25, vt×8 + s×3) `:546` |
| smart_money | smartMoneyScore>8 | min(20, sm) `:559` |
| early_momentum | volRatio≥1.5 && 1<chg<5 | +12 `:570` |
| momentum_acceleration | momentumAccel>2 | min(15, ma×2) `:581` |
| short_squeeze_loading | SI>15 && chg>-1 | 20/15/10 by SI tier `:594` |
| bb_squeeze / volume_contraction | from breakoutLookup | +12 / +6 `:608-616` |
| near_52w_high | price ≥ 0.95×52wH && volRatio>1.2 | +10 `:624` |
| earnings_tomorrow | sym in cal | +15 `:634` |
| low_float_volume | float<50M && volRatio≥1.3 | 15/10/6 `:644` |
| sector_lag | sector avg>1.5% but stock<30% of that | +8 `:660` |
| oversold_bounce | price<50dMA×0.85 && volRatio<0.7 | +8 `:673` |
| bull_flag | price>50dMA×1.1 && vr<0.8 && \|chg\|<2 | +7 `:683` |
| golden_cross | 50dMA/200dMA ∈ 0.97-1.03 && 50>200 | +6 `:693` |
| price_compression | priceCompression>0.65 && vr>0.8 | +8 `:705` |
| volume_acceleration | volAccelerating && rate>1.5 | min(22, r×8) `:716` |
| stealth_accumulation | redDayBuying≥2 | min(22, r×8) `:727` |
| early_breakout | 1<ret2d<5 && compression>0.5 | +16 `:738` |

**`analyzeHistory()` math** (`:50-191`):
- `volumeTrend = avg(last5) / avg(prior10)`
- `volumeStreakDays`: consecutive days with `vol > 1.2× overallAvg`
- `volumeAccelerating`: ≥2 of last 5 each ≥10% higher than prev
- `redDayBuying`: down day + close above midpoint(>0.45) + vol>1.3× avg
- `priceCompression = 1 - recent5Range / full20Range`
- `earlyBreakout = 1<ret2d<5 && compression>0.5`

**Inclusion gate** (`:745`): `signals.length≥2 && setupScore≥20` → only then `calculateGemScore` runs.

### `calculateGemScore()` (`:195-271`)

`finalScore = Σ getLearnedWeight(sig) × multipliers + comboBonus`

Default weights table at `:197-253`. **Top weights**:
```
congress_cluster 24      call_sweep_large 24       insider_cluster 24
volume_acceleration 22   stealth_accumulation 22
multi_day_accumulation 20  insider_buying 20  senate_buy 20
dark_pool_squeeze 20  options_volume_explosion 20
deep_itm_calls 18  put_call_extreme_bullish 18  analyst_momentum 18  insider_heavy_buy 18
short_squeeze_loading 16  smart_money 16  analyst_upgrade 16
call_sweep 16  shorts_covering 16  early_breakout 16  bullish_options 16
```

**Multipliers** (`:266-267`): `≥4 signals → ×1.3`, `≥3 → ×1.15`. **Combo bonus** (`signalLearner.js:259-277`): killer-combo pairs add `round(hit10Rate × 0.2)` capped at +25. **Capped at 100**.

### `predictExplosion()` (`:282-404`)
10 factors → `{expectedGainPct, targetPrice, daysToMove, probability, urgency, factors[]}`. Examples:
- float<5M → +40% gain, +10 prob `:291`
- volRatio≥5 → +30%, +15 prob, days≤2 `:304`
- short_squeeze_loading & SI>30 → +50%, +12 prob, days≤2 `:332`
- marketCap<100M → expectedGainPct ×= 1.5 `:374`

Capped: prob 85, gain 200%, days 1-7.

### Order-flow overlay for top 15 (`:776-841`)
- `insider_buying`: net>0 → +22/+16/+10 by size
- `bullish_options`: P/C<0.7 → +18 (<0.5) or +12
- `unusual_options_volume` → +12
- `institutions_accumulating`: netChange>5 → +16/+10
- **Triple threat** (insider + options + volume) → `risk='high_conviction'` `:835`

**Output buckets**: `gems` (score≥60, top 10), `topPicks`, `accumulation`, `coiledSprings`, `earlyRunners`, `earningsPlays`, `bounces`, `all` (top 40) (`:846-885`).

**WHEN**: cron `*/5 * * * *` 8AM–6PM ET weekdays (`index.js:239`). 10-min cache.

---

## 2. tradingDesk.js — 5-Agent Voting

| Agent | Style | Cares about | gainRange% | days | stop% |
|---|---|---|---|---|---|
| Momentum Mike 🚀 | momentum | early_momentum, momentum_acceleration, near_52w_high, bull_flag, golden_cross, volume_acceleration | 15-30 | 3-5 | **7** |
| Squeeze Sarah 🔥 | squeeze | short_squeeze_loading, bb_squeeze, price_compression, volume_contraction | 20-50 | 1-3 | **5** |
| Volume Victor 📊 | accumulation | unusual_volume, multi_day_accumulation, smart_money, volume_acceleration, institutions_accumulating | 10-20 | 3-7 | **8** |
| Catalyst Claire ⚡ | catalyst | earnings_tomorrow | 5-15 | 1 | **3** |
| Contrarian Carlos 🔄 | contrarian | oversold_bounce, sector_lag | 8-15 | 5-7 | **10** |

Each returns `{action: BUY|WATCH|SKIP, conviction: 0-5, targetGain%, stopLoss, targetPrice, reasoning}`.

**Conviction**: `min(5, 2 + matchedSignals)` + bonuses (volRatio≥1.5 +1, momentumAccel>3 +1, options flow +1).

**Consensus** (`analyzeGem()` `:328-396`):
- 3+ BUYs → **Strong Buy**
- 2 → **Buy**
- 1 → **Speculative**
- 0 → **No Trade**

**Calibration upgrade** (`:359-389`): if best matching strategy via `STYLE_TO_STRATEGY` (`strategyCalibrator.js:31-37`) has `winRate≥60 && profitFactor≥1.4` → **Buy → Strong Buy**.

`needsClaudeReview = consensus ∈ {Buy, Strong Buy}` (`:393`).

---

## 3. autoTrader.js — Orders & Exits

### Default config (`:29-45`)
```
enabled: true            maxBudget: $1000        strongBuyAmount: $200
buyAmount: $100          maxPerStock: $200       defaultStopPct: 5
takeProfitPct: 10        trailingStopPct: 3      minGemScore: 45
minConviction: 3         onlyStrongBuy: false    maxStockPrice: $400
```

### Pre-trade filters (`processSignals()` `:154-422`)
1. Auto-trading disabled / market closed / no Alpaca → skip
2. **PDT guard**: equity<25k & flagged or daytrades≥3 → block ALL entries
3. consensus ∈ {No Trade, Speculative} → skip
4. gemScore<45 → silent skip
5. avgConviction<3 → skip
6. price>$400 → skip
7. requireOrderFlow (default off) — needs insider/options/inst signal
8. **Signal blacklist**: signals with count≥10 && winRate<30 && avgRet<0 from `tradeStats` → block if majority blacklisted
9. Already holding → skip
10. Claude SKIP or `claude.confidence < 6` → skip

### Sizing priority (`:266-294`)
```
amount = claude.suggestedSizePct ? maxBudget × pct/100
       : kellyAmount             ? maxBudget × kellyPct        // 0.25× Kelly, clamped 2-15%, needs ≥20 closed trades
       : consensus==='Strong Buy' ? $200 : $100
```
**Regime scale** (`:280-294`): `× stock.positionMultiplier` from stockIntel. If regimeMult≤0.5 (PANIC/HIGH_FEAR) → require `claude.confidence≥8` else skip. Floor $50.

`maxBudget = max(account.equity, config.maxBudget)` so it scales with equity (`:188`).

### Order execution (`:329-373`)
**Marketable limit @ price × 1.005** when ≥1 share fits, else market notional. Then `submitStopLossAfterFill` at `price × (1 - finalStopPct/100)` — broker-side resting stop survives bot downtime.

### Dynamic profit target (`:117-127`)
```
gemScore≥85 → 22%        ≥75 → 17%        ≥65 → 13%        ≥55 → 10%        else → 8%
+4 if claude.confidence≥9, +2 if ≥8
```
`finalTarget = max(agentSuggested, scoreBased, takeProfitPct=10%)` overridden by `claude.targetPct` if present.

### Exit logic — "SELL ONLY IN PROFIT" (`runExitCheck` `:443-545`)
Polled every 2 minutes during 9:30-16:00 ET (`index.js:689`).

```
Phase 1 (P&L < 0):                          hold, wait for recovery   :504
Phase 2 (P&L ≥ targetPct):                  TAKE PROFIT, close        :510
Phase 3 (peak ≥ 10% & now < peak-3 & ≥ 5):  MOON TRAIL                :519
Phase 4 (peak ≥  7% & now < peak-2 & ≥ 5):  PROFIT LOCK               :528
```
Comment at `:474`: "every closed trade is a WIN. We hold losers until recovery." **The broker-side stop is the only loss protection** — most opinionated rule in the codebase.

---

## 4. premarketScanner.js — Gaps + Squeezes + Breakouts

### `scanPremarketMovers()` (`:213-344`)
- Universe ~200 syms + earnings + dynamic discovery
- `volumeRatio = preMarketVol / (avgDailyVol × 0.15)` — corrects for ~15% PM share
- Inclusion: `|gap|≥5 || (volRatio>3 && |gap|>2)` && price≥$1
- `impactScore = |gap| × max(volRatio, 0.1) × 100` — sort key
- Top 30

`classifySignals()`: gap_up_explosive (gap>8 && vol>3×), gap_up_momentum (>3 && >2×), gap_down_bounce (<-5 + positive earnings hist), volume_spike (>5×), low_float_runner (<50M && gap>2).

### `getShortSqueezeSetups()` (`:470-582`)
Filter: `SI>15% || DTC>5`.
- **MOASS**: SI≥50 && DTC≥8 → 100/250/500% targets, 15% prob
- **short_squeeze**: SI≥30 && DTC≥5 → 50/100/200%, 30% prob
- **gamma_squeeze**: SI≥15 && (avgVol/float)>0.03 → 25/50/100%, 25% prob
- **squeeze_watch**: SI≥15 || DTC≥5 → 15/30/60%, 15% prob

Float amplifier: `<10M ×1.5 +5prob`, `<30M ×1.2`. DTC≥10 → ×1.3 +5prob.

### `getBreakoutSetups()` (`:620-745`)
**Coiled spring** = BB squeeze + (vol contracting OR price contracting).
- BB squeeze: width within 5% of 20-bar minimum
- vol contracting: last5Vol < last20Vol × 0.7
- price contracting: recent5Range/full20Range < 0.4
- `squeezeStrength = 1/BBwidth × 1/volRatio × 1/rangeRatio`

**WHEN**: cron `*/3 * * * *` PM only (4-9:30 ET) + `*/5` intraday (`index.js:706, 745`).

---

## 5. pennyScanner.js — Sub-$5 variant

Same 11 signals as gem finder but **lower gates**:
- price ∈ [0.10, $5]
- volume ≥ 50k (vs 100k)
- signals≥1 && setupScore≥10 (vs 2 / 20)

**Penny-only signals**:
- `penny_breakout`: chg>5 && volRatio≥2 (+18)
- `micro_float`: float<10M (+15)
- `penny_squeeze`: SI>20% && price<5 (+14)
- `penny_volume_spike`: volRatio≥5 (+14)
- `dilution_risk`: sharesOut>float×3 (**-8**, negative)

Cron: same `*/5` block as gem scan.

---

## 6. signalLearner.js — Adaptive Weight Loop

**Triggered**: cron `0 17 * * 1-5` and `0 10 * * 1-5` (`index.js:644, 678`) after gem outcomes resolve.

Reads `gemHistory.json` outcomes (`['1d'|'3d'|'5d']`). Per signal accumulates: `count, wins, hits10, returns, totalMaxGain`.

**Constants** (`:29-30`):
- `MIN_SAMPLES = 5` per signal
- `MIN_TOTAL_SAMPLES = 20` overall

**Learned weight** (`:140-146`):
```
confidence    = min(1, count/20)
rawWeight     = (hit10Rate × 30) + (winRate × 10) + (max(0, avgMaxGain) × 0.5)
learnedWeight = round(rawWeight × confidence × 100) / 100
```

**Loser penalty** (`:150-161`): if `winRate<30% && avgRet<-3` → `learnedWeight += round(avgRet)` (effectively zeros it).

**Combo learning**: every alphabetically-sorted pair tracked. Pairs with `hit10Rate≥40% && count≥3` saved as `killerCombos` (top 20).

**Production blend**: `getLearnedWeight(sig, dflt) = round(learned×0.7 + dflt×0.3)` (`:241`) — 70/30 favoring learned.

---

## 7. signalTracker.js — Multi-day Persistence

Three urgency stages (`calcStage` `:193-223`):
- **IMMINENT**: days≥3 && score≥60 && trajectory∈{rising,flat} OR days≥2 && score≥75 && loadingCount≥3 OR days≥2 && breakoutCount≥2 && loadingCount≥2
- **LOADING**: days≥2 && (rising || score≥55) OR days≥2 && loadingCount≥2
- **BUILDING**: default day 1
- **COOLING**: existed but not today, days≥3

**Loading-class signals**: multi_day_accumulation, stealth_accumulation, volume_acceleration, smart_money, insider_buying, institutions_accumulating, bullish_options, unusual_options_volume, bb_squeeze, price_compression, volume_contraction, short_squeeze_loading.

**Breakout-class**: early_momentum, early_breakout, momentum_acceleration, gap_up_*, unusual_volume, low_float_volume, near_52w_high, bull_flag.

Decay: removed after 7 days (`:177`).

---

## 8. strategyCalibrator.js — Backtest-driven Conviction

**Strategies**: `gem_finder, volume_surge, momentum, mean_reversion` (`:28`).

For each (strategy, symbol ∈ `[SPY, AAPL, AMD]` `:26`) runs `runHistoricalBacktest({years:3, holdDays:5, strategy})`. Averages winRate/cagr/profitFactor/maxDrawdown.

**WHEN**: 30s after startup if cache stale, weekly Sunday 2 AM ET (`index.js:826, 835`). Cache TTL 7 days.

**Consumers**:
- `tradingDesk.analyzeGem` — promotes Buy→Strong Buy when WR≥60 & PF≥1.4
- `claudeBrain` — feeds calibration into prompt
- `telegram` — surfaced in alerts

---

## 9. claudeBrain.js — AI Validation

**Routing** (`:50-91`): **Gemini 2.0 Flash PRIMARY (free)**, Claude Haiku backup. After 400/credit-balance errors → `useGeminiFallback=true` permanently.

Models: `MODEL_ANALYSIS=claude-haiku-4-5-20251001`, `MODEL_BRIEFING=claude-sonnet-4-6`. Daily cap: 50 cents (`:20`). Cache 15 min/symbol.

### `analyzeStock(stock)` returns:
```js
{ action: 'BUY'|'SKIP', confidence: 1-10, thesis, riskLevel,
  suggestedSizePct: 3-20, targetPct, stopPct, timeframeDays, warnings: [] }
```

**Override hooks** (`index.js:551-565`):
- `action='SKIP'` → consensus='No Trade' (Claude can VETO any trade)
- `action='BUY' && confidence≥8 && consensus='Buy'` → upgraded to 'Strong Buy'

Auto-trader respects: `confidence<6 → skip`. Uses `suggestedSizePct, stopPct, targetPct` if present.

### Hourly market briefing (`5 8-16 * * 1-5` `index.js:841`)
Returns `{regime: RISK_ON|CAUTIOUS|RISK_OFF, hotSectors, coldSectors, advice, positionSizeMultiplier: 0.5-1.5}`.

---

## 10. Auxiliary signal sources

| File | Adds | Triggers |
|---|---|---|
| orderFlow.js | insider_buying, bullish_options, unusual_options_volume, institutions_accumulating | netBuying>0; P/C<0.7; vol>2× est OI; instChg>+5% |
| darkPool.js (FINRA daily) | dark_pool_squeeze (ratio≥0.60 && chg≥-2), dark_pool_pressure (≥0.50 && green) | `:142-160` |
| analystTracker.js (Finnhub) | analyst_upgrade, analyst_strong_buy (bullPct≥80, n≥5), analyst_momentum (3mo rising) | `:78-93` |
| congressTracker.js (Finnhub) | congress_buy, senate_buy, congress_cluster (≥3 distinct) | `:121-125` |
| insiderIntel.js (Finnhub Form 4 'P') | insider_cluster (≥3 in 30d), insider_heavy_buy (≥$100K), insider_buy_recent (14d) | `:101-104` |
| optionsScanner.js (Yahoo chain) | call_sweep_large (≥1000), put_call_extreme_bullish (<0.3, vol≥1000), options_volume_explosion (V/OI≥1.5, vol≥2000), deep_itm_calls (vol≥500 strike<0.9× spot), near_expiry_call_rush (vol≥2000) | `:96-135` |

All bolted on in `index.js:299-527` after gem/penny scan, before Claude. Deduped at `:532-536`.

---

## 11. Cron schedule (index.js)

| Schedule | Action | Line |
|---|---|---|
| `*/15 * * * * *` | SSE price stream | 203 |
| `*/5 * * * *` 8-18 ET M-F | Full gem+penny scan, enrichment, Claude, alerts, auto-buy | 239 |
| `*/3 * * * *` 4-9:30 ET | Pre-market mover scan + alerts | 706 |
| `*/5 * * * *` 9:30-16 ET | Intraday mover/squeeze refresh | 745 |
| `*/2 * * * *` 9:30-16 ET | `checkExitSignals()` | 689 |
| `0 10 * * 1-5` | Resolve 1-day gem outcomes | 678 |
| `0 17 * * 1-5` | Resolve all predictions, run `learnFromOutcomes` | 644 |
| `0 2 * * 0` | Weekly strategy calibration | 835 |
| `5 8-16 * * 1-5` | Hourly market briefing | 841 |

---

## 12. Telegram alert triggers

| Function | Fires when | File:Line |
|---|---|---|
| notifyBuyAlerts | gemScore≥55, buyCount≥2, not on cooldown | telegram.js:742 |
| notifyEarlyWarnings | After every gem scan (cooldowns 12h/6h/2h by stage) | telegram.js:868 |
| notifyMoverAlerts | PM `*/3` and intraday `*/5` cron | telegram.js:909 |
| notifyNewTrade | Order fills | telegram.js:679 |
| notifyTradeExit | Position closes | telegram.js:689 |
| notifyTradeRejected | High-score (≥60) trade filtered | telegram.js:842 |

---

## 13. End-to-end happy path

1. `*/5` cron fires 8-18 ET (`index.js:239`)
2. `findTomorrowMovers()` + `scanPennyStocks(5)` parallel → gemScore per candidate
3. Each → `analyzeGem()` → 5 agent verdicts → consensus
4. Calibration: WR≥60 && PF≥1.4 → Buy → Strong Buy
5. Enrichment overlays merge signals (options, congress, dark pool, insider, analyst, social, VIX regime → positionMultiplier)
6. Claude/Gemini gate: SKIP overrides to No Trade; BUY+conf≥8 upgrades Buy → Strong Buy
7. signalTracker stages → BUILDING/LOADING/IMMINENT
8. Telegram alerts fire
9. autoTrader filters again (gemScore≥45, conviction≥3, no PDT, no held, conf≥6, regime ok, Kelly sizing, blacklist) → marketable limit @ ×1.005 + broker stop
10. `*/2` polls positions: never sells red; +target%, peak-3%/peak-2% trails (≥+5% floor)
11. Daily 17:00: outcomes resolved, weights re-learned, blended 70/30 next scan

---

## 14. Position sizing summary

| Source | Logic | When wins |
|---|---|---|
| Claude `suggestedSizePct` | maxBudget × pct/100 | always if Claude responded |
| Kelly fractional | 0.25× kellyFraction, clamped 2-15% | needs ≥20 closed trades |
| Default | $200 (Strong Buy) / $100 (Buy) | else |
| Regime mult | × positionMultiplier (0.3-1.5 from stockIntel) | always applied |
| Floor | min $50 after regime | always |

---

## 15. Stop/Target summary

| Layer | Where | Behavior |
|---|---|---|
| Per-agent default stop | tradingDesk.js:29-72 | momentum 7%, squeeze 5%, accumulation 8%, catalyst 3%, contrarian 10% |
| Bot's avgStopPct | mean of buying agents | overridden by claude.stopPct |
| Broker-side stop | submitStopLossAfterFill | survives bot downtime |
| dynamicTargetPct | 8-22% by gemScore + Claude conf | autoTrader.js:117 |
| Final target | max(agent, score, 10%) or claude.targetPct | autoTrader.js:323 |
| Polling exit | runExitCheck | NEVER sells red; +target / peak-3 / peak-2 |

---

## 16. Design notes for v2/v3

1. **Two parallel scoring engines** (`scorer.js` 126pt vs `tomorrowMovers.calculateGemScore` 100pt). v2 should consolidate or explicitly route.
2. **"Sell only in profit"** is the most opinionated rule. Risks unbounded drawdowns; only mitigated by broker stop. v2: reconsider time-based or technical stops.
3. **Gemini-first AI** atypical given prompt is tuned for "aggressive trader" persona; outputs may differ from Claude.
4. **70/30 learned/default blend** at low sample counts can shift weights aggressively. v2: Bayesian shrinkage.
5. **Calibration uses only SPY/AAPL/AMD** — not representative of small/mid/penny universe traded. The 60% WR / 1.4 PF gate may be unrelated to live performance.
6. **Signal de-dup happens late** (`index.js:532`); insider_buying could be double-counted (stockIntel + insiderIntel) before dedup.
7. **Triple-threat** flag bumps `risk='high_conviction'` but doesn't materially change auto-trader behavior.
8. **PDT guard** matters for live (non-paper) deployment.

---

## 17. Key file map (absolute paths)

```
server/services/scorer.js              standalone earnings scoring
server/services/tomorrowMovers.js      gem finder (heart)
server/services/tradingDesk.js         5-agent voting
server/services/autoTrader.js          orders + exits
server/services/premarketScanner.js    gaps/squeezes/breakouts
server/services/pennyScanner.js        sub-$5 variant
server/services/signalLearner.js       adaptive weights
server/services/signalTracker.js       multi-day persistence
server/services/strategyCalibrator.js  backtest-driven conviction
server/services/earlyWarning.js        Telegram alert generator
server/services/claudeBrain.js         AI gate (Gemini→Claude)
server/services/orderFlow.js           insider/options/inst signals
server/services/darkPool.js            FINRA RegSHO
server/services/analystTracker.js      Finnhub analyst
server/services/congressTracker.js     Finnhub congress
server/services/insiderIntel.js        Finnhub Form 4
server/services/optionsScanner.js      Yahoo options chain
server/services/tradeStats.js          Kelly + signal stats
server/services/telegram.js            alerts
server/index.js                        cron orchestration
```
