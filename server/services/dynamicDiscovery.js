import {
  getDailyGainers,
  getSmallCapGainers,
  getMostActive,
  getTrendingStocks,
} from './yahooFinance.js';
import { getSectorCandidates } from './sectorGate.js';

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_SYMBOLS = 200;

const cache = {
  symbols: [],
  timestamp: 0,
  sources: {},
};

let inflight = null;

function isExchangeSupported(sym) {
  if (!sym || typeof sym !== 'string') return false;
  if (sym.includes('.')) return false;
  if (sym.includes('=')) return false;
  if (sym.includes('^')) return false;
  return /^[A-Z][A-Z0-9.\-]{0,5}$/.test(sym);
}

async function fetchSource(label, fn) {
  try {
    const list = await fn();
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn(`[DynamicDiscovery] ${label} failed: ${err?.message || err}`);
    return [];
  }
}

export async function getDynamicSymbols({ force = false } = {}) {
  if (!force && cache.symbols.length && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.symbols;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const [dayGainers, smallCapGainers, mostActive, trending] = await Promise.all([
      fetchSource('day_gainers', getDailyGainers),
      fetchSource('small_cap_gainers', getSmallCapGainers),
      fetchSource('most_actives', getMostActive),
      fetchSource('trending', getTrendingStocks),
    ]);

    const sources = {
      day_gainers: dayGainers.length,
      small_cap_gainers: smallCapGainers.length,
      most_actives: mostActive.length,
      trending: trending.length,
    };

    const extract = (list) =>
      list
        .map((q) => (typeof q === 'string' ? q : q?.symbol))
        .filter(Boolean)
        .map((s) => String(s).toUpperCase())
        .filter(isExchangeSupported);

    // Sector-gate candidates FIRST: moderate-momentum names inside the top
    // sectors (measured edge) get priority over the chase-the-pump sources
    // (gainers/trending) when the MAX_SYMBOLS cap truncates the list.
    const sectorCandidates = extract(getSectorCandidates());
    sources.sector_gate = sectorCandidates.length;

    const combined = [
      ...sectorCandidates,
      ...extract(dayGainers),
      ...extract(smallCapGainers),
      ...extract(mostActive),
      ...extract(trending),
    ];

    const unique = [...new Set(combined)].slice(0, MAX_SYMBOLS);

    cache.symbols = unique;
    cache.timestamp = Date.now();
    cache.sources = sources;

    console.log(
      `[DynamicDiscovery] ${unique.length} symbols ` +
        `(sectorGate=${sources.sector_gate}, gainers=${sources.day_gainers}, ` +
        `smallCap=${sources.small_cap_gainers}, ` +
        `active=${sources.most_actives}, trending=${sources.trending})`
    );

    return unique;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export function getCachedDynamicSymbols() {
  return cache.symbols;
}

export function getDynamicDiscoveryStats() {
  return {
    count: cache.symbols.length,
    ageMs: cache.timestamp ? Date.now() - cache.timestamp : null,
    sources: cache.sources,
  };
}
