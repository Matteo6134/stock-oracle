/**
 * Trade Statistics — derives win rate, expectancy, Kelly, and exit mix
 * from the closed entries in agentTrades.json.
 *
 * These stats feed position sizing (Kelly) and are surfaced via /api/stats
 * so you can see if the strategy is actually profitable BEFORE scaling capital.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, '..', 'data', 'agentTrades.json');

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function returnPct(entry) {
  if (entry.exitPrice == null || entry.price == null || entry.price <= 0) return null;
  return ((entry.exitPrice - entry.price) / entry.price) * 100;
}

/**
 * Core stats for all resolved (closed) trades.
 */
export function computeStats() {
  const trades = loadTrades();
  const closed = trades.filter(t => t.exitPrice != null && t.price != null && t.price > 0);

  if (closed.length === 0) {
    return {
      totalClosed: 0,
      profitable: false,
      message: 'No resolved trades yet',
    };
  }

  const returns = closed.map(returnPct).filter(r => r != null);
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r <= 0);

  const winRate = wins.length / returns.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length) : 0;
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Expectancy per trade (% of notional)
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  // Kelly fraction (0 when avgWin=0 to avoid div by zero)
  const kelly = avgWin > 0
    ? (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin
    : 0;

  // Exit reason mix
  const exitMix = {};
  for (const t of closed) {
    const reason = inferExitCategory(t.exitReason);
    exitMix[reason] = (exitMix[reason] || 0) + 1;
  }

  // Total P&L in dollars
  const totalPL = closed.reduce((s, t) => s + (t.pnl || 0), 0);

  return {
    totalClosed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate * 100, 1),
    avgWinPct: round(avgWin, 2),
    avgLossPct: round(avgLoss, 2),
    avgReturnPct: round(avgReturn, 2),
    expectancyPct: round(expectancy, 2),
    kellyFraction: round(Math.max(0, Math.min(1, kelly)), 3),
    totalPL: round(totalPL, 2),
    exitMix,
    profitable: expectancy > 0,
  };
}

/**
 * Kelly-fractional sizing clamped to safe bounds.
 * Uses 0.25 × full Kelly as a safety buffer.
 * Returns null if insufficient data — caller should fall back to defaults.
 */
export function kellySizingPct({ minSamples = 20, fraction = 0.25, floor = 0.02, cap = 0.15 } = {}) {
  const stats = computeStats();
  if (stats.totalClosed < minSamples) return null;
  if (stats.kellyFraction <= 0) return null;
  const sized = stats.kellyFraction * fraction;
  return Math.max(floor, Math.min(cap, sized));
}

/**
 * Per-signal win rate and avg return.
 * Used to flag signals with negative expectancy.
 */
export function signalPerformance() {
  const trades = loadTrades();
  const closed = trades.filter(t => t.exitPrice != null && t.price != null && t.price > 0);
  const perSignal = {};

  for (const t of closed) {
    const ret = returnPct(t);
    if (ret == null) continue;
    for (const sig of t.signals || []) {
      if (!perSignal[sig]) perSignal[sig] = { count: 0, wins: 0, totalReturn: 0 };
      perSignal[sig].count += 1;
      if (ret > 0) perSignal[sig].wins += 1;
      perSignal[sig].totalReturn += ret;
    }
  }

  return Object.entries(perSignal)
    .filter(([, s]) => s.count >= 3) // need min sample
    .map(([sig, s]) => ({
      signal: sig,
      count: s.count,
      winRate: round((s.wins / s.count) * 100, 1),
      avgReturn: round(s.totalReturn / s.count, 2),
    }))
    .sort((a, b) => b.avgReturn - a.avgReturn);
}

function inferExitCategory(reason) {
  if (!reason) return 'unknown';
  const r = reason.toLowerCase();
  if (r.includes('take profit')) return 'take_profit';
  if (r.includes('moon')) return 'moon_trail';
  if (r.includes('profit lock') || r.includes('locked')) return 'profit_lock';
  if (r.includes('break-even') || r.includes('break even')) return 'break_even';
  if (r.includes('stop loss')) return 'stop_loss';
  return 'other';
}

function round(n, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}
