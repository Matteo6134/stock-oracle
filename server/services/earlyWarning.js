/**
 * Early Warning Pipeline
 *
 * Combines signal tracking + Revolut filter to produce a clean list
 * of high-conviction early warnings for stocks about to move 10%+.
 *
 * Pipeline:
 * 1. Get tracked stocks from signalTracker
 * 2. Filter to Revolut-available only
 * 3. Score each for "days before explosion" confidence
 * 4. Generate progressive alerts
 *
 * Alert Levels:
 *   BUILDING  — "SOFI showing accumulation pattern (Day 1)"
 *   LOADING   — "SOFI signals strengthening, 3 agents BUY (Day 3)"
 *   IMMINENT  — "SOFI all signals aligned, expect 15%+ in 1-3 days"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTrackedStocks, getHotStocks } from './signalTracker.js';
import { isRevolutAvailable, filterRevolutStocks } from './revolut.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALERT_HISTORY_FILE = path.join(__dirname, '..', 'data', 'earlyWarningAlertHistory.json');

// ── Alert history (persisted to disk to survive restarts) ──
const alertHistory = loadAlertHistory();
const STAGE_COOLDOWN = {
  BUILDING: 12 * 60 * 60 * 1000,  // 12h between BUILDING alerts
  LOADING: 6 * 60 * 60 * 1000,    // 6h between LOADING alerts
  IMMINENT: 2 * 60 * 60 * 1000,   // 2h between IMMINENT alerts
};

function loadAlertHistory() {
  try {
    if (!fs.existsSync(ALERT_HISTORY_FILE)) return new Map();
    const raw = JSON.parse(fs.readFileSync(ALERT_HISTORY_FILE, 'utf8'));
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}

function saveAlertHistory() {
  try {
    const dir = path.dirname(ALERT_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(alertHistory);
    fs.writeFileSync(ALERT_HISTORY_FILE, JSON.stringify(obj), 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Get all early warnings filtered to Revolut stocks.
 * @param {Object} options
 * @param {boolean} options.revolutOnly - Filter to Revolut stocks (default: true)
 * @param {number} options.minScore - Minimum gem score (default: 40)
 * @param {string[]} options.stages - Which stages to include (default: all)
 * @returns {Array} Early warning list
 */
export function getEarlyWarnings({ revolutOnly = true, minScore = 40, stages = null } = {}) {
  const tracked = getTrackedStocks();

  return tracked
    .filter(stock => {
      // Revolut filter
      if (revolutOnly && !isRevolutAvailable(stock.symbol)) return false;
      // Minimum score
      if (stock.currentScore < minScore) return false;
      // Stage filter
      if (stages && !stages.includes(stock.stage)) return false;
      // Must have at least some loading signals
      if (stock.loadingSignalCount === 0 && stock.breakoutSignalCount === 0) return false;
      return true;
    })
    .map(stock => ({
      ...stock,
      revolutAvailable: true,
      alertMessage: buildAlertMessage(stock),
      estimatedMove: estimateMove(stock),
    }));
}

/**
 * Get stocks that need a Telegram alert (new stage or first appearance).
 * Returns only stocks that haven't been alerted at their current stage recently.
 */
export function getNewAlerts({ revolutOnly = true } = {}) {
  const warnings = getEarlyWarnings({ revolutOnly, minScore: 45 });
  const now = Date.now();
  const newAlerts = [];

  for (const stock of warnings) {
    const prevAlert = alertHistory.get(stock.symbol);
    const cooldown = STAGE_COOLDOWN[stock.stage] || 12 * 60 * 60 * 1000;

    // Alert if: no previous alert, or stage upgraded, or cooldown expired for IMMINENT
    const shouldAlert =
      !prevAlert ||
      stageRank(stock.stage) < stageRank(prevAlert.stage) || // Stage upgrade
      (stock.stage === 'IMMINENT' && now - prevAlert.ts > cooldown);

    if (shouldAlert) {
      newAlerts.push(stock);
      alertHistory.set(stock.symbol, { stage: stock.stage, ts: now });
    }
  }

  // Clean old entries (>7 days)
  for (const [sym, data] of alertHistory) {
    if (now - data.ts > 7 * 24 * 60 * 60 * 1000) alertHistory.delete(sym);
  }

  // Persist to disk so restarts don't spam
  if (newAlerts.length > 0) saveAlertHistory();

  return newAlerts;
}

/**
 * Build a human-readable alert message for Telegram.
 */
