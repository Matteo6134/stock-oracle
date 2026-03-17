import express from 'express';
import * as yahooFinance from '../services/yahooFinance.js';
import { getEarningsHistory } from '../services/yahooFinance.js';
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
function getEntrySignal(change, hasEarningsToday, history, currentPrice, quote) {
  const pctChange = change || 0;

  // Calculate dynamic thresholds based on Average True Range (ATR)
  let atrPct = 4; // Default fallback ATR%

  if (history && history.length >= 14 && currentPrice > 0) {
    const period = 14;
    const recent = history.slice(-period - 1);
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

  // ── Pre/Post Market Gap Check ──
  // If pre-market price is available, calculate TOTAL move (overnight + today)
  const q = quote || {};
  const prePrice = q.preMarketPrice;
  const postPrice = q.postMarketPrice;
  const prevClose = history && history.length > 0 ? history[history.length - 1]?.close : null;
  const marketState = q.marketState;

  let totalMovePct = pctChange; // default: just today's regular session change
  let preMarketNote = '';

  if (prePrice && prevClose && prevClose > 0) {
    const preGapPct = ((prePrice - prevClose) / prevClose) * 100;
    // Total move = pre-market gap + regular session move
    totalMovePct = pctChange + preGapPct;

    if (Math.abs(preGapPct) >= 1) {
      preMarketNote = ` (pre-market gap: ${preGapPct >= 0 ? '+' : ''}${preGapPct.toFixed(1)}%)`;
    }
  }

  // During pre-market: use pre-market price as the effective move
  if (marketState === 'PRE' && prePrice && prevClose && prevClose > 0) {
    totalMovePct = ((prePrice - prevClose) / prevClose) * 100;
    preMarketNote = ' (pre-market)';
  }

  // During after-hours: check after-hours move
  if ((marketState === 'POST' || marketState === 'CLOSED') && postPrice && currentPrice > 0) {
    const ahMove = ((postPrice - currentPrice) / currentPrice) * 100;
    if (Math.abs(ahMove) >= 2) {
      preMarketNote += ` (AH: ${ahMove >= 0 ? '+' : ''}${ahMove.toFixed(1)}%)`;
    }
  }

  // Use the LARGER of regular change or total move for "too late" detection
  const effectiveChange = Math.max(Math.abs(pctChange), Math.abs(totalMovePct)) * Math.sign(totalMovePct || pctChange);

  if (effectiveChange > tooLateThreshold) {
    return { signal: 'too_late', label: 'Too Late', reason: `Already up +${effectiveChange.toFixed(1)}% total${preMarketNote} — most of the move has happened` };
  }
  if (effectiveChange > riskyThreshold) {
    return { signal: 'risky', label: 'Risky Entry', reason: `Up +${effectiveChange.toFixed(1)}% total${preMarketNote} — high volatility move, but catalyst may push higher` };
  }
  if (effectiveChange < dipThreshold) {
    return { signal: 'caution', label: 'Dip Buy?', reason: `Down ${effectiveChange.toFixed(1)}% total${preMarketNote} — could be a dip-buy if catalyst is strong` };
  }
  if (hasEarningsToday) {
    return { signal: 'enter', label: 'Enter Now', reason: `Only ${effectiveChange >= 0 ? '+' : ''}${effectiveChange.toFixed(1)}% total${preMarketNote} — position before earnings report` };
  }
  return { signal: 'enter', label: 'Enter Now', reason: `Stock is ${effectiveChange >= 0 ? 'up ' : ''}${effectiveChange >= 0 ? '+' : ''}${effectiveChange.toFixed(1)}% total${preMarketNote} — good entry point` };
}

// ── Trade Setup Calculator v2 (Multi-Validated Targets) ──
// Cross-validates target with: resistance levels, Fibonacci, ATR, analyst consensus, earnings gaps
function calcTradeSetup(history, currentPrice, catalysts, quote, earningsHistory) {
  if (!currentPrice || currentPrice <= 0) {
    return { available: false, reason: 'No price data available' };
  }

  const h = history || [];
  const q = quote || {};

  // ── Pre/Post market price intelligence ──
  // Use the most current price as effective entry (pre-market during PRE, post during POST)
  const marketState = q.marketState;
  const prePrice = q.preMarketPrice;
  const postPrice = q.postMarketPrice;
  const prevClose = h.length > 0 ? h[h.length - 1]?.close : null;

  let entryPrice = currentPrice;
  let preMarketGapPct = 0;
  let entryNote = null;

  // During pre-market: if stock gapped, the actual entry will be at pre-market price
  if (marketState === 'PRE' && prePrice && prePrice > 0) {
    entryPrice = prePrice; // Use pre-market price as expected entry
    if (prevClose && prevClose > 0) {
      preMarketGapPct = ((prePrice - prevClose) / prevClose) * 100;
      entryNote = `Pre-market entry at $${prePrice.toFixed(2)} (gap ${preMarketGapPct >= 0 ? '+' : ''}${preMarketGapPct.toFixed(1)}% from prev close)`;
    }
  }

  // During after-hours: show AH price impact on setup
  if ((marketState === 'POST' || marketState === 'CLOSED') && postPrice && postPrice > 0) {
    const ahChangePct = ((postPrice - currentPrice) / currentPrice) * 100;
    if (Math.abs(ahChangePct) >= 1) {
      entryNote = `After-hours: $${postPrice.toFixed(2)} (${ahChangePct >= 0 ? '+' : ''}${ahChangePct.toFixed(1)}% from close)`;
    }
  }

  // ══════════════════════════════════════════
  // 1. CALCULATE ATR (14-period)
  // ══════════════════════════════════════════
  let atr = null;
  if (h.length >= 15) {
    const period = 14;
    const recent = h.slice(-(period + 1));
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
  if (!atr || atr <= 0) atr = currentPrice * 0.025;

  // ══════════════════════════════════════════
  // 2. FIND KEY RESISTANCE LEVELS (real price ceilings)
  // ══════════════════════════════════════════
  const resistanceLevels = [];
  if (h.length >= 10) {
    // a) Recent swing highs (local maxima in last 30 days)
    const lookback = h.slice(-30);
    for (let i = 1; i < lookback.length - 1; i++) {
      const prev = lookback[i - 1]?.high || 0;
      const curr = lookback[i]?.high || 0;
      const next = lookback[i + 1]?.high || 0;
      if (curr > prev && curr > next && curr > currentPrice) {
        resistanceLevels.push({ price: curr, type: 'swing_high', label: 'Swing High' });
      }
    }

    // b) 52-week / 20-day high
    const highs20 = h.slice(-20).map(d => d.high || 0).filter(v => v > 0);
    if (highs20.length > 0) {
      const high20 = Math.max(...highs20);
      if (high20 > currentPrice) {
        resistanceLevels.push({ price: high20, type: '20d_high', label: '20-Day High' });
      }
    }

    // c) Volume-weighted resistance (VWAP-like cluster)
    // Find price zones where heavy trading occurred above current price
    if (h.length >= 20) {
      const recentBars = h.slice(-20);
      const priceVolMap = {};
      recentBars.forEach(bar => {
        const midPrice = Math.round(((bar.high || 0) + (bar.low || 0)) / 2 * 100) / 100;
        if (midPrice > currentPrice) {
          const bucket = Math.round(midPrice / (atr * 0.5)) * (atr * 0.5); // bucket by half-ATR
          priceVolMap[bucket] = (priceVolMap[bucket] || 0) + (bar.volume || 0);
        }
      });
      const topBucket = Object.entries(priceVolMap).sort((a, b) => b[1] - a[1])[0];
      if (topBucket) {
        resistanceLevels.push({ price: parseFloat(topBucket[0]), type: 'volume_cluster', label: 'Volume Resistance' });
      }
    }
  }

  // Sort resistance levels by proximity to current price
  resistanceLevels.sort((a, b) => a.price - b.price);
  const nearestResistance = resistanceLevels[0] || null;

  // ══════════════════════════════════════════
  // 3. FIND KEY SUPPORT LEVELS (real price floors)
  // ══════════════════════════════════════════
  const supportLevels = [];
  if (h.length >= 10) {
    // a) Recent swing lows
    const lookback = h.slice(-30);
    for (let i = 1; i < lookback.length - 1; i++) {
      const prev = lookback[i - 1]?.low || Infinity;
      const curr = lookback[i]?.low || Infinity;
      const next = lookback[i + 1]?.low || Infinity;
      if (curr < prev && curr < next && curr < currentPrice && curr > 0) {
        supportLevels.push({ price: curr, type: 'swing_low', label: 'Swing Low' });
      }
    }

    // b) 20-day low
    const lows20 = h.slice(-20).map(d => d.low || Infinity).filter(v => v > 0 && v < Infinity);
    if (lows20.length > 0) {
      const low20 = Math.min(...lows20);
      if (low20 < currentPrice) {
        supportLevels.push({ price: low20, type: '20d_low', label: '20-Day Low' });
      }
    }
  }
  supportLevels.sort((a, b) => b.price - a.price); // nearest support first
  const nearestSupport = supportLevels[0] || null;

  // ══════════════════════════════════════════
  // 4. FIBONACCI RETRACEMENT LEVELS
  // ══════════════════════════════════════════
  let fibTargets = [];
  if (h.length >= 20) {
    const recent30 = h.slice(-30);
    const low30 = Math.min(...recent30.map(d => d.low || Infinity).filter(v => v > 0 && v < Infinity));
    const high30 = Math.max(...recent30.map(d => d.high || 0).filter(v => v > 0));

    if (high30 > low30 && low30 > 0) {
      const range = high30 - low30;
      // If stock is closer to the low (pullback), Fib extensions from low
      if (currentPrice < (low30 + high30) / 2) {
        // Bounce targets: 50%, 61.8%, 100% retracement
        fibTargets = [
          { level: 0.5, price: low30 + range * 0.5 },
          { level: 0.618, price: low30 + range * 0.618 },
          { level: 1.0, price: high30 },
        ].filter(f => f.price > currentPrice);
      } else {
        // Extension targets: 1.0 (high30), 1.272, 1.618 of the range
        fibTargets = [
          { level: 1.0, price: high30 },
          { level: 1.272, price: low30 + range * 1.272 },
          { level: 1.618, price: low30 + range * 1.618 },
        ].filter(f => f.price > currentPrice);
      }
    }
  }

  // ══════════════════════════════════════════
  // 5. EARNINGS GAP ANALYSIS (for earnings plays)
  // ══════════════════════════════════════════
  const hasEarnings = (catalysts || []).some(c => c.type === 'earnings' && c.daysAway <= 2);
  let earningsGapEstimate = null;
  const eh = earningsHistory || {};

  if (hasEarnings && eh.recentSurprises && eh.recentSurprises.length >= 2) {
    // Look at historical post-earnings moves to estimate expected gap
    // Use the average surprise magnitude as a proxy for expected move size
    const avgSurprisePct = Math.abs(eh.avgSurprise || 0);
    // Historical: stocks move roughly 1-2x their surprise % on earnings day
    const expectedGapPct = avgSurprisePct * 1.2; // conservative 1.2x multiplier
    earningsGapEstimate = {
      expectedGapPct: Math.round(expectedGapPct * 100) / 100,
      expectedTarget: Math.round(currentPrice * (1 + expectedGapPct / 100) * 100) / 100,
      basedOn: `${eh.quarterCount || 0}Q avg surprise: ${eh.avgSurprise > 0 ? '+' : ''}${eh.avgSurprise}%`,
      beatProbability: eh.beatStreak >= 3 ? '~70%' : eh.beatStreak >= 2 ? '~60%' : '~50%'
    };
  }

  // ══════════════════════════════════════════
  // 6. ANALYST CONSENSUS
  // ══════════════════════════════════════════
  const analystCat = (catalysts || []).find(c => c.type === 'target_price');
  const analystTarget = analystCat ? Math.round(analystCat.targetPrice * 100) / 100 : null;
  const analystUpside = analystCat?.upside || null;

  // ══════════════════════════════════════════
  // 7. SYNTHESIZE: Multi-validated target price
  // ══════════════════════════════════════════
  // Collect all candidate targets and find consensus
  const candidateTargets = [];

  // ATR-based target (baseline)
  const atrMultiplier = hasEarnings ? 2.0 : 1.5;
  const atrTarget = currentPrice + atr * atrMultiplier;
  candidateTargets.push({ price: atrTarget, weight: 2, source: `ATR × ${atrMultiplier}` });

  // Nearest resistance (strong — price already proved it stops here)
  if (nearestResistance && nearestResistance.price > currentPrice) {
    candidateTargets.push({ price: nearestResistance.price, weight: 3, source: nearestResistance.label });
  }

  // First Fibonacci target above current price
  if (fibTargets.length > 0) {
    candidateTargets.push({ price: fibTargets[0].price, weight: 2, source: `Fib ${fibTargets[0].level}` });
  }

  // Earnings gap estimate (if applicable)
  if (earningsGapEstimate) {
    candidateTargets.push({ price: earningsGapEstimate.expectedTarget, weight: 2, source: 'Earnings Gap Est.' });
  }

  // Analyst target — only if reasonable (within 20% — not a 12-month dream)
  if (analystTarget && analystUpside && analystUpside <= 25 && analystUpside > 0) {
    candidateTargets.push({ price: analystTarget, weight: 1, source: 'Analyst Consensus' });
  }

  // Weighted average of all candidates = our target
  let targetPrice;
  let targetSources = [];
  if (candidateTargets.length > 0) {
    const totalWeight = candidateTargets.reduce((s, c) => s + c.weight, 0);
    targetPrice = candidateTargets.reduce((s, c) => s + c.price * c.weight, 0) / totalWeight;
    targetPrice = Math.round(targetPrice * 100) / 100;
    targetSources = candidateTargets.map(c => c.source);
  } else {
    targetPrice = Math.round((currentPrice + atr * 1.5) * 100) / 100;
    targetSources = ['ATR fallback'];
  }

  let targetSource = `Validated: ${targetSources.join(' + ')}`;

  // Conservative / Aggressive range
  const conservativeTarget = Math.round(Math.min(...candidateTargets.map(c => c.price)) * 100) / 100;
  const aggressiveTarget = Math.round(Math.max(...candidateTargets.map(c => c.price)) * 100) / 100;

  // Confidence in target: how many sources agree within 1 ATR of each other?
  let targetConfidence = 'low';
  if (candidateTargets.length >= 3) {
    const spread = aggressiveTarget - conservativeTarget;
    const spreadPct = (spread / currentPrice) * 100;
    if (spreadPct < atr / currentPrice * 100 * 2) targetConfidence = 'high';    // Tight cluster
    else if (spreadPct < atr / currentPrice * 100 * 4) targetConfidence = 'medium';
  }

  // ══════════════════════════════════════════
  // 8. STOP LOSS (multi-validated)
  // ══════════════════════════════════════════
  let stopLoss = Math.round((currentPrice - atr * 1.5) * 100) / 100;
  let stopSource = 'ATR × 1.5 below entry';

  // Use nearest support if it's tighter (more conservative)
  if (nearestSupport && nearestSupport.price < currentPrice && nearestSupport.price > stopLoss) {
    stopLoss = Math.round((nearestSupport.price - atr * 0.1) * 100) / 100; // Just below support
    stopSource = `Below ${nearestSupport.label}`;
  }

  // Validate: 20-day swing low as absolute floor stop
  if (h.length >= 5) {
    const lows = h.slice(-20).map(d => d.low || Infinity).filter(v => v > 0 && v < Infinity);
    if (lows.length > 0) {
      const swingLow = Math.min(...lows);
      if (swingLow > 0 && swingLow < currentPrice && swingLow > stopLoss) {
        stopLoss = Math.round(swingLow * 100) / 100;
        stopSource = '20-Day Swing Low';
      }
    }
  }

  // Safety: ensure stop below entry, target above entry
  if (stopLoss >= entryPrice) stopLoss = Math.round(entryPrice * 0.97 * 100) / 100;
  if (targetPrice <= entryPrice) targetPrice = Math.round(entryPrice * 1.02 * 100) / 100;

  // ══════════════════════════════════════════
  // 9. RISK/REWARD & RISK LEVEL
  // ══════════════════════════════════════════
  const risk = entryPrice - stopLoss;
  const reward = targetPrice - entryPrice;
  const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0;

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

  return {
    available: true,
    entryPrice,
    targetPrice,
    conservativeTarget,
    aggressiveTarget,
    targetConfidence,
    stopLoss,
    riskReward,
    riskLevel,
    riskLabel,
    targetSource,
    stopSource,
    potentialGain: Math.round((reward / entryPrice) * 10000) / 100,
    potentialLoss: Math.round((risk / entryPrice) * 10000) / 100,
    atr: Math.round(atr * 100) / 100,
    analystTarget,
    // Pre/Post market context
    preMarketGapPct: Math.round(preMarketGapPct * 100) / 100,
    entryNote,
    // Detailed validation data for UI
    validation: {
      resistanceLevels: resistanceLevels.slice(0, 3).map(r => ({ price: Math.round(r.price * 100) / 100, type: r.label })),
      supportLevels: supportLevels.slice(0, 3).map(s => ({ price: Math.round(s.price * 100) / 100, type: s.label })),
      fibTargets: fibTargets.slice(0, 2).map(f => ({ level: f.level, price: Math.round(f.price * 100) / 100 })),
      earningsGap: earningsGapEstimate,
      candidateSources: candidateTargets.map(c => ({ source: c.source, price: Math.round(c.price * 100) / 100 }))
    }
  };
}

/**
 * Real-time analysis of earnings results after they report.
 * Uses news sentiment and price gap.
 */
function analyzeEarningsResult(symbol, news, quote, timing) {
  if (!timing || timing === 'N/A') return null;

  // 1. Check if report time has passed in NY
  const now = new Date();
  const nyTimeStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).format(now);
  
  const [hour, minute] = nyTimeStr.split(':').map(Number);
  const totalMinutes = hour * 60 + minute;
  
  // BMO: Start checking after 7:00 AM ET (pre-market reports often hit then)
  const isBmoPassed = timing === 'BMO' && totalMinutes >= 420; 
  const isAmcPassed = timing === 'AMC' && totalMinutes >= 960; // Past 4:00 PM ET

  if (!isBmoPassed && !isAmcPassed) return null;

  // 2. Scan news for earnings keywords
  const BEAT_WORDS = ['beats', 'exceeds', 'above estimates', 'soars', 'surprises', 'growth', 'upbeat', 'bullish'];
  const MISS_WORDS = ['misses', 'below estimates', 'plunges', 'falls', 'disappoints', 'warning', 'weak', 'bearish'];
  
  let beatCount = 0;
  let missCount = 0;
  
  news.slice(0, 10).forEach(a => {
    const title = a.title.toLowerCase();
    const hasEarnings = title.includes('earnings') || title.includes('results') || title.includes('q1') || title.includes('q2') || title.includes('q3') || title.includes('q4');
    
    if (hasEarnings) {
      BEAT_WORDS.forEach(w => { if (title.includes(w)) beatCount++; });
      MISS_WORDS.forEach(w => { if (title.includes(w)) missCount++; });
    }
  });

  // 3. Price reaction logic
  const change = quote?.regularMarketChangePercent || 0;
  const postPrice = quote?.postMarketPrice;
  const prePrice = quote?.preMarketPrice;
  const regPrice = quote?.regularMarketPrice;
  
  let reaction = change;
  if (isAmcPassed && postPrice && regPrice) {
    reaction = ((postPrice - regPrice) / regPrice) * 100;
  } else if (isBmoPassed && regPrice && prePrice) {
    reaction = ((regPrice - prePrice) / prePrice) * 100;
  }

  let status = 'Reported';
  let sentiment = 'neutral';
  
  if (beatCount > missCount || reaction > 1.5) {
    status = reaction > 3 ? '✅ BIG BEAT' : '✅ BULLISH';
    sentiment = 'bullish';
  } else if (missCount > beatCount || reaction < -1.5) {
    status = reaction < -3 ? '❌ BIG MISS' : '❌ BEARISH';
    sentiment = 'bearish';
  }

  return {
    status,
    sentiment,
    reaction: Math.round(reaction * 100) / 100,
    summary: beatCount > missCount ? 'Beat Estimates' : missCount > beatCount ? 'Missed Estimates' : 'Reaction Mixed',
    isReported: true
  };
}

// ── Shared Symbol Scoring Helper (Individual) ──
async function scoreSymbol(symbol, earningsCalendar) {
  const [quote, history, catalysts, reddit, stocktwits, news, earningsHist] = await Promise.allSettled([
    yahooFinance.getQuote(symbol),
    yahooFinance.getHistoricalData(symbol),
    yahooFinance.getUpcomingCatalysts(symbol),
    getRedditSentiment(symbol),
    getStockTwitsSentiment(symbol),
    getNewsForStock(symbol, ''),
    getEarningsHistory(symbol)
  ]);

  const quoteData = quote.status === 'fulfilled' ? quote.value : {};
  const catalystList = catalysts.status === 'fulfilled' ? catalysts.value : [];
  const earningsEntry = earningsCalendar.find(e => (e.symbol || e.ticker) === symbol);
  const earningsHistData = earningsHist.status === 'fulfilled' ? earningsHist.value : {};

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
    earningsHistory: earningsHistData,
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
  const entry = getEntrySignal(change, stockData.hasEarningsToday || stockData.hasEarningsTomorrow, stockData.history, currentPrice, quoteData);
  const tradeSetup = calcTradeSetup(stockData.history, currentPrice, catalystList, quoteData, earningsHistData);

  return {
    symbol,
    companyName: quoteData?.shortName || quoteData?.longName || symbol,
    price: currentPrice || null,
    change,
    preMarketPrice: quoteData?.preMarketPrice || null,
    postMarketPrice: quoteData?.postMarketPrice || null,
    preMarketChange: quoteData?.preMarketChangePercent || null,
    postMarketChange: quoteData?.postMarketChangePercent || null,
    marketState: quoteData?.marketState || null,
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
    earningsTiming: earningsEntry?.timing || 'N/A',
    earningsResult: stockData.hasEarningsToday ? analyzeEarningsResult(symbol, stockData.news, quoteData, earningsEntry?.timing) : null,
    // Earnings quality indicators (new)
    earningsQuality: {
      beatStreak: earningsHistData.beatStreak || 0,
      sue: earningsHistData.sue || 0,
      avgSurprise: earningsHistData.avgSurprise || 0,
      revisionMomentum: earningsHistData.revisionMomentum || 0,
      recentSurprises: earningsHistData.recentSurprises || []
    },
    // Keep raw data for detail routes
    _social: { reddit: stockData.reddit, stocktwits: stockData.stocktwits },
    _news: stockData.news,
    _history: stockData.history,
    _volume: quoteData?.regularMarketVolume || null
  };
}

// Sectors to exclude from predictions
const EXCLUDED_SECTORS = new Set(['Crypto', 'Cannabis']);

// ══════════════════════════════════════════
// MARKET REGIME DETECTOR
// Don't recommend buys when SPY is in a downtrend (bear market)
// This single filter prevents most losses during market sell-offs
// ══════════════════════════════════════════
let marketRegimeCache = { regime: 'neutral', timestamp: 0 };
const REGIME_CACHE_TTL = 30 * 60 * 1000; // 30 min

async function getMarketRegime() {
  if (Date.now() - marketRegimeCache.timestamp < REGIME_CACHE_TTL) {
    return marketRegimeCache;
  }

  try {
    const spyHistory = await yahooFinance.getHistoricalData('SPY');
    const spyQuote = await yahooFinance.getQuote('SPY');

    if (!spyHistory || spyHistory.length < 50) {
      return { regime: 'neutral', spyTrend: 'unknown', confidence: 0 };
    }

    const currentPrice = spyQuote?.regularMarketPrice || spyHistory[spyHistory.length - 1]?.close || 0;

    // 20-day SMA (short-term trend)
    const sma20 = spyHistory.slice(-20).reduce((s, d) => s + (d.close || 0), 0) / 20;
    // 50-day SMA (medium-term trend)
    const sma50 = spyHistory.slice(-50).reduce((s, d) => s + (d.close || 0), 0) / Math.min(50, spyHistory.length);

    // 5-day momentum
    const fiveDayReturn = spyHistory.length >= 5
      ? ((currentPrice - spyHistory[spyHistory.length - 5].close) / spyHistory[spyHistory.length - 5].close) * 100
      : 0;

    // Market regime rules:
    // BULL: SPY > 20-SMA > 50-SMA (uptrend)
    // BEAR: SPY < 20-SMA < 50-SMA (downtrend)
    // CAUTIOUS: Mixed signals
    let regime = 'neutral';
    let spyTrend = 'mixed';

    if (currentPrice > sma20 && sma20 > sma50) {
      regime = 'bull';
      spyTrend = 'uptrend';
    } else if (currentPrice < sma20 && sma20 < sma50) {
      regime = 'bear';
      spyTrend = 'downtrend';
    } else if (currentPrice > sma20) {
      regime = 'cautious_bull';
      spyTrend = 'recovering';
    } else {
      regime = 'cautious_bear';
      spyTrend = 'weakening';
    }

    // Panic check: if SPY dropped >2% in last 5 days, be very cautious
    if (fiveDayReturn < -3) {
      regime = 'bear';
      spyTrend = 'sell-off';
    }

    const result = {
      regime,
      spyTrend,
      spyPrice: Math.round(currentPrice * 100) / 100,
      sma20: Math.round(sma20 * 100) / 100,
      sma50: Math.round(sma50 * 100) / 100,
      fiveDayReturn: Math.round(fiveDayReturn * 100) / 100,
      timestamp: Date.now()
    };

    marketRegimeCache = result;
    console.log(`[MarketRegime] ${regime.toUpperCase()} — SPY $${result.spyPrice} | 20SMA $${result.sma20} | 50SMA $${result.sma50} | 5d: ${fiveDayReturn.toFixed(1)}%`);
    return result;
  } catch (err) {
    console.error('[MarketRegime] Error:', err.message);
    return { regime: 'neutral', spyTrend: 'unknown', timestamp: Date.now() };
  }
}

// ── Quality Filters ──
// Minimum requirements to be recommended
function passesQualityFilter(stock, marketRegime) {
  const q = stock._quote || stock.quote || {};
  const volume = q.regularMarketVolume || stock._volume || 0;
  const marketCap = q.marketCap || 0;
  const price = stock.price || q.regularMarketPrice || 0;

  // 1. Minimum liquidity — avoid penny stocks and illiquid names
  if (price < 2) return false;              // No penny stocks
  if (volume < 200000) return false;         // Minimum 200K daily volume
  if (marketCap > 0 && marketCap < 200e6) return false;  // Min $200M market cap (if data available)

  // 2. Don't recommend stocks we tell users NOT to buy
  if (stock.entrySignal === 'too_late') return false;

  // 3. Minimum score threshold
  if (stock.score < 40) return false;

  // 4. MARKET REGIME FILTER — the most important filter
  // In bear markets: only recommend HIGH confidence stocks with good R:R
  if (marketRegime?.regime === 'bear') {
    if (stock.confidence !== 'HIGH') return false;        // Only high-confidence in bear market
    if (stock.tradeSetup?.riskReward < 2.0) return false; // Must have 2:1 R:R minimum
  }

  // In cautious markets: require at least MEDIUM confidence and 1.5:1 R:R
  if (marketRegime?.regime === 'cautious_bear') {
    if (stock.confidence === 'LOW') return false;
    if (stock.tradeSetup?.riskReward < 1.5) return false;
  }

  // 5. MINIMUM R:R ENFORCEMENT — the math that makes bad win rates profitable
  // Even at 40% win rate, 2:1 R:R = profitable (+$0.20 per $1 risked)
  if (stock.tradeSetup?.available && stock.tradeSetup?.riskReward < 1.0) return false;

  // 6. PRE-MARKET GAP FILTER — reject stocks that already gapped too far
  // If pre-market gap > 6%, the stock has already moved and entry is too risky
  if (stock.tradeSetup?.preMarketGapPct > 6) return false;
  // If pre-market gap is negative and large, something broke overnight — avoid
  if (stock.tradeSetup?.preMarketGapPct < -5) return false;

  return true;
}

// ── Batch Scoring Helper ──
async function scoreSymbols(symbols, earningsCalendar, opts = { light: false }) {
  if (!symbols || symbols.length === 0) return [];
  
  // 1. Fetch all quotes in one batch call
  const quotes = await yahooFinance.getQuoteBatch(symbols);
  const quoteMap = new Map();
  quotes.forEach(q => {
    if (q && q.symbol) quoteMap.set(q.symbol, q);
  });

  // 2. Fetch rest of data in parallel for each
  const scoredData = await Promise.allSettled(
    symbols.map(async (symbol) => {
      try {
        const quoteData = quoteMap.get(symbol) || {};
        
        // Parallel fetch for remaining data
        const tasks = [
          yahooFinance.getHistoricalData(symbol),
          yahooFinance.getUpcomingCatalysts(symbol),
          getEarningsHistory(symbol)
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
        const catalysts = results[1].status === 'fulfilled' ? results[1].value : [];
        const earningsHistData = results[2].status === 'fulfilled' ? results[2].value : {};
        const reddit = !opts.light && results[3]?.status === 'fulfilled' ? results[3].value : { mentions: 0, sentiment: 0 };
        const stocktwits = !opts.light && results[4]?.status === 'fulfilled' ? results[4].value : { bearish: 0, bullish: 0, total: 0 };
        const news = !opts.light && results[5]?.status === 'fulfilled' ? results[5].value : [];

        const stockData = {
          symbol,
          quote: quoteData,
          history,
          reddit,
          stocktwits,
          news,
          hasEarningsToday: !!earningsCalendar.find(e => (e.symbol || e.ticker) === symbol && e.isToday),
          hasEarningsTomorrow: !!earningsCalendar.find(e => (e.symbol || e.ticker) === symbol && e.isTomorrow),
          catalysts,
          earningsHistory: earningsHistData
        };

        const score = calculateScore(stockData);
        const change = quoteData?.regularMarketChangePercent || 0;
        const currentPrice = quoteData?.regularMarketPrice || 0;
        
        const earningsEntry = earningsCalendar.find(e => (e.symbol || e.ticker) === symbol);
        const hasEarningsToday = stockData.hasEarningsToday;
        const hasEarningsTomorrow = stockData.hasEarningsTomorrow;
        
        const entry = getEntrySignal(change, hasEarningsToday || hasEarningsTomorrow, history, currentPrice, quoteData);
        const tradeSetup = calcTradeSetup(history, currentPrice, catalysts, quoteData, earningsHistData);
        const upcomingEvents = [];
        if (hasEarningsToday) upcomingEvents.push('Earnings TODAY');
        else if (hasEarningsTomorrow) upcomingEvents.push('Earnings TOMORROW');
        
        const earningsTiming = earningsEntry?.timing || 'N/A';
        const earningsResult = hasEarningsToday ? analyzeEarningsResult(symbol, news, quoteData, earningsTiming) : null;

        return {
          symbol,
          companyName: quoteData?.shortName || symbol,
          price: currentPrice,
          change,
          // Pre/post market prices for card display
          preMarketPrice: quoteData?.preMarketPrice || null,
          postMarketPrice: quoteData?.postMarketPrice || null,
          preMarketChange: quoteData?.preMarketChangePercent || null,
          postMarketChange: quoteData?.postMarketChangePercent || null,
          marketState: quoteData?.marketState || null,
          score: score.totalScore,
          breakdown: score.breakdown,
          probability: score.probability,
          confidence: score.confidence,
          sector: classifySector(symbol, quoteData?.shortName || ''),
          hasEarningsToday,
          hasEarningsTomorrow,
          upcomingEvents,
          brokerAvailability: checkAvailability(symbol),
          socialMentions: (stockData.reddit.mentions || 0) + (stockData.stocktwits.total || 0),
          newsCount: stockData.news.length,
          catalysts,
          entrySignal: entry.signal,
          entryLabel: entry.label,
          entryReason: entry.reason,
          tradeSetup,
          earningsTiming: earningsEntry?.timing || 'N/A',
          earningsResult: hasEarningsToday ? analyzeEarningsResult(symbol, news, quoteData, earningsEntry?.timing) : null,
          earningsQuality: {
            beatStreak: earningsHistData.beatStreak || 0,
            sue: earningsHistData.sue || 0,
            avgSurprise: earningsHistData.avgSurprise || 0,
            revisionMomentum: earningsHistData.revisionMomentum || 0,
          },
          // Keep raw data for detail routes
          _quote: quoteData,
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

    const [earningsCalendar, trendingStocks, marketRegime] = await Promise.all([
      yahooFinance.getEarningsCalendar(),
      yahooFinance.getTrendingStocks(),
      getMarketRegime()
    ]);

    const earningsSymbols = earningsCalendar.map(e => e.symbol || e.ticker);
    const trendingSymbols = trendingStocks.map(t => t.symbol || t);
    const majorStocks = [
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD',
      'JPM', 'BAC', 'V', 'NFLX', 'DIS', 'PFE', 'LLY', 'UNH',
      'ADBE', 'CRM', 'ORCL', 'COIN', 'PLTR', 'UBER', 'SQ', 'SHOP',
      'SNOW', 'ABNB', 'PYPL', 'INTC', 'MU', 'QCOM'
    ];

    const symbolSet = new Set();
    // Prioritize earnings stocks and majors (more predictable)
    earningsSymbols.slice(0, 15).forEach(s => symbolSet.add(s));
    majorStocks.forEach(s => symbolSet.add(s));
    // Add trending last (these are often already pumped)
    trendingSymbols.slice(0, 8).forEach(s => symbolSet.add(s));
    const symbols = Array.from(symbolSet).slice(0, 35);

    const scored = await scoreSymbols(symbols, earningsCalendar);

    const predictions = scored
      .filter(v => passesQualityFilter(v, marketRegime))   // Quality + regime gate
      .map(v => {
        // Strip internal fields for list response
        const { _quote, _social, _news, _history, _volume, ...clean } = v;
        return clean;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const result = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      earningsCount: earningsSymbols.length,
      marketRegime: {
        regime: marketRegime.regime,
        spyTrend: marketRegime.spyTrend,
        spyPrice: marketRegime.spyPrice,
        fiveDayReturn: marketRegime.fiveDayReturn
      },
      predictions
    };

    console.log(`[Predictions] Done: ${predictions.length} picks | Market: ${marketRegime.regime?.toUpperCase()} (${earningsSymbols.length} earnings found)`);
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

    const [earningsCalendar, marketRegime] = await Promise.all([
      yahooFinance.getEarningsCalendar(),
      getMarketRegime()
    ]);

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
      .filter(result => passesQualityFilter(result, marketRegime))   // Quality + regime gate
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

        const { _quote, _social, _news, _history, _volume, ...clean } = result;
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

        const { _quote, _social, _news, _history, _volume, ...clean } = result;
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
        const entry = getEntrySignal(change, false, null, d.regularMarketPrice, d);
        prices[d.symbol] = {
          price: d.currentSessionPrice || d.regularMarketPrice || null,
          regularPrice: d.regularMarketPrice || null,
          preMarketPrice: d.preMarketPrice || null,
          postMarketPrice: d.postMarketPrice || null,
          preMarketChange: d.preMarketChangePercent || null,
          postMarketChange: d.postMarketChangePercent || null,
          marketState: d.marketState || null, // PRE, REGULAR, POST, CLOSED
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

// ══════════════════════════════════════════
// /api/history — Performance Evolution
// ══════════════════════════════════════════
router.get('/history', async (req, res, next) => {
  try {
    const cached = getCached('history_perf', 2 * 60 * 1000); // 2 min cache
    if (cached) return res.json(cached);

    const history = await getHistoryWithPerformance();
    setCache('history_perf', history);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

export default router;
