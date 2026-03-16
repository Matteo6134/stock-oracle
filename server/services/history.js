import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as yahooFinance from './yahooFinance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

// Ensure data directory exists
const dataDir = path.dirname(HISTORY_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Saves a daily prediction set for a given category (trending/tomorrow).
 */
export async function saveDailyPicks(category, predictions) {
  try {
    const today = new Date().toISOString().split('T')[0];
    let history = {};

    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }

    if (!history[today]) {
      history[today] = {};
    }

    // Don't overwrite existing picks
    if (history[today][category] && history[today][category].length > 0) {
      return;
    }

    history[today][category] = predictions.map(p => ({
      symbol: p.symbol || p.ticker,
      name: p.companyName || p.name || '',
      entryPrice: p.price || 0,
      reason: p.reason || '',
      score: p.score || 0,
      entrySignal: p.entrySignal || '',
      earningsTiming: p.earningsTiming || 'N/A',
      timestamp: new Date().toISOString()
    }));

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`[History] Saved ${predictions.length} ${category} picks for ${today}`);
  } catch (err) {
    console.error('[History] Save error:', err.message);
  }
}

/**
 * True next-day backtest.
 * For past picks: fetches the close price on the NEXT trading day
 * to prove whether the AI prediction was right or wrong.
 */
