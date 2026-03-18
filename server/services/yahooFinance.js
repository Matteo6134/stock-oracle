import YahooFinance from 'yahoo-finance2';
import axios from 'axios';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

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
    });

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
    });

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
  try {
    if (!symbols || symbols.length === 0) return [];
    
    // YahooFinance supports array of symbols for quote
    const result = await yf.quote(symbols);
    const quotes = Array.isArray(result) ? result : [result];

    return quotes.map(q => ({
      ...q,
      currentSessionPrice: getCurrentSessionPrice(q)
    }));
  } catch (err) {
    console.warn(`[YahooFinance] Batch quote error for ${symbols.length} symbols, falling back to individual calls:`, err.message);
    const results = await Promise.allSettled(symbols.map(s => getQuote(s)));
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  }
}

export async function getQuote(symbol) {
  try {
    const q = await yf.quote(symbol);
    if (!q) return {};
    return {
      ...q,
      currentSessionPrice: getCurrentSessionPrice(q)
    };
  } catch (err) {
    console.error(`[YahooFinance] Quote error ${symbol}:`, err.message);
    return {};
  }
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
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 45);
    try {
      const result = await yf.chart(symbol, {
        period1: start.toISOString().split('T')[0],
        period2: end.toISOString().split('T')[0],
        interval: '1d'
      });
      if (result?.quotes?.length > 0) {
        return result.quotes.map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }));
      }
    } catch (chartErr) {
      const result = await yf.historical(symbol, {
        period1: start.toISOString().split('T')[0],
        period2: end.toISOString().split('T')[0],
        interval: '1d'
      });
      return Array.isArray(result) ? result.map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume })) : [];
    }
    return [];
  } catch (err) {
    console.error(`[YahooFinance] History error ${symbol}:`, err.message);
    return [];
  }
}

export async function getDailyGainers() {
  try {
    const result = await yf.dailyGainers({ count: 10 });
    if (result?.quotes) {
      return result.quotes.map(q => ({ symbol: q.symbol, name: q.shortName || q.symbol, price: q.regularMarketPrice, change: q.regularMarketChangePercent }));
    }
    return [];
  } catch (err) {
    console.error('[YahooFinance] Daily gainers error:', err.message);
    return [];
  }
}
