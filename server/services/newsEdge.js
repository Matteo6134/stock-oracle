/**
 * News Speed Edge — Breaking News Monitor for Polymarket
 *
 * Polls free RSS feeds every 2 minutes for breaking events.
 * When a headline matches an open Polymarket market, triggers
 * an immediate scan on affected markets (bypasses 15-min cron).
 *
 * Sources: Reuters, AP News, BBC, CNBC (all free, no API key)
 */

import RssParser from 'rss-parser';

const parser = new RssParser({ timeout: 10000 });

// ── RSS Feed Sources ──
const RSS_FEEDS = [
  { name: 'Reuters', url: 'https://feeds.reuters.com/reuters/topNews' },
  { name: 'Reuters World', url: 'https://feeds.reuters.com/reuters/worldNews' },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC Politics', url: 'https://feeds.bbci.co.uk/news/politics/rss.xml' },
  { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
];

// ── State ──
const recentNews = [];       // last N breaking items
const MAX_RECENT = 50;
const seenGuids = new Set();  // dedup by guid/link
let pollInterval = null;

// ── Keywords for matching news to markets ──
// These are common Polymarket market topics
const POLITICAL_FIGURES = [
  'trump', 'biden', 'harris', 'desantis', 'haley', 'vivek', 'ramaswamy',
  'newsom', 'pence', 'rfk', 'kennedy', 'obama', 'pelosi', 'mccarthy',
  'putin', 'zelensky', 'xi jinping', 'netanyahu', 'macron', 'starmer',
  'modi', 'trudeau', 'milei', 'bolsonaro', 'lula',
];

const EVENT_KEYWORDS = [
  'election', 'vote', 'poll', 'debate', 'primary', 'caucus', 'inauguration',
  'impeach', 'indictment', 'trial', 'verdict', 'conviction', 'sentenc',
  'war', 'ceasefire', 'invasion', 'missile', 'nuclear', 'sanction',
  'fed', 'interest rate', 'inflation', 'recession', 'gdp', 'jobs report',
  'supreme court', 'roe', 'abortion', 'gun', 'ai regulation',
  'bitcoin', 'crypto', 'ethereum', 'sec', 'etf approval',
  'shutdown', 'debt ceiling', 'default', 'congress', 'senate',
  'nato', 'china', 'taiwan', 'ukraine', 'russia', 'israel', 'gaza', 'iran',
  'pandemic', 'covid', 'bird flu', 'vaccine', 'who',
  'oscar', 'super bowl', 'world cup', 'olympics',
  'spacex', 'tesla', 'openai', 'google', 'apple', 'meta',
  'earthquake', 'hurricane', 'wildfire', 'climate',
];

/**
 * Check if a news headline is "breaking" (new and significant).
 */
function isBreaking(item) {
  const title = (item.title || '').toLowerCase();
  const desc = (item.contentSnippet || item.content || '').toLowerCase();
  const combined = `${title} ${desc}`;

  // Must match at least one keyword
  const matchesPolitical = POLITICAL_FIGURES.some(kw => combined.includes(kw));
  const matchesEvent = EVENT_KEYWORDS.some(kw => combined.includes(kw));

  return matchesPolitical || matchesEvent;
}

/**
 * Match a news item against open Polymarket markets.
 * Returns array of matched markets with relevance score.
 */
export function matchNewsToMarkets(newsItem, markets) {
  const headline = (newsItem.title || '').toLowerCase();
  const desc = (newsItem.contentSnippet || newsItem.content || '').toLowerCase();
  const newsText = `${headline} ${desc}`;

  const matched = [];

  for (const market of markets) {
    const question = (market.question || '').toLowerCase();
    const eventTitle = (market.eventTitle || '').toLowerCase();
    const marketText = `${question} ${eventTitle}`;

    // Extract significant words from market question (3+ chars)
    const marketWords = marketText
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .filter(w => !['the', 'will', 'what', 'how', 'who', 'when', 'does', 'yes', 'and', 'for', 'are', 'this', 'that', 'with', 'from', 'has', 'have', 'been', 'more', 'than'].includes(w));

    // Count keyword matches
    let matchCount = 0;
    const matchedWords = [];
    for (const word of marketWords) {
      if (newsText.includes(word)) {
        matchCount++;
        matchedWords.push(word);
      }
    }

    // Also check political figure matches specifically
    for (const figure of POLITICAL_FIGURES) {
      if (newsText.includes(figure) && marketText.includes(figure)) {
        matchCount += 2; // political figure match counts extra
        if (!matchedWords.includes(figure)) matchedWords.push(figure);
      }
    }

    // Need at least 2 keyword matches to consider it related
    const relevance = marketWords.length > 0 ? matchCount / marketWords.length : 0;
    if (matchCount >= 2 && relevance >= 0.15) {
      matched.push({
        market,
        relevance: Math.round(relevance * 100) / 100,
        matchCount,
        matchedWords: matchedWords.slice(0, 5),
      });
    }
  }

  // Sort by relevance, return top matches
  return matched.sort((a, b) => b.relevance - a.relevance).slice(0, 5);
}

/**
 * Poll all RSS feeds once.
 * Returns array of new breaking news items (not seen before).
 */
async function pollFeeds() {
  const newItems = [];

  for (const feed of RSS_FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      const items = (result.items || []).slice(0, 10); // only latest 10 per feed

      for (const item of items) {
        const guid = item.guid || item.link || item.title;
        if (!guid || seenGuids.has(guid)) continue;

        // Only items from last 30 minutes
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        const ageMs = Date.now() - pubDate.getTime();
        if (ageMs > 30 * 60 * 1000) {
          seenGuids.add(guid); // mark old items as seen so we skip them
          continue;
        }

        seenGuids.add(guid);

        if (isBreaking(item)) {
          const newsItem = {
            title: (item.title || '').trim(),
            link: item.link || '',
            source: feed.name,
            pubDate: pubDate.toISOString(),
            snippet: (item.contentSnippet || '').slice(0, 200),
            timestamp: new Date().toISOString(),
          };
          newItems.push(newsItem);

          // Add to recent list
          recentNews.unshift(newsItem);
          if (recentNews.length > MAX_RECENT) recentNews.length = MAX_RECENT;
        }
      }
    } catch (err) {
      // Silently skip failed feeds — they'll work next cycle
      console.error(`[NewsEdge] ${feed.name} feed error:`, err.message);
    }
  }

  // Prune seen guids to prevent memory leak (keep last 2000)
  if (seenGuids.size > 2000) {
    const arr = [...seenGuids];
    seenGuids.clear();
    for (const g of arr.slice(-1000)) seenGuids.add(g);
  }

  return newItems;
}

