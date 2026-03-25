import YahooFinance from 'yahoo-finance2';
import axios from 'axios';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
  validation: { logErrors: false, logOptionsErrors: false },
});

// ── FINNHUB as primary data source (Yahoo blocked on Railway) ──
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// Rate limiter: Finnhub free = 60 calls/min
let finnhubCallCount = 0;
let finnhubResetTime = Date.now() + 60000;

async function finnhubThrottle() {
  const now = Date.now();
  if (now > finnhubResetTime) {
    finnhubCallCount = 0;
    finnhubResetTime = now + 60000;
  }
  if (finnhubCallCount >= 55) { // Leave 5 buffer
    const waitMs = finnhubResetTime - now + 100;
    await new Promise(r => setTimeout(r, waitMs));
    finnhubCallCount = 0;
    finnhubResetTime = Date.now() + 60000;
  }
  finnhubCallCount++;
}

/**
 * Fetch quote via Finnhub (primary — works on Railway)
 */
async function fetchQuoteFinnhub(symbol) {
  if (!FINNHUB_KEY) return null;
  try {
    await finnhubThrottle();
    const { data } = await axios.get(`${FINNHUB_BASE}/quote`, {
      params: { symbol, token: FINNHUB_KEY },
      timeout: 8000,
    });
    if (!data || data.c === 0) return null; // No data
    return {
      symbol,
      shortName: symbol,
      regularMarketPrice: data.c || 0,         // Current price
      regularMarketChange: (data.c || 0) - (data.pc || 0),
      regularMarketChangePercent: data.pc ? ((data.c - data.pc) / data.pc) * 100 : 0,
      regularMarketVolume: 0,  // Finnhub quote doesn't include volume — we'll get it from candles
      regularMarketPreviousClose: data.pc || 0,
      regularMarketOpen: data.o || 0,
      regularMarketDayHigh: data.h || 0,
      regularMarketDayLow: data.l || 0,
      fiftyTwoWeekHigh: 0,
      fiftyTwoWeekLow: 0,
      marketCap: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch candles (OHLCV) via Finnhub — for historical data + volume
 */
async function fetchCandlesFinnhub(symbol, days = 45) {
  if (!FINNHUB_KEY) return [];
  try {
    await finnhubThrottle();
    const to = Math.floor(Date.now() / 1000);
    const from = to - (days * 86400);
    const { data } = await axios.get(`${FINNHUB_BASE}/stock/candle`, {
      params: { symbol, resolution: 'D', from, to, token: FINNHUB_KEY },
      timeout: 10000,
    });
    if (data.s !== 'ok' || !data.t?.length) return [];
    return data.t.map((ts, i) => ({
      date: new Date(ts * 1000),
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v[i],
    }));
  } catch {
    return [];
  }
}

/**
 * Enrich Finnhub quote with volume from candles (single extra call)
 */
async function enrichFinnhubQuote(quote) {
  if (!quote || !FINNHUB_KEY) return quote;
  try {
    const candles = await fetchCandlesFinnhub(quote.symbol, 2);
    if (candles.length > 0) {
      const latest = candles[candles.length - 1];
      quote.regularMarketVolume = latest.volume || 0;
      // Calculate avg volume from candles
      const totalVol = candles.reduce((s, c) => s + c.volume, 0);
      quote.averageDailyVolume10Day = totalVol / candles.length;
    }
  } catch {}
  return quote;
}

// Configure yahoo-finance2 to handle Railway/cloud IP blocks
// Set longer timeouts and custom fetch options
try {
  yf.setGlobalConfig({
    queue: {
      concurrency: 2,      // Limit concurrent requests
      intervalCap: 3,       // Max 3 requests per interval
      interval: 2000,       // 2 second interval
      timeout: 15000,       // 15 sec timeout
    },
  });
} catch (e) {
  // Older versions may not support setGlobalConfig
}

/**
 * Fallback: fetch quote via Yahoo Finance v8 API directly with axios
 * when the yahoo-finance2 library fails (common on cloud servers)
 */
async function fetchQuoteDirect(symbol) {
  // Try multiple Yahoo endpoints — Railway IPs get blocked intermittently
  const endpoints = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const result = data?.chart?.result?.[0];
      if (!result) continue; // Try next endpoint

      const meta = result.meta || {};
      const close = result.indicators?.quote?.[0]?.close;
      const lastClose = close?.filter(Boolean).pop();

      return {
        symbol: meta.symbol || symbol,
        shortName: meta.shortName || symbol,
        regularMarketPrice: meta.regularMarketPrice || lastClose || 0,
        regularMarketChange: meta.regularMarketPrice && meta.chartPreviousClose
          ? meta.regularMarketPrice - meta.chartPreviousClose : 0,
        regularMarketChangePercent: meta.regularMarketPrice && meta.chartPreviousClose
          ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
        regularMarketVolume: meta.regularMarketVolume || 0,
        regularMarketPreviousClose: meta.chartPreviousClose || meta.previousClose || 0,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || 0,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow || 0,
        marketCap: (meta.regularMarketPrice || 0) * (meta.sharesOutstanding || 0),
      };
    } catch {
      continue; // Try next endpoint
    }
  }
  return null; // All endpoints failed
}

/**
 * Fallback: fetch historical data directly when yahoo-finance2 fails
 */
async function fetchHistoryDirect(symbol, days = 45) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - (days * 86400);
  const endpoints = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`,
  ];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const result = data?.chart?.result?.[0];
      if (!result?.timestamp) continue;

    const timestamps = result.timestamp;
    const q = result.indicators?.quote?.[0] || {};
    return timestamps.map((ts, i) => ({
      date: new Date(ts * 1000),
      open: q.open?.[i] || 0,
      high: q.high?.[i] || 0,
      low: q.low?.[i] || 0,
      close: q.close?.[i] || 0,
      volume: q.volume?.[i] || 0,
    })).filter(d => d.close > 0);
    } catch {
      continue; // Try next endpoint
    }
  }
  return []; // All endpoints failed
}

// ── Earnings calendar cache ──
let earningsCache = { data: [], timestamp: 0 };
const EARNINGS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let inflightEarningsPromise = null;

/**
 * Fetch earnings calendar for today AND tomorrow.
 * Returns stocks with UPCOMING earnings so user can position BEFORE the move.
 */
export async function getEarningsCalendar() {
  if (earningsCache.data.length > 0 && (Date.now() - earningsCache.timestamp) < EARNINGS_CACHE_TTL) {
    return earningsCache.data;
  }
  
  if (inflightEarningsPromise) {
    return inflightEarningsPromise;
  }

  inflightEarningsPromise = (async () => {
    try {
      const tickers = [];
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const todayStr = today.toISOString().split('T')[0];
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      const dates = [todayStr, tomorrowStr];

      for (const dateStr of dates) {
        try {
          const url = `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`;
          const { data } = await axios.get(url, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/plain, */*'
            }
          });

          if (data && data.data && data.data.rows) {
            data.data.rows.forEach(row => {
              if (row && row.symbol && !tickers.find(t => t.symbol === row.symbol)) {
                let timingLabel = 'N/A';
                if (row.time === 'time-pre-market') timingLabel = 'BMO';
                if (row.time === 'time-after-hours') timingLabel = 'AMC';

                tickers.push({
                  symbol: row.symbol,
                  ticker: row.symbol,
                  earningsDate: dateStr,
                  isToday: dateStr === todayStr,
                  isTomorrow: dateStr === tomorrowStr,
                  companyName: row.name || '',
                  timing: timingLabel
                });
              }
            });
          }
        } catch (err) {
          console.error(`[EarningsCalendar] Error fetching Nasdaq for ${dateStr}:`, err.message);
        }
      }

      console.log(`[EarningsCalendar] Found ${tickers.length} earnings (today+tomorrow) across Nasdaq APIs`);
      earningsCache = { data: tickers, timestamp: Date.now() };
      return tickers;
    } finally {
      inflightEarningsPromise = null;
    }
  })();

  return inflightEarningsPromise;
}

/**
 * Get upcoming catalysts for a stock using quoteSummary.
 * Returns earnings date, ex-dividend date, and other events.
 */
/**
 * Fetch historical earnings data for a symbol.
 * Returns EPS beat streak, SUE, and revision momentum.
 */
export async function getEarningsHistory(symbol) {
  try {
    const summary = await yf.quoteSummary(symbol, {
      modules: ['earnings', 'earningsHistory', 'earningsTrend']
    }, { validateResult: false });

    const result = {
      beatStreak: 0,          // consecutive quarters beating estimates
      avgSurprise: 0,         // average EPS surprise %
      sue: 0,                 // Standardized Unexpected Earnings
      revisionMomentum: 0,    // estimate revision direction (-1 to +1)
      quarterCount: 0,        // how many quarters of data we have
      recentSurprises: []     // last 4 quarters of surprise data
    };

    // --- EPS Beat Streak & Surprise History ---
    const hist = summary?.earningsHistory?.history || [];
    if (hist.length > 0) {
      result.quarterCount = hist.length;
      const surprises = [];
      let streak = 0;

      // hist is ordered oldest-to-newest typically, reverse to check streak from most recent
      const sorted = [...hist].sort((a, b) => {
        const da = a.quarter ? new Date(a.quarter) : 0;
        const db = b.quarter ? new Date(b.quarter) : 0;
        return db - da; // newest first
      });

      for (const q of sorted) {
        const actual = q.epsActual?.raw ?? q.epsActual;
        const estimate = q.epsEstimate?.raw ?? q.epsEstimate;
        if (actual != null && estimate != null) {
          const surprise = estimate !== 0 ? ((actual - estimate) / Math.abs(estimate)) * 100 : 0;
          surprises.push(surprise);
          result.recentSurprises.push({
            quarter: q.quarter,
            actual: typeof actual === 'number' ? actual : null,
            estimate: typeof estimate === 'number' ? estimate : null,
            surprisePct: Math.round(surprise * 100) / 100
          });
        }
      }

      // Beat streak: count consecutive beats from most recent
      for (const s of surprises) {
        if (s > 0) streak++;
        else break;
      }
      result.beatStreak = streak;

      // Average surprise
      if (surprises.length > 0) {
        result.avgSurprise = Math.round(
          (surprises.reduce((a, b) => a + b, 0) / surprises.length) * 100
        ) / 100;
      }

      // SUE = mean(surprise) / stddev(surprise)
      if (surprises.length >= 2) {
        const mean = surprises.reduce((a, b) => a + b, 0) / surprises.length;
        const variance = surprises.reduce((sum, s) => sum + (s - mean) ** 2, 0) / (surprises.length - 1);
        const stddev = Math.sqrt(variance);
        result.sue = stddev > 0 ? Math.round((mean / stddev) * 100) / 100 : 0;
      }
    }

    // --- Revenue Growth (from financialsChart quarterly data) ---
    const quarterlyFinancials = summary?.earnings?.financialsChart?.quarterly || [];
    let revenueGrowth = null;
    let epsBeat = result.beatStreak > 0; // most recent quarter beat

    if (quarterlyFinancials.length >= 2) {
      const mostRecent = quarterlyFinancials[quarterlyFinancials.length - 1];
      const previous = quarterlyFinancials[quarterlyFinancials.length - 2];
      const recentRev = mostRecent?.revenue?.raw ?? mostRecent?.revenue;
      const prevRev = previous?.revenue?.raw ?? previous?.revenue;
      if (recentRev != null && prevRev != null && prevRev > 0) {
        revenueGrowth = Math.round(((recentRev - prevRev) / prevRev) * 10000) / 100; // percentage
      }
    }
    result.revenueGrowth = revenueGrowth;

    // --- EPS vs Revenue combined signal ---
    const revenueGrew = revenueGrowth !== null && revenueGrowth > 0;
    if (epsBeat && revenueGrew) result.epsVsRevenue = 'both_beat';
    else if (epsBeat && !revenueGrew) result.epsVsRevenue = 'eps_only';
    else if (!epsBeat && revenueGrew) result.epsVsRevenue = 'revenue_only';
    else result.epsVsRevenue = 'both_miss';

    // --- Analyst Revision Momentum ---
    // earningsTrend has current quarter and next quarter estimates with revisions
    const trend = summary?.earningsTrend?.trend || [];
    if (trend.length > 0) {
      let totalRevision = 0;
      let revCount = 0;

      for (const period of trend) {
        const est = period.earningsEstimate;
        if (!est) continue;

        const current = est.avg?.raw ?? est.avg;
        const ago7 = est.yearAgoEps?.raw ?? est.yearAgoEps; // 7 days ago estimate
        const ago30 = period.epsTrend?.['30daysAgo']?.raw ?? period.epsTrend?.['30daysAgo'];
        const ago90 = period.epsTrend?.['90daysAgo']?.raw ?? period.epsTrend?.['90daysAgo'];

        // Check 30-day revision direction
        if (current != null && ago30 != null && ago30 !== 0) {
          const rev = (current - ago30) / Math.abs(ago30);
          totalRevision += rev;
          revCount++;
        } else if (current != null && ago90 != null && ago90 !== 0) {
          const rev = (current - ago90) / Math.abs(ago90);
          totalRevision += rev;
          revCount++;
        }

        // Also check number of up vs down revisions
        const numUp = period.epsTrend?.['7daysAgo']?.raw != null && current > period.epsTrend['7daysAgo'].raw ? 1 : 0;
        const numDown = period.epsTrend?.['7daysAgo']?.raw != null && current < period.epsTrend['7daysAgo'].raw ? 1 : 0;
        if (numUp || numDown) {
          totalRevision += (numUp - numDown) * 0.2;
          revCount++;
        }
      }

      if (revCount > 0) {
        // Normalize to -1 to +1 range
        result.revisionMomentum = Math.max(-1, Math.min(1,
          Math.round((totalRevision / revCount) * 100) / 100
        ));
      }
    }

    return result;
  } catch (err) {
    return {
      beatStreak: 0, avgSurprise: 0, sue: 0, revisionMomentum: 0,
      quarterCount: 0, recentSurprises: [],
      revenueGrowth: null, epsVsRevenue: 'both_miss'
    };
  }
}

export async function getUpcomingCatalysts(symbol) {
  try {
    const summary = await yf.quoteSummary(symbol, {
      modules: ['calendarEvents', 'earnings', 'financialData', 'recommendationTrend']
    }, { validateResult: false });

    const catalysts = [];
    const cal = summary?.calendarEvents;

    // Upcoming earnings date
    if (cal?.earnings?.earningsDate) {
      const dates = cal.earnings.earningsDate;
      const earningsDate = Array.isArray(dates) ? dates[0] : dates;
      if (earningsDate) {
        const ed = new Date(earningsDate);
        const now = new Date();
        const diffDays = Math.ceil((ed - now) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays <= 7) {
          catalysts.push({
            type: 'earnings',
            date: earningsDate,
            daysAway: diffDays,
            label: diffDays === 0 ? 'Earnings TODAY' : diffDays === 1 ? 'Earnings TOMORROW' : `Earnings in ${diffDays} days`,
            epsEstimate: cal.earnings.earningsAverage || null,
            revenueEstimate: cal.earnings.revenueAverage || null,
          });
        }
      }
    }

    // Ex-dividend date
    if (cal?.exDividendDate) {
      const exDiv = new Date(cal.exDividendDate);
      const now = new Date();
      const diffDays = Math.ceil((exDiv - now) / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays <= 7) {
        catalysts.push({
          type: 'dividend',
          date: cal.exDividendDate,
          daysAway: diffDays,
          label: diffDays === 0 ? 'Ex-Dividend TODAY' : `Ex-Dividend in ${diffDays} days`,
          dividendRate: cal.dividendRate || null,
        });
      }
    }

    // Analyst recommendations trend
    const rec = summary?.recommendationTrend?.trend?.[0];
    if (rec) {
      const totalRec = (rec.strongBuy || 0) + (rec.buy || 0) + (rec.hold || 0) + (rec.sell || 0) + (rec.strongSell || 0);
      const buyPct = totalRec > 0 ? ((rec.strongBuy || 0) + (rec.buy || 0)) / totalRec : 0;
      catalysts.push({
        type: 'analyst',
        label: `${Math.round(buyPct * 100)}% Buy rating`,
        strongBuy: rec.strongBuy || 0,
        buy: rec.buy || 0,
        hold: rec.hold || 0,
        sell: rec.sell || 0,
        buyPercentage: buyPct
      });
    }

    // Financial data signals
    const fin = summary?.financialData;
    if (fin) {
      if (fin.targetMeanPrice && fin.currentPrice) {
        const upside = ((fin.targetMeanPrice - fin.currentPrice) / fin.currentPrice) * 100;
        if (upside > 10) {
          catalysts.push({
            type: 'target_price',
            label: `Analyst target $${fin.targetMeanPrice.toFixed(0)} (+${upside.toFixed(0)}% upside)`,
            targetPrice: fin.targetMeanPrice,
            currentPrice: fin.currentPrice,
            upside: Math.round(upside)
          });
        }
      }
    }

    return catalysts;
  } catch (err) {
    // Silently fail for individual stock lookups
    return [];
  }
}

export function getCurrentSessionPrice(quote) {
  if (!quote) return 0;
  
  // Try to find the most "current" price based on market state
  const pre = quote.preMarketPrice;
  const post = quote.postMarketPrice;
  const reg = quote.regularMarketPrice;
  const state = quote.marketState; // e.g., 'PRE', 'REGULAR', 'POST', 'CLOSED'

  if (state === 'PRE' && pre) return pre;
  if ((state === 'POST' || state === 'CLOSED') && post) return post;
  return reg || pre || post || 0;
}

export async function getQuoteBatch(symbols) {
  if (!symbols || symbols.length === 0) return [];

  const allQuotes = [];

  // Strategy 1: Yahoo direct API (CONFIRMED WORKING on Railway, no rate limit)
  // Fetch all symbols via direct API with small delays
  let directSuccess = 0;
  for (const s of symbols) {
    const q = await fetchQuoteDirect(s);
    if (q?.regularMarketPrice > 0) {
      allQuotes.push({ ...q, currentSessionPrice: q.regularMarketPrice });
      directSuccess++;
    }
    // Small delay to avoid hammering Yahoo
    if (directSuccess % 10 === 0) await new Promise(r => setTimeout(r, 200));
  }

  if (directSuccess > 0) {
    console.log(`[YahooFinance] Direct API: ${directSuccess}/${symbols.length} quotes fetched`);
    return allQuotes;
  }

  // Strategy 2: Finnhub (backup — 60 calls/min, gets 429 on large batches)
  if (FINNHUB_KEY) {
    for (const s of symbols) {
      const q = await fetchQuoteFinnhub(s);
      if (q?.regularMarketPrice > 0) {
        allQuotes.push({ ...q, currentSessionPrice: q.regularMarketPrice });
      }
    }
    if (allQuotes.length > 0) {
      console.log(`[YahooFinance] Finnhub fallback: ${allQuotes.length}/${symbols.length} quotes`);
      return allQuotes;
    }
  }

  // Strategy 3: Yahoo library in chunks (last resort)
  const CHUNK_SIZE = 10;
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk = symbols.slice(i, i + CHUNK_SIZE);
    try {
      const result = await yf.quote(chunk, {}, { validateResult: false });
      const quotes = Array.isArray(result) ? result : [result];
      allQuotes.push(...quotes.filter(Boolean).map(q => ({ ...q, currentSessionPrice: getCurrentSessionPrice(q) })));
    } catch {}
    if (i + CHUNK_SIZE < symbols.length) await new Promise(r => setTimeout(r, 300));
  }

  return allQuotes;
}

export async function getQuote(symbol) {
  // 1. Yahoo direct API (CONFIRMED WORKING on Railway — fastest, no rate limit)
  const direct = await fetchQuoteDirect(symbol);
  if (direct?.regularMarketPrice > 0) {
    return { ...direct, currentSessionPrice: direct.regularMarketPrice };
  }

  // 2. Finnhub (backup — 60 calls/min limit, gets 429 when scanning many stocks)
  const fh = await fetchQuoteFinnhub(symbol);
  if (fh?.regularMarketPrice > 0) {
    return { ...fh, currentSessionPrice: fh.regularMarketPrice };
  }

  // 3. Yahoo library (fallback)
  try {
    const q = await yf.quote(symbol, {}, { validateResult: false });
    if (q) return { ...q, currentSessionPrice: getCurrentSessionPrice(q) };
  } catch {}

  return {};
}

export async function getTrendingStocks() {
  try {
    const result = await yf.trendingSymbols('US', { count: 20 });
    if (result && result.quotes) return result.quotes.map(q => ({ symbol: q.symbol, name: q.shortName || q.symbol }));
    if (Array.isArray(result)) return result.map(q => ({ symbol: q.symbol || q, name: q.shortName || q.symbol || q }));
    return [];
  } catch (err) {
    console.error('[YahooFinance] Trending error:', err.message);
    return [];
  }
}

export async function getHistoricalData(symbol) {
  try {
    // 1. Yahoo direct API (CONFIRMED WORKING on Railway)
    const direct = await fetchHistoryDirect(symbol, 45);
    if (direct.length > 5) return direct;

    // 2. Finnhub candles (backup — rate limited)
    const fhCandles = await fetchCandlesFinnhub(symbol, 45);
    if (fhCandles.length > 5) return fhCandles;

    // 3. Yahoo library (least reliable)
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 45);
    try {
      const result = await yf.chart(symbol, {
        period1: start.toISOString().split('T')[0],
        period2: end.toISOString().split('T')[0],
        interval: '1d'
      }, { validateResult: false });
      if (result?.quotes?.length > 0) {
        return result.quotes.map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
      }
    } catch {
      try {
        const result = await yf.historical(symbol, {
          period1: start.toISOString().split('T')[0],
          period2: end.toISOString().split('T')[0],
          interval: '1d'
        }, { validateResult: false });
        return Array.isArray(result) ? result.map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume })) : [];
      } catch {
        return [];
      }
    }
    return [];
  } catch (err) {
    console.error(`[YahooFinance] History error ${symbol}:`, err.message);
    return [];
  }
}

export async function getDailyGainers() {
  try {
    // dailyGainers is deprecated — use screener instead
    const result = await yf.screener({ scrIds: 'day_gainers', count: 10 }, { validateResult: false });
    const quotes = result?.quotes || result?.result?.[0]?.quotes || [];
    return quotes.map(q => ({ symbol: q.symbol, name: q.shortName || q.symbol, price: q.regularMarketPrice, change: q.regularMarketChangePercent }));
  } catch (err) {
    // If screener also fails, return empty (non-critical)
    return [];
  }
}

export async function searchStocks(query) {
  try {
    const results = await yf.search(query, {
      quotesCount: 8,
      newsCount: 0,
      enableFuzzyQuery: false,
      enableCb: false,
    });
    return (results.quotes || [])
      .filter(q => q.quoteType === 'EQUITY' && q.symbol && !q.symbol.includes('.'))
      .slice(0, 8)
      .map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        exchange: q.exchDisp || q.exchange || '',
      }));
  } catch (err) {
    console.error('[YahooFinance] Search error:', err.message);
    return [];
  }
}
