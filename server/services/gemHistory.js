/**
 * Gem History — Tracks Gem Finder picks and their multi-day outcomes.
 * Stores daily snapshots with trading desk verdicts.
 * Resolves outcomes lazily when /api/gem-backtest is called.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as yahooFinance from './yahooFinance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEM_FILE = path.join(__dirname, '..', 'data', 'gemHistory.json');

const dataDir = path.dirname(GEM_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadHistory() {
  if (!fs.existsSync(GEM_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(GEM_FILE, 'utf8'));
  } catch { return {}; }
}

function saveHistory(data) {
  fs.writeFileSync(GEM_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Save daily gem snapshot ──
export async function saveGemSnapshot(gems) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const history = loadHistory();

    // Don't overwrite existing snapshot for today
    if (history[today]?.gems?.length > 0) return;

    history[today] = {
      gems: gems.map(g => ({
        symbol: g.symbol,
        companyName: g.companyName || '',
        entryPrice: g.price || 0,
        gemScore: g.gemScore || 0,
        signals: g.signals || [],
        signalCount: g.signalCount || 0,
        setupScore: g.setupScore || 0,
        timing: g.timing || '',
        risk: g.risk || '',
        volumeRatio: g.volumeRatio || 0,
        floatShares: g.floatShares || 0,
        changePct: g.changePct || 0,
        verdicts: g.verdicts || [],
        consensus: g.consensus || 'No Trade',
        outcomes: null, // filled later by resolveOutcomes
      })),
      stats: {
        totalGems: gems.length,
        avgGemScore: gems.length > 0 ? Math.round(gems.reduce((s, g) => s + (g.gemScore || 0), 0) / gems.length) : 0,
        generatedAt: new Date().toISOString(),
      },
    };

    saveHistory(history);
    console.log(`[GemHistory] Saved ${gems.length} gems for ${today}`);
  } catch (err) {
    console.error('[GemHistory] Save error:', err.message);
  }
}

// ── Resolve outcomes for past gems ──
const TIMEFRAMES = [1, 3, 5, 7]; // days

async function resolveOutcomes() {
  const history = loadHistory();
  const today = new Date().toISOString().split('T')[0];
  const dates = Object.keys(history).filter(d => d < today).sort();

  // Collect symbols that need resolution
  const needsResolution = [];
  for (const date of dates) {
    const dayData = history[date];
    if (!dayData.gems) continue;
    for (const gem of dayData.gems) {
      if (!gem.outcomes) {
        needsResolution.push({ date, symbol: gem.symbol });
      }
    }
  }

  if (needsResolution.length === 0) return history;

  // Deduplicate symbols
  const uniqueSymbols = [...new Set(needsResolution.map(n => n.symbol))];
  console.log(`[GemHistory] Resolving outcomes for ${uniqueSymbols.length} symbols...`);

  // Use global cache for historical data
  if (!global.gemHistCache) global.gemHistCache = new Map();
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  const histMap = {};
  const toFetch = uniqueSymbols.filter(sym => {
    const cached = global.gemHistCache.get(sym);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      histMap[sym] = cached.bars;
      return false;
    }
    return true;
  });

  // Fetch in batches of 10
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(sym => yahooFinance.getHistoricalData(sym).then(bars => ({ sym, bars })))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.bars?.length > 0) {
        histMap[r.value.sym] = r.value.bars;
        global.gemHistCache.set(r.value.sym, { bars: r.value.bars, ts: Date.now() });
      }
    }
  }

  // Resolve each gem's outcomes
  let updated = false;
  for (const date of dates) {
    const dayData = history[date];
    if (!dayData.gems) continue;

    for (const gem of dayData.gems) {
      if (gem.outcomes) continue; // already resolved

      const bars = histMap[gem.symbol];
      if (!bars || bars.length === 0) continue;

      const pickDate = new Date(date + 'T23:59:59Z');
      // Find bars AFTER the pick date
      const futureBars = bars.filter(b => new Date(b.date) > pickDate);
      if (futureBars.length === 0) continue;

      const outcomes = {};
      for (const tf of TIMEFRAMES) {
        if (futureBars.length < tf) {
          outcomes[`${tf}d`] = null;
          continue;
        }

        const window = futureBars.slice(0, tf);
        const closePrice = window[window.length - 1].close;
        const maxHigh = Math.max(...window.map(b => b.high || b.close));
        const minLow = Math.min(...window.map(b => b.low || b.close));

        const returnPct = gem.entryPrice > 0 ? ((closePrice - gem.entryPrice) / gem.entryPrice) * 100 : 0;
        const maxGain = gem.entryPrice > 0 ? ((maxHigh - gem.entryPrice) / gem.entryPrice) * 100 : 0;
        const maxDrawdown = gem.entryPrice > 0 ? ((minLow - gem.entryPrice) / gem.entryPrice) * 100 : 0;

        outcomes[`${tf}d`] = {
          close: Math.round(closePrice * 100) / 100,
          return: Math.round(returnPct * 100) / 100,
          maxGain: Math.round(maxGain * 100) / 100,
          maxDrawdown: Math.round(maxDrawdown * 100) / 100,
        };
      }

      gem.outcomes = outcomes;
      updated = true;
    }
  }

  if (updated) saveHistory(history);
  return history;
}

// ── Build backtest data with agent leaderboard ──
export async function getGemBacktestData() {
  const history = await resolveOutcomes();
  const dates = Object.keys(history).sort().reverse();

  // Build days array
  const days = dates.map(date => ({
    date,
    gems: history[date].gems || [],
    stats: history[date].stats || {},
  }));

  // Compute agent leaderboard
  const agentStats = {};
  const consensusStats = { 'Strong Buy': { wins: 0, total: 0, totalReturn: 0 }, 'Buy': { wins: 0, total: 0, totalReturn: 0 }, 'Speculative': { wins: 0, total: 0, totalReturn: 0 }, 'No Trade': { wins: 0, total: 0, totalReturn: 0 } };
  const signalPerf = {};

  for (const day of days) {
    for (const gem of day.gems) {
      if (!gem.outcomes) continue;

      // Use 5d return as primary metric (or 3d if 5d not available)
      const primaryReturn = gem.outcomes['5d']?.return ?? gem.outcomes['3d']?.return ?? gem.outcomes['1d']?.return;
      if (primaryReturn == null) continue;

      // Consensus stats
      const cLevel = gem.consensus || 'No Trade';
      if (consensusStats[cLevel]) {
        consensusStats[cLevel].total++;
        consensusStats[cLevel].totalReturn += primaryReturn;
        if (primaryReturn > 0) consensusStats[cLevel].wins++;
      }

      // Signal performance
      for (const sig of gem.signals || []) {
        if (!signalPerf[sig]) signalPerf[sig] = { count: 0, totalReturn: 0, wins: 0 };
        signalPerf[sig].count++;
        signalPerf[sig].totalReturn += primaryReturn;
        if (primaryReturn > 0) signalPerf[sig].wins++;
      }

      // Per-agent stats
      for (const v of gem.verdicts || []) {
        if (!agentStats[v.agent]) {
          agentStats[v.agent] = { agent: v.agent, style: v.style, emoji: v.emoji, totalPicks: 0, wins: 0, totalGain: 0, totalLoss: 0, returns: [] };
        }
        const stat = agentStats[v.agent];

        if (v.action === 'BUY') {
          stat.totalPicks++;
          stat.returns.push(primaryReturn);
          if (primaryReturn > 0) {
            stat.wins++;
            stat.totalGain += primaryReturn;
          } else {
            stat.totalLoss += Math.abs(primaryReturn);
          }
        }
      }
    }
  }

  // Finalize agent leaderboard
  const agentLeaderboard = Object.values(agentStats)
    .map(s => ({
      agent: s.agent,
      style: s.style,
      emoji: s.emoji,
      totalPicks: s.totalPicks,
      winRate: s.totalPicks > 0 ? Math.round((s.wins / s.totalPicks) * 100) : 0,
      avgGain: s.wins > 0 ? Math.round((s.totalGain / s.wins) * 100) / 100 : 0,
      avgLoss: (s.totalPicks - s.wins) > 0 ? Math.round((s.totalLoss / (s.totalPicks - s.wins)) * 100) / 100 : 0,
      profitFactor: s.totalLoss > 0 ? Math.round((s.totalGain / s.totalLoss) * 100) / 100 : s.totalGain > 0 ? 999 : 0,
      avgReturn: s.returns.length > 0 ? Math.round((s.returns.reduce((a, b) => a + b, 0) / s.returns.length) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.profitFactor - a.profitFactor);

  // Finalize consensus stats
  const consensusResult = {};
  for (const [level, s] of Object.entries(consensusStats)) {
    consensusResult[level] = {
      count: s.total,
      winRate: s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0,
      avgReturn: s.total > 0 ? Math.round((s.totalReturn / s.total) * 100) / 100 : 0,
    };
  }

  // Finalize signal performance
  const signalResult = {};
  for (const [sig, s] of Object.entries(signalPerf)) {
    signalResult[sig] = {
      count: s.count,
      winRate: s.count > 0 ? Math.round((s.wins / s.count) * 100) : 0,
      avgReturn: s.count > 0 ? Math.round((s.totalReturn / s.count) * 100) / 100 : 0,
    };
  }

  return {
    days,
    agentLeaderboard,
    consensusStats: consensusResult,
    signalPerformance: signalResult,
    totalDays: days.length,
    totalGems: days.reduce((s, d) => s + d.gems.length, 0),
  };
}
