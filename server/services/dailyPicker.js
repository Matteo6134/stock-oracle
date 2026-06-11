/**
 * Daily Picker — picks the single best stock for tomorrow's open-to-close trade.
 *
 * Pipeline:
 *   1. Pulls today's gem-scan results from sharedCache (already populated by tomorrowMovers cron)
 *   2. Filters for daytrade-suitable candidates (price, liquidity, no earnings tomorrow)
 *   3. Ranks by composite score: gemScore × claudeConfidence × explosion.probability
 *   4. Optionally submits MOO+MOC bracket via Alpaca (if AUTO_DAILY_PICK=true)
 *   5. Sends Telegram alert with tomorrow's pick
 *   6. Persists to data/dailyPicks.json for outcome tracking
 *
 * Run nightly at 16:05 ET. Validation against monkey baseline lives in python/monkey/.
 *
 * @typedef {Object} DailyPick
 * @property {string} pickDate           ISO date the pick is FOR (next trading day)
 * @property {string} symbol
 * @property {number} compositeScore     0-100
 * @property {number} gemScore
 * @property {number} claudeConfidence   1-10 (or null)
 * @property {number} explosionProb      0-100
 * @property {number} entryPrice         expected open
 * @property {number} expectedReturnPct
 * @property {string} reasoning
 * @property {string[]} signals
 * @property {string} createdAt          ISO timestamp
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getShared } from './sharedCache.js';
import * as alpaca from './alpaca.js';
import { getEarningsCalendar } from './yahooFinance.js';
import { saveDailyPick, updateDailyPickOrderIds } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PICKS_FILE = path.join(__dirname, '..', 'data', 'dailyPicks.json');

const MIN_PRICE = 1.0;
const MAX_PRICE = 400.0;
const MIN_AVG_VOLUME = 500_000;       // dollar volume gate ~ $5M at $10/share
const MIN_GEM_SCORE = 50;
const MIN_CLAUDE_CONFIDENCE = 5;       // null is allowed (Claude not run yet)
const TOP_N = 3;                       // emit top 3
const MIN_SCORE_THRESHOLD = 5;         // composite score floor to actually trade

/**
 * High-PF signals identified from 119 resolved predictions (signal_attribution.json).
 * Bonus is added to score when the signal is present on the candidate.
 * Source: python/backtest/signal_attribution.json — PF >= 1.5 and n >= 5.
 */
const SIGNAL_BONUSES = {
  volume_contraction: 30,         // PF 4.93, hit 69%
  call_sweep_large: 20,           // PF 4.19, hit 64%
  smart_money: 12,                // PF 1.69, hit 60%
  bb_squeeze: 12,                 // PF 1.63, hit 52%
  price_compression: 10,          // PF 1.34, hit 52%
  earnings_tomorrow: 8,           // PF 1.34, hit 44%
  social_surge: 6,                // PF 1.37, hit 40%
};

/**
 * Negative signals — present in losing predictions (PF < 0.7).
 * Source: same signal_attribution.json.
 */
const SIGNAL_PENALTIES = {
  options_volume_spike: -15,      // PF 0.40, avg -3.37%
  put_call_bullish: -15,          // PF 0.40, avg -3.51%
  short_squeeze_loading: -10,     // PF 0.55, avg -2.13%
  analyst_momentum: -8,           // PF 0.63
  put_call_extreme_bullish: -6,   // PF 0.72
};

/**
 * Day-trade ranking score — optimizes for "biggest expected 1-day % gain".
 *
 * Primary driver: expected value = expectedGainPct × probability / 100
 * Adjustments:
 *   - Day-trade bonus: prefer 1-day forecasts (matches buy-MOO-sell-MOC horizon)
 *   - Signal-quality bumps from real outcome data (signal_attribution.json)
 *   - Gem-bucket correction: 60-69 actually outperforms 80+ in attribution data
 *
 * @param {Object} stock
 * @returns {{ score: number, expectedValue: number, breakdown: Object }}
 */
