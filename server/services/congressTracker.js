/**
 * Congress & Senate Trading Tracker
 *
 * US Congress members trade on privileged information and historically
 * beat the market by 10-20%. When they buy a stock, it often moves within days.
 *
 * Data source: Finnhub (free tier includes congressional trading).
 * Requires FINNHUB_API_KEY in the environment.
 * Free key: https://finnhub.io/register
 *
 * Signals:
 * - congress_buy: Recent purchase by congress member
 * - congress_cluster: Multiple members buying same stock
 * - senate_buy: Senator purchase (higher info access than House)
 */

import axios from 'axios';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours — data updates daily

// Per-symbol cache to respect Finnhub rate limits (60/min free tier)
const perSymbolCache = new Map(); // symbol → { trades, ts }

// Warn only once per process that the key is missing
let keyMissingWarned = false;
function hasKey() {
  if (process.env.FINNHUB_API_KEY) return true;
  if (!keyMissingWarned) {
    console.warn('[Congress] FINNHUB_API_KEY not set — congressional trading signals disabled. Get a free key at https://finnhub.io/register');
    keyMissingWarned = true;
  }
  return false;
}

/**
 * Fetch congressional trades for a single ticker (cached 6h).
 * Returns array of recent BUY transactions (last 60 days).
 */
async function fetchForSymbol(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];

  const cached = perSymbolCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.trades;

  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/stock/congressional-trading`, {
      params: { symbol, token: key },
      timeout: 10000,
    });

    const rows = Array.isArray(data?.data) ? data.data : [];
    const now = new Date();
    const cutoff = new Date(now - 60 * 24 * 60 * 60 * 1000);

    const trades = [];
    for (const t of rows) {
      const txType = (t.transactionType || t.transaction || '').toLowerCase();
      if (!txType.includes('purchase') && txType !== 'buy') continue;

      const d = new Date(t.transactionDate || t.filedDate);
      if (isNaN(d) || d < cutoff) continue;

      trades.push({
        symbol: symbol.toUpperCase(),
        politician: t.name || t.representative || 'Unknown',
        chamber: (t.position || t.house || '').toLowerCase().includes('senate') ? 'Senate' : 'House',
        type: 'BUY',
        amount: t.amount || '',
        date: t.transactionDate || t.filedDate || '',
      });
    }

    perSymbolCache.set(symbol, { trades, ts: Date.now() });
    return trades;
  } catch (err) {
    // 401/429 = auth/rate limit — cache empty for shorter period to avoid retry storms
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      // Bad key — disable further lookups this session
      if (!keyMissingWarned) {
        console.warn(`[Congress] Finnhub auth failed (${status}) — check FINNHUB_API_KEY`);
        keyMissingWarned = true;
      }
    }
    perSymbolCache.set(symbol, { trades: [], ts: Date.now() });
    return [];
  }
}

/**
 * Get congress buy signals for a list of symbols.
 * Returns Map<symbol, { buyCount, senators, politicians, trades, signal }>.
 *
 * To respect rate limits, only queries up to 30 symbols per scan.
 */
export async function getCongressSignals(symbols) {
  if (!hasKey() || !symbols?.length) return new Map();

  const signals = new Map();
  const uniq = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 30);

  // Query in small batches to stay under Finnhub free rate limit (60 req/min)
  const BATCH = 10;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(s => fetchForSymbol(s)));
    for (let j = 0; j < results.length; j++) {
      if (results[j].status !== 'fulfilled') continue;
      const trades = results[j].value;
      if (!trades.length) continue;
      const sym = batch[j];

      const entry = {
        buyCount: trades.length,
        senators: trades.filter(t => t.chamber === 'Senate').length,
        politicians: [...new Set(trades.map(t => t.politician))],
        trades,
        signal: null,
      };

      if (entry.politicians.length >= 3) entry.signal = 'congress_cluster';
      else if (entry.senators > 0) entry.signal = 'senate_buy';
      else entry.signal = 'congress_buy';

      signals.set(sym, entry);
    }
    // small gap between batches to be nice to Finnhub
    if (i + BATCH < uniq.length) await new Promise(r => setTimeout(r, 300));
  }

  if (signals.size > 0) {
    console.log(`[Congress] ${signals.size} stocks match recent congressional buys: ${[...signals.keys()].join(', ')}`);
  }
  return signals;
}

/**
 * Get all cached recent trades (used by status/debug endpoints).
 */
export function getAllCachedTrades() {
  const all = [];
  for (const { trades } of perSymbolCache.values()) all.push(...trades);
  return all;
}
