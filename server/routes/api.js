import express from 'express';
import * as yahooFinance from '../services/yahooFinance.js';
import { getRedditSentiment } from '../services/reddit.js';
import { getStockTwitsSentiment, getTrending as getStockTwitsTrending } from '../services/stocktwits.js';
import { getNewsForStock, getMarketNews } from '../services/news.js';
import { calculateScore } from '../services/scorer.js';
import { checkAvailability } from '../services/brokerAvailability.js';
import { classifySector, getSectorTrends, SECTOR_REPS } from '../services/sectorAnalysis.js';
import { saveDailyPicks, getHistoryWithPerformance } from '../services/history.js';

const router = express.Router();

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 min for scored data (was 30 min)
const PRICE_CACHE_TTL = 60 * 1000; // 1 min for live prices

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > (ttl || CACHE_TTL)) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ── Entry Signal Logic (Dynamic ATR-based) ──
function getEntrySignal(change, hasEarningsToday, history, currentPrice) {
  const pctChange = change || 0;
  
  // Calculate dynamic thresholds based on Average True Range (ATR)
  let atrPct = 4; // Default fallback ATR%
  
  if (history && history.length >= 14 && currentPrice > 0) {
    const period = 14;
    const recent = history.slice(-period - 1); // Get 15 days to calculate 14 TRs
    let trSum = 0;
    
    for (let i = 1; i < recent.length; i++) {
      const high = recent[i].high;
      const low = recent[i].low;
      const prevClose = recent[i-1].close;
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trSum += tr;
    }
    
    const atr = trSum / period;
    atrPct = (atr / currentPrice) * 100;
  }
  
  // Set thresholds based on ATR
  const tooLateThreshold = Math.max(8, atrPct * 2); 
  const riskyThreshold = Math.max(4, atrPct);
  const dipThreshold = Math.min(-5, -atrPct * 1.5);
  
  if (pctChange > tooLateThreshold) {
    return { signal: 'too_late', label: 'Too Late', reason: `Already up +${pctChange.toFixed(1)}% today (greater than 2x average volatility) — most of the move has happened` };
  }
  if (pctChange > riskyThreshold) {
    return { signal: 'risky', label: 'Risky Entry', reason: `Up +${pctChange.toFixed(1)}% today (high volatility move already), but catalyst may push higher` };
  }
  if (pctChange < dipThreshold) {
    return { signal: 'caution', label: 'Dip Buy?', reason: `Down ${pctChange.toFixed(1)}% today — could be a dip-buy opportunity if catalyst is strong` };
  }
  if (hasEarningsToday) {
    return { signal: 'enter', label: 'Enter Now', reason: `Only ${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}% today — position before earnings report` };
  }
  return { signal: 'enter', label: 'Enter Now', reason: `Stock is ${pctChange >= 0 ? 'up only +' : ''}${pctChange.toFixed(1)}% today (normal range) — good entry point` };
}

