import axios from 'axios';

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'stockmarket'];
const POSITIVE_WORDS = ['bull','bullish','moon','rocket','buy','calls','long','up','gain','gains','profit','green','squeeze','breakout','beat','strong','surge','rally','soar','boom','winner','undervalued','upside','opportunity','growth','positive'];
const NEGATIVE_WORDS = ['bear','bearish','crash','sell','puts','short','down','loss','losses','red','dump','tank','drop','fall','weak','decline','plunge','bust','loser','overvalued','downside','risk','negative','fear','panic','recession'];

// ── Global post cache: fetch subreddits ONCE, reuse for all symbols ──
let cachedPosts = [];
let cacheTimestamp = 0;
let loadingPromise = null; // Prevents concurrent fetches (race condition lock)
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ── Circuit breaker: stop hammering Reddit if API is down ──
const circuitBreaker = { failures: 0, lastFailure: 0, isOpen: false };
const CB_THRESHOLD = 3; // consecutive failures before opening
const CB_RECOVERY_MS = 30 * 60 * 1000; // 30 min auto-recovery

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchSubreddit(subreddit) {
  // Circuit breaker check — skip request if circuit is open
  if (circuitBreaker.isOpen) {
    if (Date.now() - circuitBreaker.lastFailure > CB_RECOVERY_MS) {
      console.log('[Reddit] Circuit breaker recovering — retrying requests');
      circuitBreaker.isOpen = false;
      circuitBreaker.failures = 0;
    } else {
      return [];
    }
  }

  try {
    const { data } = await axios.get(
      `https://www.reddit.com/r/${subreddit}/hot.json?limit=50`,
      { headers: { 'User-Agent': 'StockOracle/2.0 (educational project)' }, timeout: 10000 }
    );
    // Success — reset circuit breaker
    circuitBreaker.failures = 0;
    return (data?.data?.children || []).map(c => ({
      title: c.data.title || '',
      selftext: (c.data.selftext || '').substring(0, 500),
      url: `https://www.reddit.com${c.data.permalink}`,
      score: c.data.score || 0,
      subreddit: c.data.subreddit || subreddit
    }));
  } catch (err) {
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();
    if (circuitBreaker.failures >= CB_THRESHOLD) {
      circuitBreaker.isOpen = true;
      console.error(`[Reddit] Circuit breaker OPEN after ${CB_THRESHOLD} consecutive failures — pausing requests for 30 min`);
    }
    if (err.response?.status !== 429) {
      console.error(`[Reddit] Error r/${subreddit}:`, err.message);
    }
    return [];
  }
}

async function ensurePostsLoaded() {
  // Return cached if still valid
  if (cachedPosts.length > 0 && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedPosts;
  }

  // If another call is already fetching, wait for it instead of starting a new one
  if (loadingPromise) {
    return loadingPromise;
  }

  // This is the first caller — start the fetch and let others wait on this promise
  loadingPromise = (async () => {
    try {
      console.log('[Reddit] Fetching subreddits (one-time batch)...');
      const allPosts = [];

      // Fetch sequentially with delays to avoid 429
      for (const sub of SUBREDDITS) {
        const posts = await fetchSubreddit(sub);
        allPosts.push(...posts);
        await sleep(2000); // 2s between each subreddit
      }

      cachedPosts = allPosts;
      cacheTimestamp = Date.now();
      console.log(`[Reddit] Cached ${allPosts.length} posts from ${SUBREDDITS.length} subreddits`);
      return allPosts;
    } finally {
      loadingPromise = null; // Reset so future calls after TTL can re-fetch
    }
  })();

  return loadingPromise;
}

function scoreSentiment(text) {
  const lower = text.toLowerCase();
  let pos = 0, neg = 0;
  POSITIVE_WORDS.forEach(w => { if (lower.includes(w)) pos++; });
  NEGATIVE_WORDS.forEach(w => { if (lower.includes(w)) neg++; });
  const total = pos + neg;
  return total === 0 ? 0 : (pos - neg) / total;
}

export async function getRedditSentiment(symbol) {
  try {
    const allPosts = await ensurePostsLoaded();

    const regex = new RegExp(`(\\$${symbol}\\b|\\b${symbol}\\b)`, 'i');
    const mentions = allPosts.filter(p => regex.test(`${p.title} ${p.selftext}`));

    let totalSent = 0;
    mentions.forEach(p => { totalSent += scoreSentiment(`${p.title} ${p.selftext}`); });

    return {
      mentions: mentions.length,
      sentiment: mentions.length > 0 ? Math.round((totalSent / mentions.length) * 100) / 100 : 0,
      topPosts: mentions.sort((a, b) => b.score - a.score).slice(0, 5)
        .map(p => ({ title: p.title, url: p.url, score: p.score, subreddit: p.subreddit }))
    };
  } catch (err) {
    console.error(`[Reddit] Sentiment error ${symbol}:`, err.message);
    return { mentions: 0, sentiment: 0, topPosts: [] };
  }
}
