import axios from 'axios';

const BASE = 'https://api.stocktwits.com/api/2';

// ── Per-symbol cache with TTL ──
const sentimentCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let lastRequestTime = 0;

// ── Circuit breaker: stop hammering StockTwits if API is down ──
const circuitBreaker = { failures: 0, lastFailure: 0, isOpen: false };
const CB_THRESHOLD = 3; // consecutive failures before opening
const CB_RECOVERY_MS = 30 * 60 * 1000; // 30 min auto-recovery

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function checkCircuitBreaker() {
  if (circuitBreaker.isOpen) {
    if (Date.now() - circuitBreaker.lastFailure > CB_RECOVERY_MS) {
      console.log('[StockTwits] Circuit breaker recovering — retrying requests');
      circuitBreaker.isOpen = false;
      circuitBreaker.failures = 0;
      return false; // circuit closed, allow request
    }
    return true; // circuit still open, block request
  }
  return false; // circuit closed, allow request
}

function recordFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();
  if (circuitBreaker.failures >= CB_THRESHOLD) {
    circuitBreaker.isOpen = true;
    console.error(`[StockTwits] Circuit breaker OPEN after ${CB_THRESHOLD} consecutive failures — pausing requests for 30 min`);
  }
}

function recordSuccess() {
  circuitBreaker.failures = 0;
}

async function throttledGet(url) {
  const now = Date.now();
  const wait = Math.max(0, 2000 - (now - lastRequestTime)); // 2s between requests
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();
  return axios.get(url, { timeout: 10000 });
}

export async function getStockTwitsSentiment(symbol) {
  try {
    // Check cache first
    const cached = sentimentCache.get(symbol);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL) return cached.data;

    // Circuit breaker check — return cached or empty if open
    if (checkCircuitBreaker()) {
      if (cached) return cached.data;
      return { bullish: 0, bearish: 0, total: 0, sentiment: 0 };
    }

    const { data } = await throttledGet(`${BASE}/streams/symbol/${symbol}.json`);
    recordSuccess();

    if (!data?.messages) {
      const empty = { bullish: 0, bearish: 0, total: 0, sentiment: 0 };
      sentimentCache.set(symbol, { data: empty, ts: Date.now() });
      return empty;
    }

    let bullish = 0, bearish = 0;
    data.messages.forEach(m => {
      const s = m.entities?.sentiment?.basic;
      if (s === 'Bullish') bullish++;
      else if (s === 'Bearish') bearish++;
    });

    const st = bullish + bearish;
    const result = {
      bullish, bearish,
      total: data.messages.length,
      sentiment: st > 0 ? Math.round(((bullish - bearish) / st) * 100) / 100 : 0
    };
    sentimentCache.set(symbol, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    recordFailure();
    // On 403/429, return cached or empty (don't spam logs)
    if (err.response?.status === 403 || err.response?.status === 429) {
      const cached = sentimentCache.get(symbol);
      if (cached) return cached.data;
    } else {
      console.error(`[StockTwits] Sentiment error ${symbol}:`, err.message);
    }
    return { bullish: 0, bearish: 0, total: 0, sentiment: 0 };
  }
}

export async function getTrending() {
  try {
    // Circuit breaker check
    if (checkCircuitBreaker()) return [];

    const { data } = await throttledGet(`${BASE}/trending/symbols.json`);
    recordSuccess();
    return (data?.symbols || []).map(s => ({
      symbol: s.symbol, name: s.title || s.symbol,
      watchlistCount: s.watchlist_count || 0
    }));
  } catch (err) {
    recordFailure();
    if (err.response?.status !== 403 && err.response?.status !== 429) {
      console.error('[StockTwits] Trending error:', err.message);
    }
    return [];
  }
}
