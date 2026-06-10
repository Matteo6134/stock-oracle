/**
 * Self-Learning Signal Weight Engine
 *
 * Analyzes gem history outcomes to determine which signals actually
 * predict 10%+ moves. Auto-adjusts signal weights so the system
 * gets smarter over time.
 *
 * Process:
 * 1. Read all gem history with resolved outcomes
 * 2. For each signal, calculate: hit rate, avg return, 10%+ rate
 * 3. Compare to current weights in tomorrowMovers.js
 * 4. Generate learned weight adjustments
 * 5. Persist to signalWeights.json
 *
 * The gem scanner reads these learned weights and blends them
 * with the hardcoded defaults (70% learned, 30% default when
 * enough data exists).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS_FILE = path.join(__dirname, '..', 'data', 'signalWeights.json');
const GEM_FILE = path.join(__dirname, '..', 'data', 'gemHistory.json');

// Minimum samples needed before we trust learned weights
const MIN_SAMPLES = 10;
const MIN_TOTAL_SAMPLES = 20; // min total gems with outcomes before learning kicks in
const MIN_COMBO_SAMPLES = 10; // pairs need more data — 3-sample "killer combos" were pure noise

/**
 * Analyze all gem history and compute optimal signal weights.
 * Call this after outcome resolution.
 */
