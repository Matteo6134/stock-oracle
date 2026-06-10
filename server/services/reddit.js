import axios from 'axios';

// ── Direct Reddit JSON Search ──
const sentimentCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const BULL_WORDS = ['buy', 'bull', 'call', 'calls', 'moon', '🚀', 'long', 'undervalued', 'hold', 'breakout', 'squeeze'];
const BEAR_WORDS = ['sell', 'bear', 'put', 'puts', 'crash', 'drop', 'short', 'overvalued', 'dump'];

export async function getRedditSentiment(symbol) {
  try {
    const cached = sentimentCache.get(symbol);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL) return cached.data;

    // Use a custom User-Agent to prevent Reddit from blocking the request with a 429 Too Many Requests
    const query = `${symbol} stock`;
    const { data } = await axios.get(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=50`, {
      headers: {
        'User-Agent': 'node:stock-oracle-bot:v1.0 (by /u/unknown)'
      },
      timeout: 10000
    });

    const posts = data?.data?.children || [];
    if (posts.length === 0) {
      return { mentions: 0, sentiment: 0, topPosts: [], upvotes: 0 };
    }

    let bullScore = 0;
    let bearScore = 0;
    let totalUpvotes = 0;
    const topPosts = [];

    for (const p of posts) {
      const post = p.data;
      if (!post) continue;

      const title = (post.title || '').toLowerCase();
      const text = (post.selftext || '').toLowerCase();
      const content = `${title} ${text}`;
      
      let isBull = false;
      let isBear = false;

      BULL_WORDS.forEach(w => { if (content.includes(w)) isBull = true; });
      BEAR_WORDS.forEach(w => { if (content.includes(w)) isBear = true; });

      // Weight the sentiment by the upvote score of the post (min 1)
      const postScore = Math.max(1, post.score || 1);
      if (isBull) bullScore += postScore;
      if (isBear) bearScore += postScore;
      
      totalUpvotes += post.score || 0;

      // Only push posts that have some traction
      if (post.score > 2 || (isBull || isBear)) {
        topPosts.push(post.title);
      }
    }

    const totalScore = bullScore + bearScore;
    let sentiment = 0; // -1 to 1
    if (totalScore > 0) {
      sentiment = (bullScore - bearScore) / totalScore;
    }

    const result = {
      mentions: posts.length,
      sentiment: Math.round(sentiment * 100) / 100,
      topPosts: topPosts.slice(0, 3), // Return up to 3 top relevant posts
      upvotes: totalUpvotes,
      rank: 0 // Kept for compatibility
    };

    sentimentCache.set(symbol, { data: result, ts: Date.now() });
    return result;

  } catch (err) {
    console.error(`[Reddit] Search error ${symbol}:`, err.message);
    return { mentions: 0, sentiment: 0, topPosts: [], upvotes: 0 };
  }
}
