import { getQuote } from './yahooFinance.js';

const SECTOR_MAP = {
  'AAPL': 'Technology', 'MSFT': 'Technology', 'GOOGL': 'Technology', 'GOOG': 'Technology',
  'META': 'Technology', 'AMZN': 'Technology', 'NFLX': 'Technology', 'ADBE': 'Technology',
  'CRM': 'Technology', 'ORCL': 'Technology', 'CSCO': 'Technology', 'INTC': 'Technology',
  'AVGO': 'Technology', 'QCOM': 'Technology', 'TXN': 'Technology', 'IBM': 'Technology',
  'NVDA': 'AI/Robotics', 'AMD': 'AI/Robotics', 'PLTR': 'AI/Robotics', 'AI': 'AI/Robotics',
  'PATH': 'AI/Robotics', 'UPST': 'AI/Robotics', 'SOUN': 'AI/Robotics', 'U': 'AI/Robotics',
  'COIN': 'Crypto', 'MSTR': 'Crypto', 'MARA': 'Crypto', 'RIOT': 'Crypto', 'CLSK': 'Crypto',
  'JNJ': 'Healthcare', 'PFE': 'Healthcare', 'UNH': 'Healthcare', 'MRNA': 'Healthcare',
  'ABBV': 'Healthcare', 'LLY': 'Healthcare', 'BMY': 'Healthcare', 'MRK': 'Healthcare',
  'AMGN': 'Healthcare', 'GILD': 'Healthcare', 'VRTX': 'Healthcare', 'ISRG': 'Healthcare',
  'JPM': 'Finance', 'BAC': 'Finance', 'WFC': 'Finance', 'GS': 'Finance',
  'MS': 'Finance', 'V': 'Finance', 'MA': 'Finance', 'PYPL': 'Finance', 'BLK': 'Finance',
  'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'SLB': 'Energy', 'OXY': 'Energy', 'ENPH': 'Energy',
  'WMT': 'Consumer', 'COST': 'Consumer', 'NKE': 'Consumer', 'MCD': 'Consumer', 'DIS': 'Consumer',
  'KO': 'Consumer', 'PEP': 'Consumer', 'SBUX': 'Consumer', 'HD': 'Consumer',
  'CAT': 'Industrial', 'DE': 'Industrial', 'HON': 'Industrial', 'GE': 'Industrial', 'UPS': 'Industrial',
  'BA': 'Aerospace', 'LMT': 'Aerospace', 'RTX': 'Aerospace', 'NOC': 'Aerospace', 'GD': 'Aerospace',
  'TSLA': 'Technology', 'F': 'Industrial', 'GM': 'Industrial',
  'TLRY': 'Cannabis', 'CGC': 'Cannabis', 'ACB': 'Cannabis',
  'SOFI': 'Finance', 'AFRM': 'Finance', 'HOOD': 'Crypto'
};

const SECTOR_KEYWORDS = {
  'Technology': ['tech','software','cloud','digital','computing','internet','semiconductor'],
  'Healthcare': ['health','pharma','biotech','medical','therapeutic','drug','clinical'],
  'Finance': ['bank','financial','capital','investment','insurance','credit'],
  'Energy': ['energy','oil','gas','petroleum','solar','renewable','power'],
  'Consumer': ['retail','consumer','food','beverage','restaurant','entertainment'],
  'Industrial': ['industrial','manufacturing','construction','transport','logistics'],
  'Aerospace': ['aerospace','defense','space','aviation','military'],
  'AI/Robotics': ['artificial intelligence','robot','machine learning','autonomous'],
  'Cannabis': ['cannabis','marijuana','hemp'],
  'Crypto': ['crypto','bitcoin','blockchain','mining']
};

export function classifySector(symbol, companyName) {
  if (SECTOR_MAP[symbol.toUpperCase()]) return SECTOR_MAP[symbol.toUpperCase()];
  if (companyName) {
    const lower = companyName.toLowerCase();
    for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
      for (const kw of keywords) { if (lower.includes(kw)) return sector; }
    }
  }
  return 'Other';
}

const SECTOR_REPS = {
  'Technology': ['AAPL','MSFT','GOOGL','META','CRM','ADBE'],
  'AI/Robotics': ['NVDA','AMD','PLTR'],
  'Healthcare': ['JNJ','UNH','PFE','LLY','ABBV'],
  'Finance': ['JPM','BAC','GS','V','MA'],
  'Energy': ['XOM','CVX','COP','SLB'],
  'Consumer': ['WMT','COST','NKE','MCD','DIS'],
  'Industrial': ['CAT','HON','GE','UPS'],
  'Aerospace': ['BA','LMT','RTX','NOC'],
  'Cannabis': ['TLRY','CGC','ACB'],
  'Crypto': ['COIN','MSTR','MARA','RIOT']
};

export async function getSectorTrends() {
  try {
    const results = [];
    for (const [sector, symbols] of Object.entries(SECTOR_REPS)) {
      try {
        const quotes = (await Promise.allSettled(symbols.map(s => getQuote(s))))
          .filter(r => r.status === 'fulfilled' && r.value && r.value.regularMarketChangePercent !== undefined)
          .map(r => r.value);
        if (quotes.length === 0) { results.push({ sector, score: 50, avgChange: 0, topStocks: [], trend: 'neutral' }); continue; }
        const avgChange = quotes.reduce((s, q) => s + (q.regularMarketChangePercent || 0), 0) / quotes.length;
        const trend = avgChange > 1 ? 'bullish' : avgChange < -1 ? 'bearish' : 'neutral';
        const score = Math.round(50 + (Math.max(-5, Math.min(5, avgChange)) / 5) * 50);
        const topStocks = quotes.sort((a, b) => (b.regularMarketChangePercent || 0) - (a.regularMarketChangePercent || 0))
          .slice(0, 3).map(q => ({ symbol: q.symbol, name: q.shortName || q.symbol, price: q.regularMarketPrice, change: Math.round((q.regularMarketChangePercent || 0) * 100) / 100 }));
        results.push({ sector, score, avgChange: Math.round(avgChange * 100) / 100, topStocks, trend });
      } catch (err) { results.push({ sector, score: 50, avgChange: 0, topStocks: [], trend: 'neutral' }); }
    }
    return results.sort((a, b) => b.score - a.score);
  } catch (err) { return []; }
}

export { SECTOR_MAP, SECTOR_REPS };