// ── Trade Setup Calculator (Real Data Only) ──
// Uses ATR-based SHORT-TERM targets — not analyst 12-month targets
function calcTradeSetup(history, currentPrice, catalysts, quote) {
  if (!currentPrice || currentPrice <= 0) {
    return { available: false, reason: 'No price data available' };
  }

  const entryPrice = currentPrice;

  // ── Calculate ATR (14-period) ──
  let atr = null;
  if (history && history.length >= 15) {
    const period = 14;
    const recent = history.slice(-(period + 1));
    let trSum = 0;
    for (let i = 1; i < recent.length; i++) {
      const high = recent[i].high || 0;
      const low = recent[i].low || 0;
      const prevClose = recent[i - 1].close || 0;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    atr = trSum / period;
  }

  // Fallback ATR estimate if not enough history
  if (!atr || atr <= 0) {
    atr = currentPrice * 0.025; // assume ~2.5% daily range
  }

  // ── Target Price (SHORT-TERM, based on ATR) ──
  // For earnings plays: expect 2x ATR move (earnings gap + momentum)
  // For normal setups: expect 1.5x ATR move (swing trade)
  const hasEarnings = (catalysts || []).some(c => c.type === 'earnings' && c.daysAway <= 2);
  const targetMultiplier = hasEarnings ? 2.0 : 1.5;
  let targetPrice = Math.round((currentPrice + atr * targetMultiplier) * 100) / 100;
  let targetSource = hasEarnings
    ? `ATR × ${targetMultiplier} (earnings momentum)`
    : `ATR × ${targetMultiplier} (swing target)`;

  // ── Stop Loss (ATR-based, tight) ──
  // Primary: 1.5x ATR below entry (standard risk management)
  let stopLoss = Math.round((currentPrice - atr * 1.5) * 100) / 100;
  let stopSource = 'ATR × 1.5 below entry';

  // Validate against 20-day swing low — if swing low is HIGHER than ATR stop,
  // use it as a tighter stop (more conservative)
  if (history && history.length >= 5) {
    const lookback = history.slice(-20);
    const lows = lookback.map(d => d.low || d.close || Infinity).filter(v => v > 0 && v < Infinity);
    if (lows.length > 0) {
      const swingLow = Math.min(...lows);
      if (swingLow > 0 && swingLow < currentPrice && swingLow > stopLoss) {
        // Swing low is a tighter, better stop
        stopLoss = Math.round(swingLow * 100) / 100;
        stopSource = `${lookback.length}-day swing low`;
      }
    }
  }

  // Ensure stop is below entry and target is above entry
  if (stopLoss >= entryPrice) stopLoss = Math.round(entryPrice * 0.97 * 100) / 100;
  if (targetPrice <= entryPrice) targetPrice = Math.round(entryPrice * 1.02 * 100) / 100;

  // ── Risk/Reward ──
  const risk = entryPrice - stopLoss;
  const reward = targetPrice - entryPrice;
  const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0;

  // ── Risk Level (honest assessment) ──
  let riskLevel, riskLabel;
  if (riskReward >= 2.0) {
    riskLevel = 'secure';
    riskLabel = 'Low Risk — Strong setup';
  } else if (riskReward >= 1.3) {
    riskLevel = 'moderate';
    riskLabel = 'Moderate — Acceptable risk/reward';
  } else if (riskReward >= 0.8) {
    riskLevel = 'caution';
    riskLabel = 'Caution — Tight risk/reward';
  } else {
    riskLevel = 'risky';
    riskLabel = 'High Risk — Consider skipping';
  }

  // Analyst long-term target (side info only, NOT used for trade target)
  const analystCat = (catalysts || []).find(c => c.type === 'target_price');
  const analystTarget = analystCat ? Math.round(analystCat.targetPrice * 100) / 100 : null;

  return {
    available: true,
    entryPrice,
    targetPrice,
    stopLoss,
    riskReward,
    riskLevel,
    riskLabel,
    targetSource,
    stopSource,
    potentialGain: Math.round((reward / entryPrice) * 10000) / 100,
    potentialLoss: Math.round((risk / entryPrice) * 10000) / 100,
    atr: Math.round(atr * 100) / 100,
    analystTarget, // long-term reference only
  };
}

// ── Shared Symbol Scoring Helper (Individual) ──
async function scoreSymbol(symbol, earningsCalendar) {
  const [quote, history, catalysts, reddit, stocktwits, news] = await Promise.allSettled([
    yahooFinance.getQuote(symbol),
    yahooFinance.getHistoricalData(symbol),
    yahooFinance.getUpcomingCatalysts(symbol),
    getRedditSentiment(symbol),
    getStockTwitsSentiment(symbol),
    getNewsForStock(symbol, '')
  ]);

  const quoteData = quote.status === 'fulfilled' ? quote.value : {};
  const catalystList = catalysts.status === 'fulfilled' ? catalysts.value : [];
  const earningsEntry = earningsCalendar.find(e => (e.symbol || e.ticker) === symbol);

  const stockData = {
    symbol,
    quote: quoteData,
    history: history.status === 'fulfilled' ? history.value : [],
    reddit: reddit.status === 'fulfilled' ? reddit.value : { mentions: 0, sentiment: 0, topPosts: [] },
    stocktwits: stocktwits.status === 'fulfilled' ? stocktwits.value : { bullish: 0, bearish: 0, total: 0, sentiment: 0 },
    news: news.status === 'fulfilled' ? news.value : [],
    hasEarningsToday: !!earningsEntry?.isToday,
    hasEarningsTomorrow: !!earningsEntry?.isTomorrow,
    catalysts: catalystList,
    brokerAvailability: checkAvailability(symbol),
    sector: classifySector(symbol, quoteData?.shortName || '')
  };

  const score = calculateScore(stockData);

  // Build catalyst labels
  const upcomingEvents = [];
  if (earningsEntry?.isToday) upcomingEvents.push('Earnings TODAY');
  else if (earningsEntry?.isTomorrow) upcomingEvents.push('Earnings TOMORROW');
  catalystList.forEach(c => {
    if (c.type === 'earnings' && !earningsEntry) upcomingEvents.push(c.label);
    if (c.type === 'dividend') upcomingEvents.push(c.label);
    if (c.type === 'target_price') upcomingEvents.push(c.label);
  });

  const analystData = catalystList.find(c => c.type === 'analyst');
  const change = quoteData?.regularMarketChangePercent || 0;
  const currentPrice = quoteData?.regularMarketPrice || 0;
  const entry = getEntrySignal(change, stockData.hasEarningsToday || stockData.hasEarningsTomorrow, stockData.history, currentPrice);
  const tradeSetup = calcTradeSetup(stockData.history, currentPrice, catalystList, quoteData);

  return {
    symbol,
    companyName: quoteData?.shortName || quoteData?.longName || symbol,
    price: currentPrice || null,
    change,
    marketCap: quoteData?.marketCap || null,
    score: score.totalScore,
    breakdown: score.breakdown,
    confidence: score.confidence,
    probability: score.probability,
    sector: stockData.sector,
    hasEarningsToday: stockData.hasEarningsToday,
    hasEarningsTomorrow: stockData.hasEarningsTomorrow,
    upcomingEvents,
    analystBuyPct: analystData?.buyPercentage ? Math.round(analystData.buyPercentage * 100) : null,
    brokerAvailability: stockData.brokerAvailability,
    socialMentions: (stockData.reddit.mentions || 0) + (stockData.stocktwits.total || 0),
    newsCount: stockData.news.length,
    catalysts: catalystList,
    entrySignal: entry.signal,
    entryLabel: entry.label,
    entryReason: entry.reason,
    tradeSetup,
    // Keep raw data for detail routes
    _social: { reddit: stockData.reddit, stocktwits: stockData.stocktwits },
    _news: stockData.news,
    _history: stockData.history,
    _volume: quoteData?.regularMarketVolume || null
  };
}

// Sectors to exclude from predictions
const EXCLUDED_SECTORS = new Set(['Crypto', 'Cannabis']);

// ── Batch Scoring Helper ──
async function scoreSymbols(symbols, earningsCalendar, opts = { light: false }) {
  if (!symbols || symbols.length === 0) return [];
  
  // 1. Fetch all quotes in one batch call
  const quotes = await yahooFinance.getQuoteBatch(symbols);
  const quoteMap = new Map();
  quotes.forEach(q => {
    if (q && q.symbol) quoteMap.set(q.symbol, q);
  });

  // 2. Fetch rest of data in parallel for each symbol
  const scoredData = await Promise.allSettled(
    symbols.map(async (symbol) => {
      try {
        const quoteData = quoteMap.get(symbol) || {};
        
        // Parallel fetch for remaining data
        const tasks = [
          yahooFinance.getHistoricalData(symbol),
          yahooFinance.getUpcomingCatalysts(symbol)
        ];
        
        // Skip social/news on light mode to speed up sector detail requests
        if (!opts.light) {
          tasks.push(
            getRedditSentiment(symbol),
            getStockTwitsSentiment(symbol),
            getNewsForStock(symbol, '')
          );
        }
        
        const results = await Promise.allSettled(tasks);
        
        const history = results[0].status === 'fulfilled' ? results[0].value : [];
        const catalystList = results[1].status === 'fulfilled' ? results[1].value : [];
        const reddit = (!opts.light && results[2].status === 'fulfilled') ? results[2].value : { mentions: 0, sentiment: 0, topPosts: [] };
        const stocktwits = (!opts.light && results[3].status === 'fulfilled') ? results[3].value : { bullish: 0, bearish: 0, total: 0, sentiment: 0 };
        const news = (!opts.light && results[4].status === 'fulfilled') ? results[4].value : [];
        
        const earningsEntry = earningsCalendar.find(e => (e.symbol || e.ticker) === symbol);

        const stockData = {
          symbol,
          quote: quoteData,
          history, reddit, stocktwits, news,
          hasEarningsToday: !!earningsEntry?.isToday,
          hasEarningsTomorrow: !!earningsEntry?.isTomorrow,
          catalysts: catalystList,
          brokerAvailability: checkAvailability(symbol),
          sector: classifySector(symbol, quoteData?.shortName || '')
        };

        const score = calculateScore(stockData);

        // Build catalyst labels
        const upcomingEvents = [];
        if (earningsEntry?.isToday) upcomingEvents.push('Earnings TODAY');
        else if (earningsEntry?.isTomorrow) upcomingEvents.push('Earnings TOMORROW');
        catalystList.forEach(c => {
          if (c.type === 'earnings' && !earningsEntry) upcomingEvents.push(c.label);
          if (c.type === 'dividend') upcomingEvents.push(c.label);
          if (c.type === 'target_price') upcomingEvents.push(c.label);
        });

        const analystData = catalystList.find(c => c.type === 'analyst');
        const change = quoteData?.regularMarketChangePercent || 0;
        const currentPrice = quoteData?.regularMarketPrice || 0;
        const entry = getEntrySignal(change, stockData.hasEarningsToday || stockData.hasEarningsTomorrow, history, currentPrice);
        const tradeSetup = calcTradeSetup(history, currentPrice, catalystList, quoteData);

        return {
          symbol,
          companyName: quoteData?.shortName || quoteData?.longName || symbol,
          price: currentPrice || null,
          change,
          marketCap: quoteData?.marketCap || null,
          score: score.totalScore,
          breakdown: score.breakdown,
          confidence: score.confidence,
          probability: score.probability,
          sector: stockData.sector,
          hasEarningsToday: stockData.hasEarningsToday,
          hasEarningsTomorrow: stockData.hasEarningsTomorrow,
          earningsTiming: earningsEntry?.timing || 'N/A',
          upcomingEvents,
          analystBuyPct: analystData?.buyPercentage ? Math.round(analystData.buyPercentage * 100) : null,
          brokerAvailability: stockData.brokerAvailability,
          socialMentions: (stockData.reddit.mentions || 0) + (stockData.stocktwits.total || 0),
          newsCount: stockData.news.length,
          catalysts: catalystList,
          entrySignal: entry.signal,
          entryLabel: entry.label,
          entryReason: entry.reason,
          tradeSetup,
          // Keep raw data for detail routes
          _social: { reddit: stockData.reddit, stocktwits: stockData.stocktwits },
          _news: stockData.news,
          _history: stockData.history,
          _volume: quoteData?.regularMarketVolume || null
        };
      } catch (err) {
        console.error(`[BatchScore] Error scoring ${symbol}:`, err.message);
        return null;
      }
    })
  );
  
  const results = scoredData
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  // Filter out excluded sectors (Crypto, Cannabis) unless explicitly requested
  if (!opts.includeAllSectors) {
    return results.filter(r => !EXCLUDED_SECTORS.has(r.sector));
  }
  return results;
}

// ══════════════════════════════════════════
// /api/predictions — Today's top 10 picks
// ══════════════════════════════════════════
router.get('/predictions', async (req, res, next) => {
  try {
    const cached = getCached('predictions');
    if (cached) return res.json(cached);

    console.log('[Predictions] Generating forward-looking predictions...');

    const [earningsCalendar, trendingStocks] = await Promise.all([
      yahooFinance.getEarningsCalendar(),
      yahooFinance.getTrendingStocks()
    ]);

    const earningsSymbols = earningsCalendar.map(e => e.symbol || e.ticker);
    const trendingSymbols = trendingStocks.map(t => t.symbol || t);
    const majorStocks = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD',
      'JPM', 'BAC', 'V', 'NFLX', 'DIS', 'PFE', 'LLY', 'UNH'
    ];

    const symbolSet = new Set();
    earningsSymbols.slice(0, 15).forEach(s => symbolSet.add(s));
    trendingSymbols.slice(0, 10).forEach(s => symbolSet.add(s));
    majorStocks.forEach(s => symbolSet.add(s));
    const symbols = Array.from(symbolSet).slice(0, 25);

    const scored = await scoreSymbols(symbols, earningsCalendar);

    const predictions = scored
      .map(v => {
        // Strip internal fields for list response
        const { _social, _news, _history, _volume, ...clean } = v;
        return clean;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const result = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      earningsCount: earningsSymbols.length,
      predictions
    };

    console.log(`[Predictions] Done: ${predictions.length} picks (${earningsSymbols.length} earnings found)`);
    saveDailyPicks('trending', predictions);
    setCache('predictions', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════
// /api/tomorrow — Stocks to buy for tomorrow
// ══════════════════════════════════════════
router.get('/tomorrow', async (req, res, next) => {
  try {
    const cached = getCached('tomorrow');
    if (cached) return res.json(cached);

    console.log('[Tomorrow] Finding stocks for tomorrow\'s catalysts...');

    const earningsCalendar = await yahooFinance.getEarningsCalendar();

    // Stocks with earnings TOMORROW
    const tomorrowEarnings = earningsCalendar.filter(e => e.isTomorrow);
    const tomorrowSymbols = tomorrowEarnings.map(e => e.symbol || e.ticker);

    // Also scan major stocks for catalysts with daysAway === 1
    const majorStocks = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD',
      'JPM', 'BAC', 'V', 'NFLX', 'DIS', 'PFE', 'LLY', 'UNH',
      'UBER', 'ORCL', 'CRM', 'ADBE', 'COIN', 'PLTR'
    ];

    const symbolSet = new Set(tomorrowSymbols);

    // Scan majors for tomorrow catalysts
    const majorScans = await Promise.allSettled(
      majorStocks.filter(s => !symbolSet.has(s)).map(async (symbol) => {
        try {
          const cats = await yahooFinance.getUpcomingCatalysts(symbol);
          const hasTomorrow = cats.some(c => c.daysAway === 1);
          return hasTomorrow ? symbol : null;
        } catch { return null; }
      })
    );
    majorScans.filter(r => r.status === 'fulfilled' && r.value).forEach(r => symbolSet.add(r.value));

    const symbols = Array.from(symbolSet).slice(0, 20);
    console.log(`[Tomorrow] Scoring ${symbols.length} stocks (${tomorrowSymbols.length} with earnings tomorrow)...`);

    const scoredData = await scoreSymbols(symbols, earningsCalendar);

    const predictions = scoredData
      .map((result) => {
        // Build tomorrow-specific reason
        const reasons = [];
        if (result.hasEarningsTomorrow) reasons.push('Earnings report scheduled for tomorrow');
        result.catalysts.forEach(c => {
          if (c.type === 'dividend' && c.daysAway === 1) reasons.push('Ex-dividend date tomorrow');
          if (c.type === 'target_price') reasons.push(c.label);
          if (c.type === 'analyst' && c.buyPercentage >= 0.6)
            reasons.push(`${Math.round(c.buyPercentage * 100)}% analyst buy rating`);
        });

        const { _social, _news, _history, _volume, ...clean } = result;
        return {
          ...clean,
          reason: reasons.length > 0 ? reasons.join('. ') + '.' : 'Momentum play heading into tomorrow.'
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const result = {
      date: new Date().toISOString().split('T')[0],
      tomorrowDate: tomorrow.toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      predictions
    };

    console.log(`[Tomorrow] Done: ${predictions.length} picks`);
    saveDailyPicks('tomorrow', predictions);
    setCache('tomorrow', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════
// /api/stock/:symbol — Detailed stock view
// ══════════════════════════════════════════
router.get('/stock/:symbol', async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const cacheKey = `stock_${symbol}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const earningsCalendar = await yahooFinance.getEarningsCalendar();
    const scored = await scoreSymbol(symbol, earningsCalendar);

    const result = {
      ...scored,
      volume: scored._volume,
      social: scored._social,
      news: scored._news.slice(0, 10),
      history: scored._history
    };
    delete result._social;
    delete result._news;
    delete result._history;
    delete result._volume;

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════
// /api/history — Historical performance of predictions
// ══════════════════════════════════════════════════════
router.get('/history', async (req, res, next) => {
  try {
    const history = await getHistoryWithPerformance();
    res.json(history);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════
// /api/sectors — Sector heatmap overview
// ══════════════════════════════════════════
router.get('/sectors', async (req, res, next) => {
  try {
    const cached = getCached('sectors');
    if (cached) return res.json(cached);

    const sectorTrends = await getSectorTrends();
    const result = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      sectors: sectorTrends
    };

    setCache('sectors', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════
// /api/sectors/:sectorName — Sector detail
// ══════════════════════════════════════════
router.get('/sectors/:sectorName', async (req, res, next) => {
  try {
    const sectorName = decodeURIComponent(req.params.sectorName);
    const cacheKey = `sector_detail_${sectorName}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    // Find matching sector (case-insensitive)
    const sectorKey = Object.keys(SECTOR_REPS).find(
      k => k.toLowerCase() === sectorName.toLowerCase()
    );
    if (!sectorKey) {
      return res.status(404).json({ error: `Sector "${sectorName}" not found` });
    }

    const symbols = SECTOR_REPS[sectorKey];
    console.log(`[SectorDetail] Scoring ${symbols.length} stocks for ${sectorKey}...`);

    const earningsCalendar = await yahooFinance.getEarningsCalendar();

    // Use light scoring for sectors (skip social/news) to speed up response
    const scoredData = await scoreSymbols(symbols, earningsCalendar, { light: true, includeAllSectors: true });

    const stocks = scoredData
      .map((result) => {
        // Build "why invest" reason
        const reasons = [];
        if (result.hasEarningsToday) reasons.push('Earnings report today');
        if (result.hasEarningsTomorrow) reasons.push('Earnings report tomorrow');
        result.catalysts.forEach(c => {
          if (c.type === 'target_price') reasons.push(c.label);
          if (c.type === 'analyst' && c.buyPercentage >= 0.6)
            reasons.push(`${Math.round(c.buyPercentage * 100)}% analyst buy rating`);
          if (c.type === 'dividend' && c.daysAway <= 3) reasons.push(c.label);
        });
        if (result.socialMentions > 10) reasons.push(`High social buzz (${result.socialMentions} mentions)`);

        const { _social, _news, _history, _volume, ...clean } = result;
        return {
          ...clean,
          reason: reasons.length > 0
            ? reasons.join('. ') + '.'
            : 'Solid sector representative with stable fundamentals.'
        };
      })
      .sort((a, b) => b.score - a.score);

    const result = {
      sector: sectorKey,
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      stockCount: stocks.length,
      stocks
    };

    console.log(`[SectorDetail] Done: ${stocks.length} stocks for ${sectorKey}`);
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════
// /api/prices — Lightweight live price quotes
// ══════════════════════════════════════════
router.get('/prices', async (req, res, next) => {
  try {
    const symbolsParam = req.query.symbols || '';
    const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) return res.json({ prices: {} });

    const cacheKey = `prices_${symbols.sort().join(',')}`;
    const cached = getCached(cacheKey, PRICE_CACHE_TTL);
    if (cached) return res.json(cached);

    const quotes = await yahooFinance.getQuoteBatch(symbols);

    const prices = {};
    quotes.forEach((q) => {
      if (q && q.symbol) {
        const d = q;
        const change = d.regularMarketChangePercent || 0;
        // Don't have history for live price update, use fallback thresholds
        const entry = getEntrySignal(change, false, null, d.regularMarketPrice);
        prices[d.symbol] = {
          price: d.regularMarketPrice || null,
          change,
          volume: d.regularMarketVolume || null,
          entrySignal: entry.signal,
          entryLabel: entry.label,
          entryReason: entry.reason
        };
      }
    });

    const result = { prices, updatedAt: new Date().toISOString() };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════
// /api/trending — Trending stocks
// ══════════════════════════════════════════
router.get('/trending', async (req, res, next) => {
  try {
    const cached = getCached('trending');
    if (cached) return res.json(cached);

    const [yahooTrending, stocktwitsTrending, marketNews] = await Promise.allSettled([
      yahooFinance.getTrendingStocks(),
      getStockTwitsTrending(),
      getMarketNews()
    ]);

    const symbolCounts = {};
    const addSymbol = (symbol, source) => {
      if (!symbol) return;
      const s = symbol.toUpperCase();
      if (!symbolCounts[s]) symbolCounts[s] = { symbol: s, sources: [], count: 0 };
      if (!symbolCounts[s].sources.includes(source)) symbolCounts[s].sources.push(source);
      symbolCounts[s].count++;
    };

    (yahooTrending.status === 'fulfilled' ? yahooTrending.value : []).forEach(t => addSymbol(t.symbol || t, 'yahoo'));
    (stocktwitsTrending.status === 'fulfilled' ? stocktwitsTrending.value : []).forEach(t => addSymbol(t.symbol || t, 'stocktwits'));

    const trending = Object.values(symbolCounts)
      .sort((a, b) => b.sources.length - a.sources.length || b.count - a.count)
      .slice(0, 20);

    const result = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      trending,
      marketNews: (marketNews.status === 'fulfilled' ? marketNews.value : []).slice(0, 10)
    };

    setCache('trending', result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
