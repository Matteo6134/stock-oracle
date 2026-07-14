/**
 * Sector Gate — entry filter driven by python/backtest/sector_gate.py.
 *
 * Backtest evidence (sector_rotation_backtest.py, 2022-2026 + June-2026 stress
 * window): restricting entries to the top-3 sectors by 20d momentum and
 * preferring moderate-momentum names beat the random-monkey distribution in
 * both regimes; chasing parabolic leaders (the bot's old failure mode) lost.
 *
 * The gate applies to NEW ENTRIES ONLY. Exits are never touched.
 * If the gate file is missing or stale, the gate FAILS OPEN (no blocking) so a
 * broken cron can't silently freeze the bot.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_FILE = path.join(__dirname, '..', 'data', 'sectorGate.json');
const MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000; // fail open when older than 4 days

let cache = { data: null, mtimeMs: 0 };

function loadGate() {
  try {
    const stat = fs.statSync(GATE_FILE);
    if (cache.data && stat.mtimeMs === cache.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'));
    cache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch {
    return null;
  }
}

export function getSectorGate() {
  const gate = loadGate();
  if (!gate || !Array.isArray(gate.top_sectors)) return null;
  const age = Date.now() - new Date(gate.updated_at).getTime();
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return null; // stale → fail open
  return gate;
}

/**
 * Returns a skip reason string when the symbol's sector is measured and NOT in
 * the current top sectors; null when the entry is allowed. Symbols with no
 * sector mapping (ETFs, fresh listings) are allowed — the gate only acts on
 * what it actually measured.
 */
export function sectorGateVeto(symbol) {
  const gate = getSectorGate();
  if (!gate) return null;
  const sector = gate.sector_of?.[symbol];
  if (!sector) return null;
  if (gate.top_sectors.includes(sector)) return null;
  return `Sector gate: ${sector} not in top sectors (${gate.top_sectors.join(', ')})`;
}

/** Moderate-momentum candidates inside the top sectors, for scanner discovery. */
export function getSectorCandidates() {
  const gate = getSectorGate();
  return gate?.candidates && Array.isArray(gate.candidates) ? gate.candidates : [];
}

// ── Daily scan universes — replace every hardcoded ticker list in the scanners ──
// Freshness rule is looser than the entry gate: a few-days-old scan list is
// still a perfectly good scan list, so we use the raw file. If the gate file
// has never been generated, fall back to the liquidity-ranked archive universe
// (python/monkey/universe_active.json) — still data, never code.

const UNIVERSE_FILE = path.join(__dirname, '..', '..', 'python', 'monkey', 'universe_active.json');
let universeFallbackCache = null;

function universeFallback() {
  if (universeFallbackCache) return universeFallbackCache;
  try {
    const data = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
    const details = (data.details || []).filter(d => /^[A-Z]{1,5}$/.test(d.symbol || ''));
    const byAdv = [...details].sort((a, b) => (b.dollar_volume || 0) - (a.dollar_volume || 0));
    universeFallbackCache = {
      scan: byAdv.slice(0, 250).map(d => d.symbol),
      penny: byAdv.filter(d => (d.avg_close || 0) > 0 && d.avg_close <= 5).slice(0, 80).map(d => d.symbol),
    };
  } catch {
    universeFallbackCache = { scan: [], penny: [] };
  }
  return universeFallbackCache;
}

/** Symbols the scanners should sweep every cycle (~250, data-driven daily). */
export function getScanUniverse() {
  const gate = loadGate();
  if (gate?.scan_universe?.length) return gate.scan_universe;
  return universeFallback().scan;
}

/** Liquid sub-$5 names for the penny scanner (data-driven daily). */
export function getPennyUniverse() {
  const gate = loadGate();
  if (gate?.penny_universe?.length) return gate.penny_universe;
  return universeFallback().penny;
}
