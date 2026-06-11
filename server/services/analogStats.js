/**
 * Analog Stats — historical evidence for live predictions.
 *
 * Reads the tables produced by python/backtest/setup_stats.py (28 years of
 * setup → outcome statistics) and answers, for a live candidate:
 *   "How did setups like this one actually perform, and in this VIX regime?"
 *
 * Used by: telegram.js (honest probability in prediction messages),
 * autoTrader.js (evidence veto + conviction adjustment + regime sizing).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_FILE = path.join(__dirname, '..', '..', 'python', 'backtest', 'archive', 'setup_stats.json');
const MACRO_FILE = path.join(__dirname, '..', '..', 'python', 'backtest', 'archive', 'macro_stats.json');

// Live signal names → backtestable setup families
const SIGNAL_MAP = {
  volume_contraction: 'volume_contraction',
  bb_squeeze: 'bb_squeeze',
  price_compression: 'bb_squeeze',
  short_squeeze_loading: 'bb_squeeze',
  unusual_volume: 'unusual_volume',
  volume_acceleration: 'unusual_volume',
  low_float_volume: 'unusual_volume',
  early_breakout: 'breakout',
  near_52w_high: 'breakout',
  early_momentum: 'momentum',
  momentum_acceleration: 'momentum',
};

// stockIntel regime labels → setup_stats VIX buckets
const REGIME_MAP = {
  CALM: 'calm', NORMAL: 'calm',
  ELEVATED: 'elevated',
  HIGH_FEAR: 'panic', PANIC: 'panic',
};

function cachedLoader(file) {
  let cache = { mtime: 0, data: null };
  return () => {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime !== cache.mtime) {
        cache = { mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
      }
      return cache.data;
    } catch { return null; }
  };
}

const loadSetupStats = cachedLoader(SETUP_FILE);
const loadMacroStats = cachedLoader(MACRO_FILE);

// Must match the `names` list order in setup_stats.py — pair keys are joined
// in this canonical order ("volume_contraction+bb_squeeze", never reversed).
const CANONICAL_ORDER = ['volume_contraction', 'bb_squeeze', 'unusual_volume', 'breakout', 'momentum'];

function mappedSetups(signals) {
  const set = new Set();
  for (const s of signals || []) {
    if (SIGNAL_MAP[s]) set.add(SIGNAL_MAP[s]);
  }
  return CANONICAL_ORDER.filter(name => set.has(name));
}

/**
 * Historical analog for a live candidate. Returns null when we have no
 * backtestable setup or no sample of at least 30.
 * { key, n, hitRate, avgFwd5, medFwd5, regime, stable } — hitRate = P(+10% within 5d).
 */
export function getAnalog(stock, vixRegimeLabel) {
  const stats = loadSetupStats();
  if (!stats?.setups) return null;
  const families = mappedSetups(stock.signals);
  if (families.length === 0) return null;
  const regime = REGIME_MAP[vixRegimeLabel] || null;

  // Most specific first: pair combos, then singles (largest sample first)
  const candidates = [];
  for (let i = 0; i < families.length; i++) {
    for (let j = i + 1; j < families.length; j++) {
      candidates.push(`${families[i]}+${families[j]}`);
    }
  }
  candidates.push(...families);

  for (const key of candidates) {
    const entry = stats.setups[key];
    if (!entry) continue;
    const block = (regime && entry.by_regime?.[regime]?.n >= 30)
      ? { ...entry.by_regime[regime], regime }
      : { ...entry.all, regime: null };
    if (!block?.n || block.n < 30) continue;
    // Walk-forward stability: did the edge survive out-of-sample (>=2023)?
    const stable = entry.train && entry.validate
      ? Math.sign(entry.train.avg_fwd5) === Math.sign(entry.validate.avg_fwd5)
      : null;
    return {
      key,
      n: block.n,
      hitRate: block.hit10_5d,
      avgFwd5: block.avg_fwd5,
      medFwd5: block.med_fwd5,
      regime: block.regime,
      stable,
      window: stats.window || null,
    };
  }
  return null;
}

/**
 * Evidence veto: block the trade when history is loudly negative.
 */
export function analogVeto(analog) {
  if (!analog) return null;
  if (analog.n >= 100 && analog.avgFwd5 < -0.5) {
    return `Historical analogs negative: ${analog.key} avg ${analog.avgFwd5}%/5d over ${analog.n} cases`;
  }
  return null;
}

/**
 * Regime sizing multiplier from the regime baseline (all setup-days).
 * ~1.0 in average conditions, <1 when this regime historically underperforms.
 */
export function regimeMultiplier(vixRegimeLabel) {
  const stats = loadSetupStats();
  const regime = REGIME_MAP[vixRegimeLabel];
  const base = stats?.regime_baseline;
  if (!base?.all || !regime || !base[regime]) return 1.0;
  const overall = base.all.avg_fwd5;
  const here = base[regime].avg_fwd5;
  if (overall == null || here == null) return 1.0;
  // Shift sizing by how much this regime's edge deviates from the overall edge
  const mult = 1 + (here - overall) / Math.max(1, Math.abs(overall) * 4);
  return Math.min(1.3, Math.max(0.5, Math.round(mult * 100) / 100));
}

/** Recommended exit target from the historical sweep (or null). */
export function recommendedExitTarget() {
  const stats = loadSetupStats();
  return stats?.exit_sweep_best || null;
}

/** Macro radar snapshot: today's bucket + historical SPY forward distribution. */
export function getMacroRadar() {
  const macro = loadMacroStats();
  if (!macro?.today) return null;
  return { today: macro.today, bucket: macro.buckets?.[macro.today.bucket_key] || null };
}