export function learnFromOutcomes() {
  const gemHistory = loadGemHistory();
  if (!gemHistory) return { totalSamples: 0, learned: false };

  const dates = Object.keys(gemHistory).sort();
  const signalStats = {};
  const comboStats = {};
  const consensusStats = {};
  let totalSamples = 0;

  for (const date of dates) {
    const gems = gemHistory[date]?.gems || [];
    for (const gem of gems) {
      if (!gem.outcomes) continue;

      // Use best available return (prefer 5d, then 3d, then 1d)
      const maxGain5d = gem.outcomes['5d']?.maxGain;
      const maxGain3d = gem.outcomes['3d']?.maxGain;
      const maxGain1d = gem.outcomes['1d']?.maxGain;
      const ret5d = gem.outcomes['5d']?.return;
      const ret3d = gem.outcomes['3d']?.return;
      const ret1d = gem.outcomes['1d']?.return;

      const maxGain = maxGain5d ?? maxGain3d ?? maxGain1d;
      const bestReturn = ret5d ?? ret3d ?? ret1d;
      if (maxGain == null && bestReturn == null) continue;

      totalSamples++;
      const hit10 = (maxGain ?? 0) >= 10;
      const profitable = (bestReturn ?? 0) > 0;

      // Per-signal stats
      const sigs = gem.signals || [];
      for (const sig of sigs) {
        if (!signalStats[sig]) {
          signalStats[sig] = {
            count: 0, wins: 0, hits10: 0,
            totalReturn: 0, totalMaxGain: 0,
            returns: [],
          };
        }
        const s = signalStats[sig];
        s.count++;
        if (profitable) s.wins++;
        if (hit10) s.hits10++;
        s.totalReturn += bestReturn ?? 0;
        s.totalMaxGain += maxGain ?? 0;
        s.returns.push(bestReturn ?? 0);
      }

      // ── Signal COMBO stats (pairs of signals that fire together) ──
      // Sort signals alphabetically so combo key is consistent (A+B = B+A)
      const sorted = [...sigs].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const comboKey = `${sorted[i]}+${sorted[j]}`;
          if (!comboStats[comboKey]) {
            comboStats[comboKey] = { count: 0, wins: 0, hits10: 0, totalReturn: 0 };
          }
          const c = comboStats[comboKey];
          c.count++;
          if (profitable) c.wins++;
          if (hit10) c.hits10++;
          c.totalReturn += bestReturn ?? 0;
        }
      }

      // Per-consensus stats
      const consensus = gem.consensus || 'None';
      if (!consensusStats[consensus]) {
        consensusStats[consensus] = { count: 0, wins: 0, hits10: 0, totalReturn: 0 };
      }
      const cs = consensusStats[consensus];
      cs.count++;
      if (profitable) cs.wins++;
      if (hit10) cs.hits10++;
      cs.totalReturn += bestReturn ?? 0;
    }
  }

  if (totalSamples < MIN_TOTAL_SAMPLES) {
    console.log(`[SignalLearner] Only ${totalSamples} samples (need ${MIN_TOTAL_SAMPLES}). Using defaults.`);
    return { totalSamples, learned: false };
  }

  // Compute learned weights
  const learnedWeights = {};
  const signalPerformance = {};

  for (const [sig, stats] of Object.entries(signalStats)) {
    const winRate = stats.count > 0 ? stats.wins / stats.count : 0;
    const hit10Rate = stats.count > 0 ? stats.hits10 / stats.count : 0;
    const avgReturn = stats.count > 0 ? stats.totalReturn / stats.count : 0;
    const avgMaxGain = stats.count > 0 ? stats.totalMaxGain / stats.count : 0;

    signalPerformance[sig] = {
      count: stats.count,
      winRate: Math.round(winRate * 100),
      hit10Rate: Math.round(hit10Rate * 100),
      avgReturn: Math.round(avgReturn * 100) / 100,
      avgMaxGain: Math.round(avgMaxGain * 100) / 100,
    };

    // Only learn weights when we have enough samples for this signal
    if (stats.count >= MIN_SAMPLES) {
      // Weight formula: combines hit rate, avg return, and sample size confidence.
      // Bayesian-style shrinkage: count/(count+20) approaches 1 asymptotically,
      // so 10 samples only get ~33% of the raw weight — small samples can no
      // longer swing weights aggressively (old formula hit full confidence at 20).
      const confidence = stats.count / (stats.count + 20);
      const rawWeight = (hit10Rate * 30) + (winRate * 10) + (Math.max(0, avgMaxGain) * 0.5);
      learnedWeights[sig] = Math.round(rawWeight * confidence * 100) / 100;
    }
  }

  // ── Loser penalty: signals with negative avg return AND low hit rate get penalized ──
  const loserPenalties = {};
  for (const [sig, stats] of Object.entries(signalStats)) {
    if (stats.count < MIN_SAMPLES) continue;
    const winRate = stats.wins / stats.count;
    const avgReturn = stats.totalReturn / stats.count;
    // Signal is a loser if: win rate < 30% AND avg return is negative
    if (winRate < 0.3 && avgReturn < -3) {
      // Hard penalty: set weight to 0 or negative (removes signal from scoring)
      loserPenalties[sig] = Math.round(avgReturn); // e.g., -7 for oversold_bounce
      learnedWeights[sig] = Math.max(0, (learnedWeights[sig] || 5) + loserPenalties[sig]);
    }
  }

  // ── Combo performance: which signal PAIRS produce 10%+ moves ──
  const comboPerformance = {};
  const killerCombos = []; // combos with hit10 >= 40%
  for (const [combo, stats] of Object.entries(comboStats)) {
    if (stats.count < MIN_COMBO_SAMPLES) continue;
    const hit10Rate = stats.count > 0 ? stats.hits10 / stats.count : 0;
    const winRate = stats.count > 0 ? stats.wins / stats.count : 0;
    const avgReturn = stats.count > 0 ? stats.totalReturn / stats.count : 0;
    comboPerformance[combo] = {
      count: stats.count,
      winRate: Math.round(winRate * 100),
      hit10Rate: Math.round(hit10Rate * 100),
      avgReturn: Math.round(avgReturn * 100) / 100,
    };
    // Killer combo: needs real sample size AND a positive average return —
    // a high "touched +10% intraday" rate with a negative avg return is a trap.
    if (hit10Rate >= 0.4 && avgReturn > 0) {
      killerCombos.push({ combo, hit10Rate: Math.round(hit10Rate * 100), count: stats.count, avgReturn: Math.round(avgReturn * 100) / 100 });
    }
  }
  killerCombos.sort((a, b) => b.hit10Rate - a.hit10Rate);

  // Save learned weights
  const output = {
    learnedWeights,
    signalPerformance,
    comboPerformance,
    killerCombos: killerCombos.slice(0, 20),
    loserPenalties,
    consensusPerformance: {},
    totalSamples,
    totalDays: dates.length,
    lastUpdated: new Date().toISOString(),
  };

  for (const [consensus, stats] of Object.entries(consensusStats)) {
    output.consensusPerformance[consensus] = {
      count: stats.count,
      winRate: stats.count > 0 ? Math.round((stats.wins / stats.count) * 100) : 0,
      hit10Rate: stats.count > 0 ? Math.round((stats.hits10 / stats.count) * 100) : 0,
      avgReturn: stats.count > 0 ? Math.round((stats.totalReturn / stats.count) * 100) / 100 : 0,
    };
  }

  saveWeights(output);
  console.log(`[SignalLearner] Learned weights from ${totalSamples} samples across ${dates.length} days`);
  console.log(`[SignalLearner] Top signals by 10%+ hit rate:`,
    Object.entries(signalPerformance)
      .filter(([, s]) => s.count >= MIN_SAMPLES)
      .sort((a, b) => b[1].hit10Rate - a[1].hit10Rate)
      .slice(0, 5)
      .map(([sig, s]) => `${sig}(${s.hit10Rate}%/${s.count})`)
      .join(', ') || 'Not enough data yet'
  );
  if (killerCombos.length > 0) {
    console.log(`[SignalLearner] Killer combos:`,
      killerCombos.slice(0, 5).map(c => `${c.combo}(${c.hit10Rate}%/${c.count})`).join(', ')
    );
  }
  if (Object.keys(loserPenalties).length > 0) {
    console.log(`[SignalLearner] Penalized losers:`,
      Object.entries(loserPenalties).map(([sig, pen]) => `${sig}(${pen})`).join(', ')
    );
  }

  return { totalSamples, learned: true, signalCount: Object.keys(learnedWeights).length, killerCombos: killerCombos.length };
}

