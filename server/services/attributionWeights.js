/**
 * Attribution Weight Bridge
 * =========================
 * Merges the Supabase-derived fitted signal weights — computed by
 * python/backtest/backtest_predictions.py → signal_attribution.json — into the
 * live signalWeights.json that getLearnedWeight()/getComboBonus() already read.
 *
 * The Python attribution uses the SAME formula as signalLearner.js but a LARGER
 * sample (the full Supabase `predictions` table) than the local gemHistory.json
 * the JS learner sees. We blend the two per-signal weighted BY SAMPLE SIZE, so
 * whichever source has more evidence dominates, and we hard-suppress signals the
 * data shows are net losers (negative avg return + profit factor < 1).
 *
 * Designed to run right AFTER signalLearner.learnFromOutcomes() (which rewrites
 * signalWeights.json from gemHistory) and after the weekly Python refresh, so the
 * persisted file ends up as the blended result. Non-destructive to signals the
 * Python layer has no opinion on.
 *
 * Disable with autoTradeConfig.json { "useAttributionWeights": false }.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTRIBUTION_FILE = path.join(__dirname, '..', '..', 'python', 'backtest', 'signal_attribution.json');
const WEIGHTS_FILE = path.join(__dirname, '..', 'data', 'signalWeights.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'autoTradeConfig.json');

const MIN_SIGNAL_COUNT = 5;   // ignore Python signals with fewer resolved samples
const MIN_PY_RESOLVED = 40;   // don't merge at all if Python has too few outcomes overall
const MIN_COMBO_COUNT = 5;    // only adopt combos with this many samples
const MIN_COMBO_HIT = 0.5;    // ...and at least this hit rate
const MAX_COMBOS = 25;

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ignore */ }
  return null;
}

/** Raw Supabase attribution report (for /edge etc). */
export function getAttribution() {
  return readJson(ATTRIBUTION_FILE);
}

/**
 * Blend Supabase-derived fitted weights into signalWeights.json.
 * Returns a summary of what changed.
 */
export function mergeAttributionWeights() {
  const cfg = readJson(CONFIG_FILE) || {};
  if (cfg.useAttributionWeights === false) {
    return { merged: false, reason: 'disabled in autoTradeConfig' };
  }

  const attr = readJson(ATTRIBUTION_FILE);
  if (!attr?.per_signal?.length) return { merged: false, reason: 'no attribution file' };
  if ((attr.n_resolved || 0) < MIN_PY_RESOLVED) {
    return { merged: false, reason: `only ${attr.n_resolved} resolved predictions (need ${MIN_PY_RESOLVED})` };
  }

  const weights = readJson(WEIGHTS_FILE) || {};
  const learned = { ...(weights.learnedWeights || {}) };
  const jsPerf = weights.signalPerformance || {};

  const changes = [];
  const suppressed = [];

  for (const row of attr.per_signal) {
    const sig = row.signal;
    const pn = row.count || 0;
    if (!sig || pn < MIN_SIGNAL_COUNT) continue;

    const pw = Number(row.fitted_weight ?? 0);          // Python fitted weight
    const jw = learned[sig];                            // current (JS) learned weight
    const jn = jsPerf[sig]?.count || 0;                 // JS sample size

    // Sample-size-weighted blend; if JS has no data, take Python outright
    let merged = (jw == null || jn === 0) ? pw : (pw * pn + jw * jn) / (pn + jn);
    merged = Math.round(merged * 100) / 100;

    // Hard-suppress proven losers (profit_factor null === all-positive, so safe)
    const pf = row.profit_factor;
    const isLoser = pf != null && pf < 1.0 && (row.avg_return_pct ?? 0) < 0 && pn >= 8;
    if (isLoser) {
      const capped = Math.min(merged, 2);
      if (capped !== (learned[sig] ?? null)) {
        suppressed.push(`${sig}(PF ${pf.toFixed(2)}, n${pn}) -> ${capped}`);
      }
      merged = capped;
    }

    const prev = learned[sig];
    if (prev == null || Math.abs((prev || 0) - merged) >= 0.5) {
      changes.push({ sig, from: prev ?? null, to: merged });
    }
    learned[sig] = merged;
  }

  // Merge killer combos (convert Python {pair:[a,b]} → JS {combo:"a+b"} schema)
  const comboMap = {};
  for (const c of (weights.killerCombos || [])) if (c?.combo) comboMap[c.combo] = { ...c };
  for (const c of (attr.top_combos || [])) {
    if (!Array.isArray(c.pair) || c.pair.length !== 2) continue;
    if ((c.count || 0) < MIN_COMBO_COUNT || (c.hit_rate ?? 0) < MIN_COMBO_HIT) continue;
    const key = [...c.pair].sort().join('+');
    const cand = {
      combo: key,
      hit10Rate: Math.round((c.hit_rate || 0) * 100),
      count: c.count,
      avgReturn: Math.round((c.avg_return_pct || 0) * 100) / 100,
    };
    const existing = comboMap[key];
    if (!existing || cand.count >= existing.count) comboMap[key] = cand;
  }
  const killerCombos = Object.values(comboMap)
    .sort((a, b) => b.hit10Rate - a.hit10Rate)
    .slice(0, MAX_COMBOS);

  const output = {
    ...weights,
    learnedWeights: learned,
    killerCombos,
    totalSamples: Math.max(weights.totalSamples || 0, attr.n_resolved || 0),
    attributionMergedAt: new Date().toISOString(),
    attributionSamples: attr.n_resolved,
  };

  const dir = path.dirname(WEIGHTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: never leave a half-written weights file that breaks live scoring
  const tmp = `${WEIGHTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmp, WEIGHTS_FILE);

  console.log(`[Attribution] Merged ${attr.per_signal.length} Supabase-derived signals (n=${attr.n_resolved}) into signalWeights.json`);
  if (changes.length) {
    const top = changes
      .sort((a, b) => Math.abs(b.to - (b.from || 0)) - Math.abs(a.to - (a.from || 0)))
      .slice(0, 8)
      .map(c => `${c.sig} ${c.from ?? '-'}->${c.to}`);
    console.log('[Attribution] Biggest weight changes:', top.join(', '));
  }
  if (suppressed.length) console.log('[Attribution] Suppressed losers:', suppressed.join(', '));

  return {
    merged: true,
    signals: attr.per_signal.length,
    samples: attr.n_resolved,
    changes: changes.length,
    suppressed: suppressed.length,
    killerCombos: killerCombos.length,
  };
}
