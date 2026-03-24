/**
 * Social Sentiment — Free APIs that work from cloud servers
 *
 * Sources:
 *   1. ApeWisdom — Reddit WSB/stocks/investing mentions (no auth, unlimited)
 *   2. Finnhub — Financial news headlines (free key, 60 req/min)
 *
 * Replaces the old reddit.js scraping that was blocked on Railway (403).
 */

import axios from 'axios';

// ── ApeWisdom: Reddit stock sentiment without scraping Reddit ──
let apeWisdomCache = { data: [], ts: 0 };
const APE_CACHE_TTL = 10 * 60 * 1000; // 10 min

/**
 * Get top trending stocks on Reddit (WSB, r/stocks, r/investing, 4chan)
 * Returns: [{ rank, ticker, name, mentions, upvotes, mentionsDelta }]
 */
export async function getRedditTrending() {
  if (apeWisdomCache.data.length > 0 && Date.now() - apeWisdomCache.ts < APE_CACHE_TTL) {
    return apeWisdomCache.data;
  }

  try {
    const { data } = await axios.get('https://apewisdom.io/api/v1.0/filter/all-stocks', {
      timeout: 10000,
    });

    const results = (data?.results || []).slice(0, 100).map(r => ({
      rank: r.rank,
      ticker: r.ticker,
      name: (r.name || '').replace(/&amp;/g, '&'),
      mentions: r.mentions || 0,
      upvotes: r.upvotes || 0,
      rank24hAgo: r.rank_24h_ago || 0,
      mentions24hAgo: r.mentions_24h_ago || 0,
      mentionsDelta: r.mentions_24h_ago
        ? Math.round(((r.mentions - r.mentions_24h_ago) / r.mentions_24h_ago) * 100)
        : null,
      trending: r.rank_24h_ago && r.rank < r.rank_24h_ago, // Climbing in rank
    }));

    apeWisdomCache = { data: results, ts: Date.now() };
    console.log(`[Social] ApeWisdom: ${results.length} stocks, #1 = ${results[0]?.ticker} (${results[0]?.mentions} mentions)`);
    return results;

  } catch (err) {
    console.error('[Social] ApeWisdom error:', err.message);
    return apeWisdomCache.data; // Return stale cache
  }
}

/**
 * Get social sentiment for a specific symbol.
 * Returns: { mentions, upvotes, rank, trending, mentionsDelta } or null
 */
export async function getSymbolSentiment(symbol) {
  const data = await getRedditTrending();
  return data.find(d => d.ticker === symbol.toUpperCase()) || null;
}

/**
 * Get symbols that are surging on social media (mentions up 50%+ in 24h)
 * These are potential meme plays or catalyst-driven moves
 */
export async function getSurgingStocks() {
  const data = await getRedditTrending();
  return data.filter(d =>
    d.mentionsDelta !== null &&
    d.mentionsDelta > 50 &&
    d.mentions >= 10
  ).sort((a, b) => (b.mentionsDelta || 0) - (a.mentionsDelta || 0));
}

// ── Finnhub: Financial news (needs free API key) ──
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
let newsCache = { data: [], ts: 0 };
const NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Get general market news from Finnhub
 * Returns: [{ headline, summary, source, url, datetime, category }]
 */
export async function getMarketNews() {
  if (!FINNHUB_KEY) return [];
  if (newsCache.data.length > 0 && Date.now() - newsCache.ts < NEWS_CACHE_TTL) {
    return newsCache.data;
  }

  try {
    const { data } = await axios.get('https://finnhub.io/api/v1/news', {
      params: { category: 'general', token: FINNHUB_KEY },
      timeout: 10000,
    });

    const results = (data || []).slice(0, 30).map(n => ({
      headline: n.headline,
      summary: (n.summary || '').slice(0, 200),
      source: n.source,
      url: n.url,
      datetime: new Date(n.datetime * 1000).toISOString(),
      category: n.category,
      related: n.related || '',
    }));

    newsCache = { data: results, ts: Date.now() };
    return results;

  } catch (err) {
    console.error('[Social] Finnhub news error:', err.message);
    return newsCache.data;
  }
}

/**
 * Get company-specific news from Finnhub
 */
export async function getCompanyNews(symbol) {
  if (!FINNHUB_KEY) return [];

  try {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    const { data } = await axios.get('https://finnhub.io/api/v1/company-news', {
      params: { symbol, from: weekAgo, to: today, token: FINNHUB_KEY },
      timeout: 10000,
    });

    return (data || []).slice(0, 10).map(n => ({
      headline: n.headline,
      summary: (n.summary || '').slice(0, 200),
      source: n.source,
      url: n.url,
      datetime: new Date(n.datetime * 1000).toISOString(),
    }));

  } catch (err) {
    return [];
  }
}