export async function getHistoryWithPerformance() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return { days: [], overall: { totalDays: 0, totalPicks: 0, totalCorrect: 0, winRate: null, avgPl: null } };
    }

    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const dates = Object.keys(history).sort((a, b) => new Date(b) - new Date(a));
    const today = new Date().toISOString().split('T')[0];

    // Collect all unique symbols
    const allSymbols = new Set();
    dates.forEach(date => {
      Object.values(history[date]).forEach(picks => {
        picks.forEach(p => allSymbols.add(p.symbol));
      });
    });

    // Batch fetch current prices (for live picks today)
    const latestData = await yahooFinance.getQuoteBatch(Array.from(allSymbols));
    const priceMap = {};
    latestData.forEach(q => {
      if (q && q.symbol) {
        priceMap[q.symbol] = {
          price: q.regularMarketPrice || 0,
          change: q.regularMarketChangePercent || 0
        };
      }
    });

    // Use a simple in-memory cache for historical bars to avoid spamming YF
    if (!global.histDataCache) global.histDataCache = new Map();
    const CACHE_DURATION = 12 * 60 * 60 * 1000; // 12 hours

    const historyDataMap = {};
    const symbolsToFetch = Array.from(allSymbols).filter(sym => {
      const cached = global.histDataCache.get(sym);
      if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        historyDataMap[sym] = cached.data;
        return false;
      }
      return true;
    });

    if (symbolsToFetch.length > 0) {
      console.log(`[History] Fetching history for ${symbolsToFetch.length} new symbols...`);
      const histResults = await Promise.allSettled(
        symbolsToFetch.map(async (symbol) => {
          const data = await yahooFinance.getHistoricalData(symbol);
          return { symbol, data };
        })
      );
      histResults.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
          const { symbol, data } = r.value;
          historyDataMap[symbol] = data || [];
          global.histDataCache.set(symbol, { data: data || [], timestamp: Date.now() });
        }
      });
    }

    // Build result for each day
    const days = dates.map(date => {
      const dayData = history[date];
      const isToday = date === today;
      const pickDate = new Date(date + 'T23:59:59Z'); // end of pick day

      const categories = Object.keys(dayData).map(catName => {
        const picks = dayData[catName].map(p => {
          if (isToday) {
            // Today's picks: show live running P/L
            const current = priceMap[p.symbol] || {};
            const currentPrice = current.price || p.entryPrice;
            const plPercent = p.entryPrice > 0
              ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
              : 0;

            return {
              ...p,
              currentPrice,
              plPercent: Math.round(plPercent * 100) / 100,
              status: 'live',
              verdict: null
            };
          }

          // Past picks: find next trading day close OR check if After-Hours already moved
          let current = priceMap[p.symbol] || {};
          let currentPrice = current.price || p.entryPrice;
          
          // If we have After-Hours/Pre-market data in priceMap, use that for "Instant" settling
          // if it's already a different session than the pick day
          const histData = historyDataMap[p.symbol] || [];
          let settlingPrice = null;
          let settlingSource = '';

          // 1. Look for next day close bar
          for (const bar of histData) {
            const barDate = new Date(bar.date);
            if (barDate > pickDate && bar.close) {
              settlingPrice = bar.close;
              settlingSource = 'Daily Close';
              break;
            }
          }

          // 2. If no next-day bar yet, but current price is after-hours/pre-market 
          // and we are past the pick day, treat it as settled for instant feedback
          if (!settlingPrice && current.currentSessionPrice && !isToday) {
            settlingPrice = current.currentSessionPrice;
            settlingSource = 'Extended Hours';
          }

          if (settlingPrice !== null && p.entryPrice > 0) {
            const plPercent = ((settlingPrice - p.entryPrice) / p.entryPrice) * 100;
            return {
              ...p,
              nextDayClose: Math.round(settlingPrice * 100) / 100,
              settlingSource,
              currentPrice: current.currentSessionPrice || settlingPrice,
              plPercent: Math.round(plPercent * 100) / 100,
              status: 'settled',
              verdict: plPercent > 0.1 ? 'correct' : plPercent < -0.1 ? 'wrong' : 'flat'
            };
          }

          // No next-day data (weekend/too recent)
          current = priceMap[p.symbol] || {};
          currentPrice = current.price || p.entryPrice;
          const plPercent = p.entryPrice > 0
            ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100
            : 0;

          return {
            ...p,
            currentPrice,
            plPercent: Math.round(plPercent * 100) / 100,
            status: 'pending',
            verdict: null
          };
        });

        // Category stats
        const settled = picks.filter(p => p.status === 'settled');
        const correct = settled.filter(p => p.verdict === 'correct').length;
        const wrong = settled.filter(p => p.verdict === 'wrong').length;
        const winRate = settled.length > 0 ? Math.round((correct / settled.length) * 100) : null;
        const avgPl = settled.length > 0
          ? Math.round(settled.reduce((sum, p) => sum + p.plPercent, 0) / settled.length * 100) / 100
          : null;

        return {
          category: catName,
          picks: picks.sort((a, b) => b.plPercent - a.plPercent),
          stats: { total: picks.length, settled: settled.length, correct, wrong, winRate, avgPl }
        };
      });

      // Day-level stats
      const allSettled = categories.flatMap(c => c.picks.filter(p => p.status === 'settled'));
      const dayCorrect = allSettled.filter(p => p.verdict === 'correct').length;
      const dayWinRate = allSettled.length > 0 ? Math.round((dayCorrect / allSettled.length) * 100) : null;
      const dayAvgPl = allSettled.length > 0
        ? Math.round(allSettled.reduce((sum, p) => sum + p.plPercent, 0) / allSettled.length * 100) / 100
        : null;

      return {
        date,
        isToday,
        categories,
        dayStats: { total: allSettled.length, correct: dayCorrect, winRate: dayWinRate, avgPl: dayAvgPl }
      };
    });

    // Overall stats across all past days
    const pastDays = days.filter(d => !d.isToday && d.dayStats.total > 0);
    const totalSettled = pastDays.reduce((s, d) => s + d.dayStats.total, 0);
    const totalCorrect = pastDays.reduce((s, d) => s + d.dayStats.correct, 0);
    const overallWinRate = totalSettled > 0 ? Math.round((totalCorrect / totalSettled) * 100) : null;
    const overallAvgPl = totalSettled > 0
      ? Math.round(pastDays.reduce((s, d) => s + (d.dayStats.avgPl || 0) * d.dayStats.total, 0) / totalSettled * 100) / 100
      : null;

    return {
      days,
      overall: {
        totalDays: pastDays.length,
        totalPicks: totalSettled,
        totalCorrect,
        winRate: overallWinRate,
        avgPl: overallAvgPl
      }
    };
  } catch (err) {
    console.error('[History] Get performance error:', err.message);
    return { days: [], overall: { totalDays: 0, totalPicks: 0, totalCorrect: 0, winRate: null, avgPl: null } };
  }
}