function buildAlertMessage(stock) {
  const stageIcons = {
    BUILDING: '\uD83D\uDFE1', // yellow circle
    LOADING: '\uD83D\uDFE0',  // orange circle
    IMMINENT: '\uD83D\uDD34',  // red circle
    COOLING: '\u26AA',         // white circle
  };

  const icon = stageIcons[stock.stage] || '\u26AA';
  const days = stock.consecutiveDays;
  const move = estimateMove(stock);
  const trajectory = stock.scoreTrajectory === 'rising' ? '\u2B06\uFE0F' :
    stock.scoreTrajectory === 'falling' ? '\u2B07\uFE0F' : '\u27A1\uFE0F';

  const signalSummary = summarizeSignals(stock.currentSignals);

  const price = stock.currentPrice || 0;
  const targetPrice = price > 0 ? Math.round(price * (1 + move.expectedGain / 100) * 100) / 100 : 0;
  const stopPrice = price > 0 ? Math.round(price * 0.93 * 100) / 100 : 0; // 7% stop

  const lines = [
    `${icon} *${stock.stage}* — ${stock.symbol}`,
    `\uD83D\uDCB0 $${price} | Score ${stock.currentScore} ${trajectory} | Day ${days}`,
  ];

  if (move.expectedGain >= 10 && price > 0) {
    lines.push('');
    lines.push(`\uD83D\uDFE2 Entry: *$${price}*`);
    lines.push(`\uD83C\uDFAF Target: *$${targetPrice}* (+${move.expectedGain}% in ${move.daysToMove}d)`);
    lines.push(`\uD83D\uDED1 Stop: *$${stopPrice}* (-7%)`);
  }

  if (stock.consensus && stock.consensus !== 'No Trade') {
    lines.push(`\uD83E\uDD16 Agents: ${stock.consensus}`);
  }

  if (signalSummary) {
    lines.push(`\uD83D\uDD0D ${signalSummary}`);
  }

  if (stock.stage === 'IMMINENT') {
    lines.push(`\u26A1 *ACT NOW — move expected within ${move.daysToMove} day${move.daysToMove > 1 ? 's' : ''}*`);
  } else if (stock.stage === 'LOADING') {
    lines.push(`\u23F0 Watch closely — loading for ${days} day${days > 1 ? 's' : ''}`);
  } else {
    lines.push(`\uD83D\uDD04 Pattern forming — monitoring...`);
  }

  return lines.join('\n');
}

/**
 * Estimate expected move based on tracked data.
 */
function estimateMove(stock) {
  let expectedGain = 10; // base
  let daysToMove = 5;
  let probability = 25;

  // Consecutive days boost — the longer the accumulation, the bigger the move
  if (stock.consecutiveDays >= 4) {
    expectedGain += 15; probability += 20; daysToMove = 1;
  } else if (stock.consecutiveDays >= 3) {
    expectedGain += 10; probability += 15; daysToMove = 2;
  } else if (stock.consecutiveDays >= 2) {
    expectedGain += 5; probability += 10; daysToMove = 3;
  }

  // Score level
  if (stock.currentScore >= 80) {
    expectedGain += 10; probability += 10;
  } else if (stock.currentScore >= 60) {
    expectedGain += 5; probability += 5;
  }

  // Rising trajectory = higher conviction
  if (stock.scoreTrajectory === 'rising') {
    probability += 10;
    daysToMove = Math.max(1, daysToMove - 1);
  }

  // Loading signals = accumulation pattern
  if (stock.loadingSignalCount >= 3) {
    expectedGain += 10; probability += 10;
  } else if (stock.loadingSignalCount >= 2) {
    expectedGain += 5; probability += 5;
  }

  // Use scanner's explosion prediction if available
  if (stock.explosion?.expectedGainPct > expectedGain) {
    expectedGain = stock.explosion.expectedGainPct;
    if (stock.explosion.daysToMove) daysToMove = stock.explosion.daysToMove;
    if (stock.explosion.probability > probability) probability = stock.explosion.probability;
  }

  // NOTE: `confidence` is a heuristic score (0-85), NOT a validated probability.
  // It combines hand-tuned weights over accumulation signals. Do not present
  // as a probability until back-tested on resolved outcomes.
  const confidence = Math.min(85, Math.round(probability));
  return {
    expectedGain: Math.min(200, Math.round(expectedGain)),
    daysToMove: Math.max(1, Math.min(7, daysToMove)),
    confidence,
    probability: confidence, // deprecated alias — keep for backward compat with UI
  };
}

/**
 * Summarize signals into readable text.
 */
function summarizeSignals(signals) {
  if (!signals?.length) return '';

  const labels = {
    multi_day_accumulation: 'Accumulation',
    stealth_accumulation: 'Stealth loading',
    volume_acceleration: 'Vol ramping',
    smart_money: 'Smart money',
    insider_buying: 'Insider buying',
    institutions_accumulating: 'Institutions loading',
    bullish_options: 'Call flow',
    bb_squeeze: 'BB squeeze',
    price_compression: 'Coiled spring',
    short_squeeze_loading: 'Squeeze building',
    early_momentum: 'Early momentum',
    momentum_acceleration: 'Accelerating',
    unusual_volume: 'Volume spike',
    volume_contraction: 'Vol dry-up',
    near_52w_high: '52w high',
    low_float_volume: 'Low float',
    earnings_tomorrow: 'Earnings',
  };

  return signals.slice(0, 4).map(s => labels[s] || s).join(' \u00B7 ');
}

function stageRank(stage) {
  const ranks = { IMMINENT: 0, LOADING: 1, BUILDING: 2, COOLING: 3 };
  return ranks[stage] ?? 4;
}
