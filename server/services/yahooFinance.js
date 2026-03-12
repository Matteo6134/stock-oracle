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

export async function getQuoteBatch(symbols) {
  try {
    if (!symbols || symbols.length === 0) return [];
    
    // YahooFinance supports array of symbols for quote
    const result = await yf.quote(symbols);
    
    // Ensure array return
    if (Array.isArray(result)) return result;
    if (result) return [result];
    return [];
  } catch (err) {
    console.warn(`[YahooFinance] Batch quote error for ${symbols.length} symbols, falling back to individual calls:`, err.message);
    // Fallback to individual
    const results = await Promise.allSettled(symbols.map(s => getQuote(s)));
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  }
}

export async function getQuote(symbol) {
  try {
    return (await yf.quote(symbol)) || {};
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
