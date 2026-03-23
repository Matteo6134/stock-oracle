/**
 * Claude Accuracy Tracker
 *
 * Logs every Claude prediction and compares against actual outcomes.
 * This data feeds back into Claude's system prompt so it can learn
 * from its mistakes and calibrate confidence levels.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'claudeHistory.json');
const MAX_HISTORY = 200; // keep last 200 predictions

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch { /* corrupted file — start fresh */ }
  return [];
}

function saveHistory(history) {
  ensureDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY), null, 2), 'utf8');
}

/**
 * Log a Claude prediction (called when Claude analyzes a stock).
 */
export function logPrediction(symbol, claudeVerdict, stockData) {
  const history = loadHistory();

  history.push({
    id: `${symbol}-${Date.now()}`,
    symbol,
    timestamp: new Date().toISOString(),
    action: claudeVerdict.action,
    confidence: claudeVerdict.confidence,
    thesis: claudeVerdict.thesis,
    riskLevel: claudeVerdict.riskLevel,
    targetPct: claudeVerdict.targetPct,
    stopPct: claudeVerdict.stopPct,
    timeframeDays: claudeVerdict.timeframeDays,
    entryPrice: stockData.price,
    gemScore: stockData.gemScore,
    consensus: stockData.consensus,
    // Outcome fields — filled later when trade closes
    outcome: null,       // 'win' | 'loss' | 'skipped'
    exitPrice: null,
    actualPct: null,
    settledAt: null,
  });

  saveHistory(history);
}

/**
 * Record outcome of a Claude prediction (called when trade closes).
 */
export function recordOutcome(symbol, exitPrice, actualPct, exitReason) {
  const history = loadHistory();
  // Find the most recent open prediction for this symbol
  const idx = history.findLastIndex(h => h.symbol === symbol && h.outcome === null);
  if (idx === -1) return;

  history[idx].outcome = actualPct > 0 ? 'win' : 'loss';
  history[idx].exitPrice = exitPrice;
  history[idx].actualPct = Math.round(actualPct * 100) / 100;
  history[idx].settledAt = new Date().toISOString();
  history[idx].exitReason = exitReason;

  saveHistory(history);
}

/**
 * Get Claude's accuracy stats (fed back into prompts + /brain command).
 */
export function getClaudeAccuracy() {
  const history = loadHistory();
  const settled = history.filter(h => h.outcome && h.action === 'BUY');
  const skipped = history.filter(h => h.action === 'SKIP');

  if (settled.length === 0) {
    return {
      totalCalls: history.length,
      totalSettled: 0,
      winRate: 0,
      avgConfWin: 0,
      avgConfLoss: 0,
      avgReturn: 0,
      bestCall: null,
      worstCall: null,
      recentCalls: history.slice(-5),
    };
  }

  const wins = settled.filter(h => h.outcome === 'win');
  const losses = settled.filter(h => h.outcome === 'loss');

  const avgConfWin = wins.length > 0
    ? Math.round(wins.reduce((s, h) => s + h.confidence, 0) / wins.length * 10) / 10
    : 0;
  const avgConfLoss = losses.length > 0
    ? Math.round(losses.reduce((s, h) => s + h.confidence, 0) / losses.length * 10) / 10
    : 0;
  const avgReturn = Math.round(settled.reduce((s, h) => s + (h.actualPct || 0), 0) / settled.length * 100) / 100;

  const bestCall = settled.reduce((best, h) => (!best || (h.actualPct || 0) > (best.actualPct || 0)) ? h : best, null);
  const worstCall = settled.reduce((worst, h) => (!worst || (h.actualPct || 0) < (worst.actualPct || 0)) ? h : worst, null);

  // High-confidence accuracy (confidence >= 7)
  const highConf = settled.filter(h => h.confidence >= 7);
  const highConfWins = highConf.filter(h => h.outcome === 'win');

  return {
    totalCalls: history.length,
    totalSettled: settled.length,
    totalSkipped: skipped.length,
    winRate: Math.round((wins.length / settled.length) * 100),
    avgConfWin,
    avgConfLoss,
    avgReturn,
    highConfWinRate: highConf.length > 0 ? Math.round((highConfWins.length / highConf.length) * 100) : 0,
    highConfCount: highConf.length,
    bestCall: bestCall ? { symbol: bestCall.symbol, pct: bestCall.actualPct, confidence: bestCall.confidence } : null,
    worstCall: worstCall ? { symbol: worstCall.symbol, pct: worstCall.actualPct, confidence: worstCall.confidence } : null,
    recentCalls: history.slice(-10).reverse(),
  };
}

/**
 * Get raw history for API endpoint.
 */
export function getClaudeHistory() {
  return loadHistory().reverse().slice(0, 50);
}
