/**
 * Polymarket Data Service
 *
 * Fetches live prediction market data from Polymarket's public APIs.
 * No authentication needed for market data — only for actual trading.
 *
 * APIs:
 *   - Gamma API (events, markets): https://gamma-api.polymarket.com
 *   - CLOB API (prices, orderbook): https://clob.polymarket.com
 */

import axios from 'axios';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

const http = axios.create({ timeout: 15000 });

// ── Cache ──
let marketsCache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Fetch active events from Polymarket.
 * Returns top events sorted by volume.
 */
export async function getActiveEvents(limit = 30) {
  try {
    const { data } = await http.get(`${GAMMA_API}/events`, {
      params: { active: true, closed: false, limit, order: 'volume', ascending: false },
    });
    return (data || []).map(event => ({
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description?.slice(0, 300) || '',
      category: event.category || 'Other',
      volume: parseFloat(event.volume || 0),
      liquidity: parseFloat(event.liquidity || 0),
      startDate: event.startDate,
      endDate: event.endDate,
      markets: (event.markets || []).map(m => formatMarket(m)),
    }));
  } catch (err) {
    console.error('[Polymarket] getActiveEvents error:', err.message);
    return [];
  }
}

/**
 * Fetch a single event's markets by slug.
 */
export async function getEventMarkets(slug) {
  try {
    const { data } = await http.get(`${GAMMA_API}/events`, {
      params: { slug },
    });
    const event = data?.[0];
    if (!event) return null;
    return {
      ...event,
      markets: (event.markets || []).map(m => formatMarket(m)),
    };
  } catch (err) {
    console.error('[Polymarket] getEventMarkets error:', err.message);
    return null;
  }
}

/**
 * Fetch top markets (combined: events + prices) — the main function for the dashboard.
 * Enriches each market with live Yes/No prices.
 */
export async function getTopMarkets(limit = 20) {
  // Check cache
  if (marketsCache.data && Date.now() - marketsCache.ts < CACHE_TTL) {
    return marketsCache.data;
  }

  try {
    const events = await getActiveEvents(limit);
    const allMarkets = [];

    for (const event of events) {
      for (const market of event.markets) {
        allMarkets.push({
          ...market,
          eventTitle: event.title,
          eventSlug: event.slug,
          category: event.category,
          eventEndDate: event.endDate,
        });
      }
    }

    // Sort by volume and take top N
    const sorted = allMarkets
      .filter(m => m.yesPrice > 0 && m.yesPrice < 1)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, limit);

    marketsCache = { data: sorted, ts: Date.now() };
    return sorted;
  } catch (err) {
    console.error('[Polymarket] getTopMarkets error:', err.message);
    return marketsCache.data || [];
  }
}

/**
 * Fetch live prices for specific token IDs from the CLOB.
 */
export async function getPrices(tokenIds) {
  if (!tokenIds || tokenIds.length === 0) return {};
  try {
    const ids = Array.isArray(tokenIds) ? tokenIds.join(',') : tokenIds;
    const { data } = await http.get(`${CLOB_API}/prices`, {
      params: { token_ids: ids },
    });
    return data || {};
  } catch (err) {
    console.error('[Polymarket] getPrices error:', err.message);
    return {};
  }
}

// ── Helpers ──

function formatMarket(m) {
  // Polymarket markets have outcome prices baked in
  const outcomes = m.outcomes || ['Yes', 'No'];
  const outcomePrices = m.outcomePrices
    ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)
    : [0.5, 0.5];

  const yesPrice = parseFloat(outcomePrices[0] || 0.5);
  const noPrice = parseFloat(outcomePrices[1] || (1 - yesPrice));

  return {
    id: m.id,
    conditionId: m.conditionId,
    question: m.question || m.groupItemTitle || 'Unknown',
    description: m.description?.slice(0, 200) || '',
    outcomes,
    yesPrice: Math.round(yesPrice * 100) / 100,
    noPrice: Math.round(noPrice * 100) / 100,
    yesTokenId: m.clobTokenIds?.[0] || null,
    noTokenId: m.clobTokenIds?.[1] || null,
    volume: parseFloat(m.volume || 0),
    liquidity: parseFloat(m.liquidity || 0),
    endDate: m.endDate,
    active: m.active !== false,
    closed: m.closed === true,
    resolved: m.resolved === true,
    resolutionSource: m.resolutionSource || null,
  };
}