/**
 * Start the news monitor.
 * Polls RSS feeds every 2 minutes and calls onBreakingNews for each new item.
 *
 * @param {function} onBreakingNews - callback(newsItem) called for each breaking news item
 */
export function startNewsMonitor(onBreakingNews) {
  if (pollInterval) {
    console.log('[NewsEdge] Monitor already running');
    return;
  }

  console.log(`[NewsEdge] Starting news monitor — ${RSS_FEEDS.length} feeds, polling every 2 min`);

  const runPoll = async () => {
    try {
      const newItems = await pollFeeds();
      if (newItems.length > 0) {
        console.log(`[NewsEdge] ${newItems.length} breaking news items detected`);
        for (const item of newItems) {
          try {
            await onBreakingNews(item);
          } catch (err) {
            console.error('[NewsEdge] Callback error:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('[NewsEdge] Poll error:', err.message);
    }
  };

  // Initial poll after 10s (let other services warm up first)
  setTimeout(runPoll, 10000);

  // Then every 2 minutes
  pollInterval = setInterval(runPoll, 2 * 60 * 1000);
}

/**
 * Stop the news monitor.
 */
export function stopNewsMonitor() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[NewsEdge] Monitor stopped');
  }
}

/**
 * Get the last N breaking news items.
 */
export function getRecentBreakingNews(limit = 10) {
  return recentNews.slice(0, limit);
}