/**
 * Get the learned weight for a signal.
 * Blends learned weight (70%) with default weight (30%) when available.
 * Returns null if not enough data to learn.
 */
export function getLearnedWeight(signal, defaultWeight) {
  const weights = loadWeights();
  if (!weights?.learnedWeights) return defaultWeight;

  const learned = weights.learnedWeights[signal];
  if (learned == null) return defaultWeight;

  // Blend: 70% learned, 30% default (learned data takes precedence)
  return Math.round((learned * 0.7 + defaultWeight * 0.3) * 100) / 100;
}

/**
 * Get all learned weights as a map.
 * Returns null if not enough data yet.
 */
export function getLearnedWeights() {
  const weights = loadWeights();
  if (!weights?.learnedWeights || weights.totalSamples < MIN_TOTAL_SAMPLES) return null;
  return weights.learnedWeights;
}

/**
 * Get combo bonus for a set of signals.
 * If any pair of signals in the list is a killer combo, returns bonus points.
 */
export function getComboBonus(signals) {
  const weights = loadWeights();
  if (!weights?.killerCombos?.length || !signals?.length) return 0;

  const sorted = [...signals].sort();
  let bonus = 0;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const key = `${sorted[i]}+${sorted[j]}`;
      const combo = weights.killerCombos.find(c => c.combo === key);
      if (combo) {
        // Bonus scales with hit rate: 40% → +8, 60% → +12, 80% → +16
        bonus += Math.round(combo.hit10Rate * 0.2);
      }
    }
  }
  // Cap combo bonus at 25 to prevent runaway scores
  return Math.min(25, bonus);
}

/**
 * Get signal performance report for display.
 */
export function getSignalReport() {
  return loadWeights();
}

function loadGemHistory() {
  if (!fs.existsSync(GEM_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(GEM_FILE, 'utf8')); } catch { return null; }
}

function loadWeights() {
  if (!fs.existsSync(WEIGHTS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch { return null; }
}

function saveWeights(data) {
  const dir = path.dirname(WEIGHTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}
