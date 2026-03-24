/**
 * Cross-Platform Arbitrage: Polymarket vs Kalshi
 *
 * When the SAME event is priced differently on two platforms,
 * you can bet both sides for risk-free profit.
 *
 * Example:
 *   Polymarket: "Trump wins" = 62¢ Yes
 *   Kalshi:     "Trump wins" = 55¢ Yes
 *   → Buy Yes on Kalshi (55¢) + Buy No on Polymarket (38¢)
 *   → Total cost: 93¢ → pays $1.00 no matter what → 7% risk-free profit
 *
 * Even without real Kalshi trading, we use their prices as
 * a "second market opinion" to confirm Polymarket mispricing.
 */

import axios from 'axios';

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const http = axios.create({ timeout: 15000, headers: { Accept: 'application/json' } });

let kalshiCache = { events: null, ts: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 min

/**
 * Fetch active Kalshi events + markets.
 */
export async function getKalshiEvents(limit = 30) {
  if (kalshiCache.events && Date.now() - kalshiCache.ts < CACHE_TTL) {
    return kalshiCache.events;
  }

  try {
    const { data } = await http.get(`${KALSHI_API}/events`, {
      params: { limit, status: 'open' },
    });

    const events = (data?.events || []).map(e => ({
      id: e.event_ticker,
      title: e.title,
      category: e.category || 'Other',
      markets: (e.markets || []).map(m => ({
        id: m.ticker,
        question: m.title || m.subtitle || e.title,
        yesPrice: (m.yes_ask || m.last_price || 50) / 100,
        noPrice: (m.no_ask || (100 - (m.last_price || 50))) / 100,
        volume: m.volume || 0,
        openInterest: m.open_interest || 0,
        closeDate: m.close_time,
      })),
    }));

    kalshiCache = { events, ts: Date.now() };
    return events;
  } catch (err) {
    console.error('[Kalshi] Fetch error:', err.message);
    return kalshiCache.events || [];
  }
}

/**
 * Find cross-platform arbitrage between Polymarket and Kalshi.
 *
 * Uses fuzzy matching on question text to find the same event on both platforms.
 * When found, compares prices for guaranteed profit.
 *
 * @param {Array} polyMarkets - Polymarket markets
 * @returns {Array} Arbitrage opportunities
 */
export async function findCrossPlatformArb(polyMarkets) {
  const kalshiEvents = await getKalshiEvents(30);
  if (kalshiEvents.length === 0) return [];

  // Build keyword index from Kalshi
  const kalshiFlat = [];
  for (const e of kalshiEvents) {
    for (const m of e.markets) {
      kalshiFlat.push({
        ...m,
        eventTitle: e.title,
        category: e.category,
        keywords: extractKeywords(m.question + ' ' + e.title),
      });
    }
  }

  const opportunities = [];

  for (const poly of polyMarkets) {
    const polyKeywords = extractKeywords(poly.question + ' ' + (poly.eventTitle || ''));
    if (polyKeywords.length < 2) continue;

    // Find Kalshi match by keyword overlap
    let bestMatch = null;
    let bestScore = 0;

    for (const kal of kalshiFlat) {
      const overlap = polyKeywords.filter(k => kal.keywords.includes(k)).length;
      const score = overlap / Math.max(polyKeywords.length, kal.keywords.length);
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = kal;
      }
    }

    if (!bestMatch) continue;

    // Check for arbitrage
    const polyYes = poly.yesPrice;
    const kalYes = bestMatch.yesPrice;
    const polyNo = poly.noPrice;
    const kalNo = bestMatch.noPrice;

    // Arb 1: Buy Yes on cheaper platform + Buy No on other
    const costBuyYesPoly = polyYes + kalNo;
    const costBuyYesKalshi = kalYes + polyNo;

    let arbProfit = 0;
    let arbAction = null;

    if (costBuyYesPoly < 0.97) {
      arbProfit = Math.round((1 - costBuyYesPoly) * 1000) / 10;
      arbAction = `Buy YES on Polymarket (${Math.round(polyYes * 100)}¢) + Buy NO on Kalshi (${Math.round(kalNo * 100)}¢)`;
    } else if (costBuyYesKalshi < 0.97) {
      arbProfit = Math.round((1 - costBuyYesKalshi) * 1000) / 10;
      arbAction = `Buy YES on Kalshi (${Math.round(kalYes * 100)}¢) + Buy NO on Polymarket (${Math.round(polyNo * 100)}¢)`;
    }

    // Price difference insight (even if no arb, useful for edge detection)
    const priceDiff = Math.round(Math.abs(polyYes - kalYes) * 1000) / 10;

    if (arbProfit > 0 || priceDiff > 5) {
      opportunities.push({
        polymarket: {
          question: poly.question,
          yesPrice: polyYes,
          noPrice: polyNo,
          volume: poly.volume,
        },
        kalshi: {
          question: bestMatch.question,
          yesPrice: kalYes,
          noPrice: kalNo,
          volume: bestMatch.volume,
        },
        matchScore: Math.round(bestScore * 100),
        priceDiff,
        arbProfit,
        arbAction,
        isArbitrage: arbProfit > 0,
        cheaperYes: polyYes < kalYes ? 'polymarket' : 'kalshi',
        thesis: arbProfit > 0
          ? `Risk-free ${arbProfit}% profit: ${arbAction}. Total cost ${Math.round(Math.min(costBuyYesPoly, costBuyYesKalshi) * 100)}¢, pays $1.00.`
          : `Price gap: Polymarket ${Math.round(polyYes * 100)}¢ vs Kalshi ${Math.round(kalYes * 100)}¢ (${priceDiff}% diff). Buy on ${polyYes < kalYes ? 'Polymarket' : 'Kalshi'} for better price.`,
      });
    }
  }

  return opportunities.sort((a, b) => b.arbProfit - a.arbProfit || b.priceDiff - a.priceDiff);
}

/**
 * Extract meaningful keywords from text for fuzzy matching.
 */
function extractKeywords(text) {
  const stopWords = new Set(['will', 'the', 'be', 'a', 'an', 'in', 'on', 'by', 'of', 'to', 'for', 'and', 'or', 'is', 'it', 'at', 'this', 'that', 'with', 'from', 'as', 'before', 'after', 'win', 'won']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}
