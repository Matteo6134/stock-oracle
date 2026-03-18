import axios from 'axios';

const POSITIVE = ['surge','soar','rally','gain','rise','jump','boost','climb','record','high','beat','exceed','profit','growth','strong','upgrade','outperform','buy','bull','positive','breakthrough','innovation','approve','success','win','deal','expand','launch','partner','revenue','boom','recover'];
const NEGATIVE = ['crash','plunge','drop','fall','decline','loss','lose','miss','low','weak','cut','downgrade','underperform','sell','bear','negative','warning','risk','fear','concern','lawsuit','investigate','fraud','recall','layoff','bankruptcy','default','debt','fine','penalty','scandal','recession'];

const BIGRAMS = [
  { phrase: 'beats estimates', score: 2 },
  { phrase: 'misses estimates', score: -2 },
  { phrase: 'price target raised', score: 1.5 },
  { phrase: 'price target cut', score: -1.5 },
  { phrase: 'all-time high', score: 1 },
  { phrase: '52-week low', score: -1 },
];

const STOCK_CONTEXT = ['stock','shares','earnings','$','market','revenue','profit','eps'];

function hasStockContext(lower, symbol) {
  if (symbol && lower.includes(symbol.toLowerCase())) return true;
  return STOCK_CONTEXT.some(w => lower.includes(w));
}

function scoreSentiment(title, symbol) {
  const lower = title.toLowerCase();
  const contextual = hasStockContext(lower, symbol);
  let score = 0, hits = 0;

  // Bigram matching (always applied — these are inherently stock-specific)
  for (const { phrase, score: s } of BIGRAMS) {
    if (lower.includes(phrase)) { score += s; hits++; }
  }

  // Keyword matching (only when stock context is present)
  if (contextual) {
    let p = 0, n = 0;
    POSITIVE.forEach(w => { if (lower.includes(w)) p++; });
    NEGATIVE.forEach(w => { if (lower.includes(w)) n++; });
    const t = p + n;
    if (t > 0) { score += (p - n) / t; hits++; }
  }

  return hits === 0 ? 0 : Math.round((score / hits) * 100) / 100;
}

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const ti = m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const li = m[1].match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    const pd = m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (ti) items.push({ title: ti[1].trim(), url: li ? li[1].trim() : '', publishedAt: pd ? pd[1].trim() : '', source: 'Google News' });
  }
  return items;
}

export async function getNewsForStock(symbol, companyName) {
  try {
    const articles = [];
    const q = encodeURIComponent(`${symbol} ${companyName || ''} stock`.trim());

    try {
      const { data } = await axios.get(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, { timeout: 10000, headers: { 'User-Agent': 'StockOracle/1.0' } });
      parseRss(data).forEach(item => articles.push({ ...item, sentiment: scoreSentiment(item.title, symbol) }));
    } catch (e) { console.error(`[News] Google RSS error ${symbol}:`, e.message); }

    if (process.env.NEWS_API_KEY) {
      try {
        const { data } = await axios.get(`https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=10&apiKey=${process.env.NEWS_API_KEY}`, { timeout: 10000 });
        (data?.articles || []).forEach(a => articles.push({ title: a.title || '', url: a.url || '', source: a.source?.name || 'NewsAPI', publishedAt: a.publishedAt || '', sentiment: scoreSentiment(a.title || '', symbol) }));
      } catch (e) { console.error(`[News] NewsAPI error ${symbol}:`, e.message); }
    }

    const seen = new Set();
    return articles.filter(a => { const k = a.url || a.title; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
  } catch (err) {
    console.error(`[News] Error ${symbol}:`, err.message);
    return [];
  }
}

export async function getMarketNews() {
  try {
    const articles = [];
    try {
      const { data } = await axios.get('https://news.google.com/rss/search?q=stock+market+today&hl=en-US&gl=US&ceid=US:en', { timeout: 10000, headers: { 'User-Agent': 'StockOracle/1.0' } });
      parseRss(data).forEach(item => articles.push({ ...item, sentiment: scoreSentiment(item.title) }));
    } catch (e) { console.error('[News] Market news RSS error:', e.message); }
    return articles.slice(0, 20);
  } catch (err) {
    console.error('[News] Market news error:', err.message);
    return [];
  }
}
