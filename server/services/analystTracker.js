/**
 * Analyst Recommendation Tracker — Finnhub free tier
 *
 * Detects when analyst consensus shifts bullish:
 * - Recent upgrade: strongBuy + buy count increasing month-over-month
 * - Strong consensus: >80% of analysts say Buy/Strong Buy
 * - Momentum shift: analysts moving from Hold → Buy
 *
 * Source: Finnhub /stock/recommendation (free tier, no auth issues)
 * Returns monthly snapshots: { buy, hold, sell, strongBuy, strongSell, period }
 *
 * Signals:
 * - analyst_upgrade:     buy+strongBuy count increased vs prior month
 * - analyst_strong_buy:  >80% of analysts say Buy or Strong Buy
 * - analyst_momentum:    3+ consecutive months of increasing buy consensus
 */

import axios from 'axios';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours — analyst data changes slowly

const cache = new Map(); // symbol → { data, ts }

let keyMissingWarned = false;
function hasKey() {
  if (process.env.FINNHUB_API_KEY) return true;
  if (!keyMissingWarned) {
    console.warn('[AnalystTracker] FINNHUB_API_KEY not set — analyst signals disabled');
    keyMissingWarned = true;
  }
  return false;
}

/**
 * Fetch analyst recommendations for a single symbol.
 * Returns signals if a bullish shift is detected.
 */
async function fetchForSymbol(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const { data } = await axios.get(`${FINNHUB_BASE}/stock/recommendation`, {
      params: { symbol, token: key },
      timeout: 10000,
    });

    if (!Array.isArray(data) || data.length < 2) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    // Data comes sorted newest-first: [latest_month, prev_month, ...]
    const latest = data[0];
    const prev = data[1];
    const prev2 = data[2] || null;

    const latestBull = (latest.buy || 0) + (latest.strongBuy || 0);
    const latestTotal = latestBull + (latest.hold || 0) + (latest.sell || 0) + (latest.strongSell || 0);
    const prevBull = (prev.buy || 0) + (prev.strongBuy || 0);
    const prevTotal = prevBull + (prev.hold || 0) + (prev.sell || 0) + (prev.strongSell || 0);

    if (latestTotal === 0) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    const latestBullPct = latestTotal > 0 ? latestBull / latestTotal : 0;
    const prevBullPct = prevTotal > 0 ? prevBull / prevTotal : 0;

    const signals = [];

    // analyst_upgrade: buy+strongBuy count INCREASED vs prior month
    if (latestBull > prevBull && latestBull >= 3) {
      signals.push('analyst_upgrade');
    }

    // analyst_strong_buy: >80% of analysts say Buy or Strong Buy
    if (latestBullPct >= 0.8 && latestTotal >= 5) {
      signals.push('analyst_strong_buy');
    }

    // analyst_momentum: 3 consecutive months of increasing bull count
    if (prev2) {
      const prev2Bull = (prev2.buy || 0) + (prev2.strongBuy || 0);
      if (latestBull > prevBull && prevBull > prev2Bull) {
        signals.push('analyst_momentum');
      }
    }

    if (signals.length === 0) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    const result = {
      symbol,
      signals,
      buyCount: latest.buy || 0,
      strongBuyCount: latest.strongBuy || 0,
      holdCount: latest.hold || 0,
      sellCount: (latest.sell || 0) + (latest.strongSell || 0),
      totalAnalysts: latestTotal,
      bullPct: Math.round(latestBullPct * 100),
      prevBullPct: Math.round(prevBullPct * 100),
      period: latest.period || '',
    };

    cache.set(symbol, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      if (!keyMissingWarned) {
        console.warn(`[AnalystTracker] Finnhub ${status} — check API key`);
        keyMissingWarned = true;
      }
    }
    cache.set(symbol, { data: null, ts: Date.now() });
    return null;
  }
}

/**
 * Batch lookup — returns Map<symbol, analystSummary> for symbols with signals.
 * Rate-limited for Finnhub free tier (60 req/min).
 */
export async function getAnalystSignals(symbols) {
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
    const upgrades = [...results.values()].filter(r => r.signals.includes('analyst_upgrade'));
    console.log(`[AnalystTracker] ${results.size} stocks with analyst signals${upgrades.length > 0 ? ` (${upgrades.length} upgrades: ${upgrades.map(u => u.symbol).join(',')})` : ''}`);
  }
  return results;
}
