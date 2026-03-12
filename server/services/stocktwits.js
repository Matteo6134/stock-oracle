import axios from 'axios';

const BASE = 'https://api.stocktwits.com/api/2';

// ── Per-symbol cache with TTL ──
const sentimentCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let lastRequestTime = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    const { data } = await throttledGet(`${BASE}/streams/symbol/${symbol}.json`);
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
    const { data } = await throttledGet(`${BASE}/trending/symbols.json`);
    return (data?.symbols || []).map(s => ({
      symbol: s.symbol, name: s.title || s.symbol,
      watchlistCount: s.watchlist_count || 0
    }));
  } catch (err) {
    if (err.response?.status !== 403 && err.response?.status !== 429) {
      console.error('[StockTwits] Trending error:', err.message);
    }
    return [];
  }
}