function dayTradeScore(stock) {
  const expectedGain = stock.explosion?.expectedGainPct != null ? Number(stock.explosion.expectedGainPct) : 5;
  const explosionProb = stock.explosion?.probability != null ? Number(stock.explosion.probability) : 50;
  const daysToMove = stock.explosion?.daysToMove != null ? Number(stock.explosion.daysToMove) : 5;
  const gem = Number(stock.gemScore) || 0;
  const claudeConf = stock.claude?.confidence != null ? Number(stock.claude.confidence) : null;

  // Primary: expected value of the move (probability-weighted gain %)
  const expectedValue = expectedGain * (explosionProb / 100);

  // Day-trade bonus — penalize multi-day forecasts (we sell at close)
  const dayTradeBonus = daysToMove <= 1 ? 1.5
                      : daysToMove <= 2 ? 1.0
                      : daysToMove <= 3 ? 0.7
                      : 0.4;

  // Signal-quality bumps and penalties from outcome data
  const signals = (stock.signals || []).map(s => typeof s === 'string' ? s : s.name).filter(Boolean);
  let signalBonus = 0;
  for (const sig of signals) {
    if (SIGNAL_BONUSES[sig]) signalBonus += SIGNAL_BONUSES[sig];
    if (SIGNAL_PENALTIES[sig]) signalBonus += SIGNAL_PENALTIES[sig];
  }

  // Gem-bucket correction — from attribution data, 60-69 bucket outperforms 80+
  let gemAdjust;
  if (gem >= 60 && gem < 70) gemAdjust = 8;       // sweet spot
  else if (gem >= 70 && gem < 80) gemAdjust = 2;
  else if (gem >= 80) gemAdjust = -2;             // overconfident bucket
  else gemAdjust = -5;                             // <60, too speculative

  // Claude veto: if Claude says SKIP, kill the score
  const claudeVeto = stock.claude?.action === 'SKIP' ? -1000 : 0;

  // Claude confidence bonus (small, since signal weights matter more)
  const claudeBonus = claudeConf != null ? (claudeConf - 6) * 1.5 : 0;

  const score = expectedValue * dayTradeBonus + signalBonus + gemAdjust + claudeBonus + claudeVeto;

  return {
    score: Math.round(score * 100) / 100,
    expectedValue: Math.round(expectedValue * 100) / 100,
    breakdown: {
      expectedValue: Math.round(expectedValue * 100) / 100,
      dayTradeBonus,
      signalBonus,
      gemAdjust,
      claudeBonus,
    },
  };
}

// Backwards-compat shim — old name still callable
function compositeScore(stock) {
  return dayTradeScore(stock).score;
}

