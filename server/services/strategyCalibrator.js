/**
 * Strategy Calibrator
 *
 * Runs historical backtests on a basket of reference stocks to measure
 * how well each signal strategy performs historically.
 *
 * Results are stored and shared with:
 *  - tradingDesk.js → boost conviction when strategy is historically proven
 *  - autoTrader.js  → lower entry threshold for strong strategies
 *  - telegram.js    → tell user "67% historical win rate" in buy alerts
 *
 * Runs at server startup + every Sunday at 2 AM ET.
 * Re-uses cached results for 7 days to avoid hammering Yahoo Finance.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runHistoricalBacktest } from './historicalBacktest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALIBRATION_FILE = path.join(__dirname, '..', 'data', 'strategyCalibration.json');
const CALIBRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Reference symbols — well-known, liquid, long history (Yahoo Finance has them since 1990s)
const REFERENCE_SYMBOLS = ['SPY', 'AAPL', 'AMD'];

const STRATEGIES = ['gem_finder', 'volume_surge', 'momentum', 'mean_reversion'];

// Agent trading style → which backtest strategy best approximates it
export const STYLE_TO_STRATEGY = {
  momentum:     'momentum',
  squeeze:      'volume_surge',
  accumulation: 'volume_surge',
  catalyst:     'gem_finder',
  contrarian:   'mean_reversion',
};

let _cache = null;

/**
 * Returns the current calibration data (from cache or disk).
 * Returns null if calibration hasn't run yet or is stale.
 */
export function getCalibration() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CALIBRATION_FILE)) {
      const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
      const age = Date.now() - new Date(data.lastCalibrated || 0).getTime();
      if (age < CALIBRATION_TTL_MS) {
        _cache = data;
        return data;
      }
    }
  } catch { /* fall through — will recalibrate */ }
  return null;
}

/**
 * Run backtests on reference symbols for each strategy, average results,
 * store them. Called at startup and weekly.
 */
export async function runCalibration() {
  console.log('[Calibrator] Starting strategy calibration...');
  const results = {};

  for (const strategy of STRATEGIES) {
    const perSymbol = [];

    for (const symbol of REFERENCE_SYMBOLS) {
      try {
        const bt = await runHistoricalBacktest({ symbol, years: 3, holdDays: 5, strategy });
        if (bt.stats.totalTrades >= 5) {
          perSymbol.push({
            symbol,
            winRate: bt.stats.winRate,
            cagr: bt.stats.cagr,
            profitFactor: bt.stats.profitFactor,
            totalTrades: bt.stats.totalTrades,
            maxDrawdown: bt.stats.maxDrawdown,
          });
        }
      } catch (err) {
        console.warn(`[Calibrator] ${strategy}/${symbol}: ${err.message}`);
      }
    }

    if (perSymbol.length > 0) {
      const n = perSymbol.length;
      results[strategy] = {
        winRate:      Math.round(perSymbol.reduce((s, r) => s + r.winRate, 0) / n),
        cagr:         Math.round(perSymbol.reduce((s, r) => s + r.cagr, 0) / n * 10) / 10,
        profitFactor: Math.round(perSymbol.reduce((s, r) => s + r.profitFactor, 0) / n * 100) / 100,
        maxDrawdown:  Math.round(perSymbol.reduce((s, r) => s + r.maxDrawdown, 0) / n * 10) / 10,
        totalTrades:  perSymbol.reduce((s, r) => s + r.totalTrades, 0),
        symbols:      perSymbol.map(r => r.symbol),
      };
    }
  }

  if (Object.keys(results).length === 0) {
    console.warn('[Calibrator] No results — calibration failed');
    return null;
  }

  const calibration = { ...results, lastCalibrated: new Date().toISOString() };

  const dir = path.dirname(CALIBRATION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(calibration, null, 2), 'utf8');
  _cache = calibration;

  const summary = Object.entries(results)
    .map(([s, d]) => `${s}=${d.winRate}%WR/${d.profitFactor}PF`)
    .join(' | ');
  console.log(`[Calibrator] Done → ${summary}`);
  return calibration;
}
