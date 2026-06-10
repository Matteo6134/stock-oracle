/**
 * Insider Intelligence — Finnhub-powered executive trading detector
 *
 * When multiple company executives buy their own stock within 30 days,
 * it's one of the strongest bullish signals in public markets.
 * Insiders see the pipeline, deals, earnings quality — they have
 * real inside info and rarely buy unless they're confident.
 *
 * Data source: Finnhub /stock/insider-transactions (SEC Form 4, free tier)
 * Requires FINNHUB_API_KEY in env.
 *
 * Signals:
 * - insider_cluster       — 3+ distinct insiders buying in 30 days (STRONGEST)
 * - insider_heavy_buy     — single purchase >= $100K
 * - insider_buy_recent    — any insider purchase in last 14 days
 */

import axios from 'axios';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Per-symbol cache
const cache = new Map(); // symbol → { data, ts }

let keyMissingWarned = false;
function hasKey() {
  if (process.env.FINNHUB_API_KEY) return true;
  if (!keyMissingWarned) {
    console.warn('[InsiderIntel] FINNHUB_API_KEY not set — insider signals disabled');
    keyMissingWarned = true;
  }
  return false;
}

/**
 * Fetch insider transactions for a single symbol (Finnhub free tier).
 * Returns parsed purchase data with cluster detection.
 */
async function fetchForSymbol(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/stock/insider-transactions`, {
      params: { symbol, token: key },
      timeout: 10000,
    });

    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length === 0) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    // Filter: last 30 days, purchases only (transactionCode === 'P')
    const now = new Date();
    const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const cutoff14 = new Date(now - 14 * 24 * 60 * 60 * 1000);

    const recentBuys = [];
    for (const r of rows) {
      const code = (r.transactionCode || '').toUpperCase();
      const isBuy = code === 'P' || code === 'A'; // P=purchase, A=grant/award(exclude usually)
      if (code !== 'P') continue; // strict: only open-market purchases (not grants)

      const filingDate = r.filingDate || r.transactionDate;
      const d = new Date(filingDate);
      if (isNaN(d) || d < cutoff30) continue;

      // Share count can be negative for sales — filter positives only for buys
      const shares = Math.abs(r.change || r.share || 0);
      const price = r.transactionPrice || 0;
      const value = shares * price;

      recentBuys.push({
        name: r.name || 'Insider',
        date: filingDate,
        shares,
        price,
        value,
        isRecent: d >= cutoff14,
      });
    }

    if (recentBuys.length === 0) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    // Aggregate
    const uniqueInsiders = new Set(recentBuys.map(b => b.name));
    const totalValue = recentBuys.reduce((s, b) => s + (b.value || 0), 0);
    const maxSingle = Math.max(...recentBuys.map(b => b.value || 0));
    const hasRecent14d = recentBuys.some(b => b.isRecent);

    // Assign signals
    const signals = [];
    if (uniqueInsiders.size >= 3) signals.push('insider_cluster');
    if (maxSingle >= 100000) signals.push('insider_heavy_buy');
    if (hasRecent14d) signals.push('insider_buy_recent');

    if (signals.length === 0) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    const summary = {
      symbol,
      signals,
      uniqueInsiders: uniqueInsiders.size,
      totalTransactions: recentBuys.length,
      totalValue: Math.round(totalValue),
      maxSingleValue: Math.round(maxSingle),
      insiderNames: [...uniqueInsiders].slice(0, 5),
      mostRecentDate: recentBuys[0]?.date || '',
    };

    cache.set(symbol, { data: summary, ts: Date.now() });
    return summary;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      if (!keyMissingWarned) {
        console.warn(`[InsiderIntel] Finnhub ${status} — check FINNHUB_API_KEY`);
        keyMissingWarned = true;
      }
    }
    cache.set(symbol, { data: null, ts: Date.now() });
    return null;
  }
}

/**
 * Batch lookup — returns Map<symbol, insiderSummary> for symbols with signals.
 * Rate-limited to respect Finnhub free tier (60 req/min).
 */
export async function getInsiderSignals(symbols) {
  if (!hasKey() || !symbols?.length) return new Map();

  const results = new Map();
  const uniq = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 25);

  const BATCH = 10;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(s => fetchForSymbol(s))
    );
    for (let j = 0; j < batchResults.length; j++) {
      if (batchResults[j].status !== 'fulfilled') continue;
      const data = batchResults[j].value;
      if (data) results.set(batch[j], data);
    }
    if (i + BATCH < uniq.length) await new Promise(r => setTimeout(r, 400));
  }

  if (results.size > 0) {
    const clusters = [...results.values()].filter(r => r.signals.includes('insider_cluster'));
    console.log(`[InsiderIntel] ${results.size} stocks with insider activity${clusters.length > 0 ? ` (${clusters.length} clusters: ${clusters.map(c => c.symbol).join(',')})` : ''}`);
  }
  return results;
}