async function loadPickHistory() {
  try {
    const raw = await fs.readFile(PICKS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function appendPick(pick) {
  const history = await loadPickHistory();
  history.push(pick);
  await fs.writeFile(PICKS_FILE, JSON.stringify(history, null, 2), 'utf8');
}

/**
 * Returns the ISO date (YYYY-MM-DD, ET) of the next session OPEN a pick targets:
 *   - pre-open on a weekday (e.g. the 07:50 ET morning job)  -> TODAY's open
 *   - intraday / after close (e.g. the 16:05 ET evening job) -> next trading day's open
 * ET-aware so the morning and evening pickers label & settle their picks correctly.
 * Skips Sat/Sun; doesn't account for holidays — Alpaca rejects orders if the market is
 * closed and the bot picks again next valid run.
 * @returns {string} ISO date YYYY-MM-DD
 */
function targetSessionDateIso() {
  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const isWeekday = nowEt.getDay() >= 1 && nowEt.getDay() <= 5;
  const beforeOpen = (nowEt.getHours() * 60 + nowEt.getMinutes()) < (9 * 60 + 30); // < 9:30 ET
  if (isWeekday && beforeOpen) return fmt(nowEt);          // today's open
  const d = new Date(nowEt);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return fmt(d);                                            // next trading day's open
}

/**
 * Fetch upcoming earnings symbol set so we can exclude them (intraday gap risk).
 * @returns {Promise<Set<string>>}
 */
async function getEarningsSymbolsForTomorrow() {
  try {
    const cal = await getEarningsCalendar(1);
    const set = new Set();
    for (const e of cal || []) {
      if (e.symbol) set.add(String(e.symbol).toUpperCase());
    }
    return set;
  } catch {
    return new Set();
  }
}

/**
 * Filter the candidate universe down to viable daytrade picks.
 * @param {any[]} candidates
 * @param {Set<string>} earningsTomorrow
 * @returns {any[]}
 */
function filterCandidates(candidates, earningsTomorrow) {
  return candidates.filter(s => {
    if (!s || !s.symbol) return false;
    if (s.price < MIN_PRICE || s.price > MAX_PRICE) return false;
    if ((s.avgVolume || 0) < MIN_AVG_VOLUME) return false;
    if ((s.gemScore || 0) < MIN_GEM_SCORE) return false;
    const claudeConf = s.claude?.confidence;
    if (claudeConf != null && claudeConf < MIN_CLAUDE_CONFIDENCE) return false;
    if (s.claude?.action === 'SKIP') return false;
    if (earningsTomorrow.has(String(s.symbol).toUpperCase())) return false;
    return true;
  });
}

/**
 * Build the daily pick from current scan cache. Pure function over the inputs.
 * @param {any[]} candidates
 * @param {Set<string>} earningsTomorrow
 * @returns {{ ranked: any[], top: DailyPick | null }}
 */
export function rankPicks(candidates, earningsTomorrow) {
  const filtered = filterCandidates(candidates, earningsTomorrow);
  const scored = filtered.map(s => {
    const r = dayTradeScore(s);
    return { ...s, _composite: r.score, _expectedValue: r.expectedValue, _breakdown: r.breakdown };
  });
  scored.sort((a, b) => b._composite - a._composite);
  const ranked = scored.slice(0, TOP_N);

  if (ranked.length === 0) {
    return { ranked: [], top: null };
  }

  const best = ranked[0];
  const top = {
    pickDate: targetSessionDateIso(),
    symbol: best.symbol,
    compositeScore: Math.round(best._composite * 100) / 100,
    gemScore: best.gemScore || 0,
    claudeConfidence: best.claude?.confidence ?? null,
    explosionProb: best.explosion?.probability ?? null,
    entryPrice: best.price,
    expectedReturnPct: best.explosion?.expectedGainPct ?? null,
    reasoning: best.claude?.thesis || `Top of ${candidates.length} candidates by composite ranking`,
    signals: best.signals?.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean) || [],
    createdAt: new Date().toISOString(),
  };
  return { ranked, top };
}

/**
 * Submits a Market-on-Open buy + Market-on-Close sell pair via Alpaca.
 * Auto-trading must be enabled via env AUTO_DAILY_PICK=true.
 *
 * @param {DailyPick} pick
 * @param {number} dollarAmount
 * @returns {Promise<{ ok: boolean, error?: string, buyOrder?: any, sellOrder?: any }>}
 */
export async function submitDayTradeOrders(pick, dollarAmount) {
  if (!alpaca.isConfigured()) {
    return { ok: false, error: 'Alpaca not configured' };
  }
  if (!pick || !pick.symbol) {
    return { ok: false, error: 'No pick provided' };
  }
  const qty = Math.floor(dollarAmount / pick.entryPrice);
  if (qty < 1) {
    return { ok: false, error: `Dollar amount $${dollarAmount} buys <1 share at $${pick.entryPrice}` };
  }

  try {
    // Market on Open — fills at the opening auction price.
    // NO pre-submitted Market-on-Close sell anymore: (a) selling shares not
    // yet owned 403s on this account (treated as a short sale), and (b) a
    // blind MOC sell exits at a LOSS on red days — violating the absolute
    // never-sell-in-loss rule. Exits are handled by the auto-trader exit
    // checker (take-profit / trailing / breakeven-only time stop).
    const buyOrder = await alpaca.submitOrder({
      symbol: pick.symbol,
      qty,
      side: 'buy',
      type: 'market',
      timeInForce: 'opg',                  // opening cross
    });

    return { ok: true, buyOrder };
  } catch (err) {
    return { ok: false, error: err?.response?.data?.message || err?.message || 'submit failed' };
  }
}

/**
 * Allocate buying power across N qualifying picks, score-weighted with caps.
 * Returns array of {pick, dollarAmount} pairs ready for order submission.
 *
 * @param {any[]} ranked         picks sorted desc by score
 * @param {number} buyingPower   total $ available
 * @param {number} maxPctPerPick max fraction of buying power any single pick can use
 * @param {number} maxTotalPct   total fraction of buying power to deploy across all picks
 * @returns {Array<{ pick: any, dollarAmount: number }>}
 */
function allocateCapital(ranked, buyingPower, maxPctPerPick, maxTotalPct) {
  const qualified = ranked.filter(r => r._composite >= MIN_SCORE_THRESHOLD);
  if (qualified.length === 0) return [];

  // Score-weight allocation among qualified picks
  const totalScore = qualified.reduce((s, r) => s + Math.max(0, r._composite), 0);
  const totalBudget = buyingPower * maxTotalPct;
  const perPickCap = buyingPower * maxPctPerPick;

  return qualified.map(r => {
    const weight = totalScore > 0 ? Math.max(0, r._composite) / totalScore : 1 / qualified.length;
    const sized = Math.min(totalBudget * weight, perPickCap);
    return { pick: r, dollarAmount: Math.round(sized) };
  }).filter(a => a.dollarAmount >= 25);   // skip dust allocations
}

/**
 * Build a DailyPick record from a ranked candidate. Pure helper.
 * @param {any} ranked
 * @returns {DailyPick}
 */
function toDailyPick(ranked) {
  return {
    pickDate: targetSessionDateIso(),
    symbol: ranked.symbol,
    compositeScore: Math.round(ranked._composite * 100) / 100,
    gemScore: ranked.gemScore || 0,
    claudeConfidence: ranked.claude?.confidence ?? null,
    explosionProb: ranked.explosion?.probability ?? null,
    entryPrice: ranked.price,
    expectedReturnPct: ranked.explosion?.expectedGainPct ?? null,
    reasoning: ranked.claude?.thesis || `Picked from ${TOP_N} candidates by composite ranking`,
    signals: (ranked.signals || []).map(s => (typeof s === 'string' ? s : s?.name)).filter(Boolean),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Main entry — runs the full picker pipeline.
 * @param {{
 *   autoTrade?: boolean,
 *   buyingPower?: number,                 explicit override (else reads from Alpaca account)
 *   maxPositions?: number,                cap on number of MOO/MOC pairs (default 3)
 *   maxPctPerPick?: number,               max fraction of buying power per pick (default 0.30)
 *   maxTotalDeployPct?: number,           max fraction across all picks (default 0.90)
 *   telegramNotifier?: (msg: string) => Promise<void>
 * }} opts
 * @returns {Promise<{ picks: DailyPick[], ranked: any[], orderResults: any[] }>}
 */
export async function runDailyPicker(opts = {}) {
  const {
    autoTrade = false,
    maxPositions = Number(process.env.DAILY_PICK_MAX_POSITIONS) || 3,
    maxPctPerPick = Number(process.env.DAILY_PICK_MAX_PCT_PER_PICK) || 0.30,
    maxTotalDeployPct = Number(process.env.DAILY_PICK_MAX_TOTAL_PCT) || 0.90,
    telegramNotifier,
  } = opts;
  let { buyingPower } = opts;

  // sharedCache is keyed: cron writes setShared('gems', ...) and setShared('allAnalyzed', ...)
  const candidates = getShared('allAnalyzed') || getShared('gems') || [];
  if (!candidates.length) {
    console.warn('[DailyPicker] No candidates in shared cache — gem scan may not have run yet');
    return { picks: [], ranked: [], orderResults: [] };
  }

  // Resolve buying power from Alpaca if not provided. Cap at the auto-trade
  // budget — daytrading buying power (4x) must NOT size these orders: a $4k
  // account was getting $4.8k/pick allocations from the $16k intraday BP.
  let tradeCfg = null;
  try {
    const { getAutoTradeConfig } = await import('./autoTrader.js');
    tradeCfg = getAutoTradeConfig();
  } catch { /* fall back to raw buying power */ }
  if (autoTrade && buyingPower == null) {
    try {
      const acct = await alpaca.getAccount();
      buyingPower = acct?.cash || 0;
      if (tradeCfg?.maxBudget > 0) buyingPower = Math.min(buyingPower, tradeCfg.maxBudget);
    } catch (err) {
      console.error('[DailyPicker] could not fetch Alpaca account:', err.message);
      buyingPower = 0;
    }
  }
  buyingPower = Number(buyingPower) || 0;

  const earningsTomorrow = await getEarningsSymbolsForTomorrow();
  const { ranked } = rankPicks(candidates, earningsTomorrow);

  if (ranked.length === 0) {
    console.log(`[DailyPicker] No qualifying picks from ${candidates.length} candidates`);
    if (telegramNotifier) {
      await telegramNotifier(
        '📭 *Daily Picker*\nNo qualifying stocks for tomorrow\\.\n' +
        `Reviewed ${candidates.length} candidates; none passed filters\\.`
      );
    }
    return { picks: [], ranked: [], orderResults: [] };
  }

  // Cap to maxPositions and allocate — each pick also clamped to maxPerStock
  const limited = ranked.slice(0, maxPositions);
  let allocations = autoTrade
    ? allocateCapital(limited, buyingPower, maxPctPerPick, maxTotalDeployPct)
    : limited.map(p => ({ pick: p, dollarAmount: 0 }));
  if (autoTrade && tradeCfg?.maxPerStock > 0) {
    allocations = allocations.map(a => ({ ...a, dollarAmount: Math.min(a.dollarAmount, tradeCfg.maxPerStock) }));
  }

  // Persist all picks to local JSON history + Supabase mirror
  const picks = limited.map(toDailyPick);
  for (let i = 0; i < picks.length; i++) {
    await appendPick(picks[i]);
    await saveDailyPick(picks[i], i + 1);   // rank = position in ranked list
  }

  // Submit orders for each allocation
  const orderResults = [];
  if (autoTrade) {
    for (const alloc of allocations) {
      const dailyPick = toDailyPick(alloc.pick);
      const result = await submitDayTradeOrders(dailyPick, alloc.dollarAmount);
      orderResults.push({ symbol: dailyPick.symbol, dollarAmount: alloc.dollarAmount, ...result });
      if (result.ok) {
        console.log(`[DailyPicker] MOO/MOC submitted ${dailyPick.symbol} @ $${alloc.dollarAmount}`);
        // Attach order ids to the saved daily_picks row so settlement can match later
        await updateDailyPickOrderIds(dailyPick.pickDate, dailyPick.symbol, {
          buyOrderId: result.buyOrder?.id,
          sellOrderId: result.sellOrder?.id,
          dollarAllocated: alloc.dollarAmount,
        });
      } else {
        console.error(`[DailyPicker] order failed ${dailyPick.symbol}: ${result.error}`);
      }
    }
  }

  // Telegram alert with all picks
  if (telegramNotifier) {
    const totalDeployed = orderResults.filter(r => r.ok).reduce((s, r) => s + (r.dollarAmount || 0), 0);
    const successCount = orderResults.filter(r => r.ok).length;
    const _nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const _todayIso = `${_nowEt.getFullYear()}-${String(_nowEt.getMonth() + 1).padStart(2, '0')}-${String(_nowEt.getDate()).padStart(2, '0')}`;
    const _whenLabel = picks[0].pickDate === _todayIso ? "Today's Picks - buy at open" : "Tomorrow's Picks";
    const lines = [
      `🎯 *${escapeMd(_whenLabel)}*  \\(${escapeMd(picks[0].pickDate)}\\)`,
      ``,
      ...picks.slice(0, maxPositions).map((p, i) => {
        const alloc = allocations.find(a => a.pick.symbol === p.symbol);
        const result = orderResults.find(r => r.symbol === p.symbol);
        const dollar = alloc ? `$${alloc.dollarAmount}` : '—';
        const status = autoTrade
          ? (result?.ok ? `✅ ${escapeMd(dollar)}` : `⚠️ ${escapeMd(result?.error || 'fail')}`)
          : `_${escapeMd(dollar)}_`;
        return [
          `*${i + 1}\\. ${escapeMd(p.symbol)}*  @ ~$${escapeMd(p.entryPrice.toFixed(2))}  ${status}`,
          `   Score: ${escapeMd(String(p.compositeScore))} \\| Gem: ${escapeMd(String(p.gemScore))} \\| Exp: ${escapeMd(String(p.explosionProb ?? '—'))}%${p.expectedReturnPct != null ? ` \\| \\+${escapeMd(p.expectedReturnPct.toFixed(1))}%` : ''}`,
        ].join('\n');
      }),
      ``,
      `*Plan:* Buy at the open \\— exits managed by the bot \\(profit\\-only, never sold red\\)`,
      autoTrade
        ? `Deployed: $${escapeMd(totalDeployed.toLocaleString())} \\(${successCount}/${orderResults.length} orders\\) of $${escapeMd(Math.round(buyingPower).toLocaleString())} buying power`
        : `_Auto\\-trade off — manual execution_`,
    ];
    await telegramNotifier(lines.join('\n'));
  }

  return { picks, ranked, orderResults };
}

function escapeMd(s) {
  return String(s).replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, m => '\\' + m);
}
