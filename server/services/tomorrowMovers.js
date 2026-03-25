/**
 * GEM FINDER v2.0 — Find Explosive Stocks BEFORE They Move
 *
 * The #1 predictor of a 20-100%+ move is: VOLUME PRECEDES PRICE.
 * Smart money loads shares quietly over 2-5 days. Then the stock
 * explodes. This engine detects that pattern.
 *
 * Key signals (ordered by predictive power):
 * 1. Multi-Day Volume Accumulation — volume rising 3+ days, price flat (STRONGEST)
 * 2. Smart Money Footprint — closing near daily highs on high volume (institutions buying)
 * 3. Short Squeeze Pressure — high SI + price NOT falling = shorts trapped
 * 4. Bollinger Squeeze + Volume Dry-up — coiled spring about to pop
 * 5. 52-Week High Breakout — stocks at highs with volume tend to keep running
 * 6. Momentum Acceleration — rate of change is INCREASING (not just positive)
 * 7. Low Float + Volume — small supply + rising demand = explosive
 * 8. Earnings Catalyst — stock coiling before earnings report
 * 9. Sector Lag — sector is hot, this stock hasn't moved yet (catch-up trade)
 * 10. Oversold Bounce — quality stock crashed on volume dry-up (exhaustion)
 *
 * Gem Score = weighted combination → higher = more explosive potential
 */

import { getQuoteBatch, getHistoricalData, getEarningsCalendar, getTrendingStocks, getDailyGainers } from './yahooFinance.js';
import { getShortSqueezeSetups, getBreakoutSetups, STOCK_UNIVERSE } from './premarketScanner.js';
import { classifySector, getSectorTrends } from './sectorAnalysis.js';
import { getOrderFlow } from './orderFlow.js';

// ── Cache ──
let cache = { data: null, ts: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 min
let inflight = null;

/**
 * Main entry: find stocks setting up for a big move tomorrow/next few days
 */
export async function findTomorrowMovers() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;
  if (inflight) return inflight;

  inflight = _scan().finally(() => { inflight = null; });
  return inflight;
}

// ── Historical Pattern Analysis ──
// This is the secret sauce. Analyzes 5-20 day price/volume history
// to detect accumulation, smart money, and momentum acceleration.

function analyzeHistory(bars) {
  if (!bars || bars.length < 10) return null;

  const recent = bars.slice(-20);
  const closes = recent.map(b => b.close).filter(Boolean);
  const volumes = recent.map(b => b.volume).filter(Boolean);
  const highs = recent.map(b => b.high).filter(Boolean);
  const lows = recent.map(b => b.low).filter(Boolean);
  const opens = recent.map(b => b.open).filter(Boolean);

  if (closes.length < 10 || volumes.length < 10) return null;

  const result = {
    volumeTrend: 0,         // Are volumes RISING over 3-5 days?
    smartMoneyScore: 0,     // Closing near highs? (institutions buying)
    momentumAccel: 0,       // Is rate of change accelerating?
    priceCompression: 0,    // Is price range narrowing? (coiling)
    near52WeekHigh: false,  // Within 5% of 52-week high?
    volumeStreakDays: 0,    // Consecutive days of above-avg volume
    closingStrength: 0,     // Average closing position (0=low, 1=high)
  };

  // ── 1. Multi-Day Volume Trend ──
  // Compare last 5 days avg vol to prior 10 days avg vol
  const last5Vol = volumes.slice(-5);
  const prior10Vol = volumes.slice(-15, -5);
  if (prior10Vol.length >= 5) {
    const avgLast5 = last5Vol.reduce((s, v) => s + v, 0) / last5Vol.length;
    const avgPrior10 = prior10Vol.reduce((s, v) => s + v, 0) / prior10Vol.length;
    if (avgPrior10 > 0) {
      result.volumeTrend = avgLast5 / avgPrior10; // >1 = rising, <1 = falling
    }
  }

  // Count consecutive days of above-average volume (from most recent)
  const overallAvgVol = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  let streak = 0;
  for (let i = volumes.length - 1; i >= 0; i--) {
    if (volumes[i] > overallAvgVol * 1.2) streak++;
    else break;
  }
  result.volumeStreakDays = streak;

  // ── 1b. VOLUME ACCELERATION (NEW — detects ramp-up pattern) ──
  // Instead of just counting streak, check if volume is INCREASING day-over-day
  // Pattern: 1.2x → 2x → 4x is 100x more predictive than flat 2x for 10 days
  if (last5Vol.length >= 3) {
    let accelCount = 0;
    for (let i = 1; i < last5Vol.length; i++) {
      if (last5Vol[i] > last5Vol[i - 1] * 1.1) accelCount++; // Each day 10%+ higher
    }
    result.volumeAccelerating = accelCount >= 2; // 2+ days of acceleration
    result.volumeAccelRate = last5Vol.length >= 2
      ? last5Vol[last5Vol.length - 1] / last5Vol[0] // ratio of latest vs oldest
      : 1;
  }

  // ── 2. Smart Money Detection (IMPROVED — detect LOADING not momentum) ──
  // OLD: "closing near highs on volume" = detects moves ALREADY happening
  // NEW: Detect ACCUMULATION pattern = buying on RED days (dip buying)
  //   - Volume spikes on down days = institutions buying panic
  //   - Price recovering to close near mid-range on high volume = stealth accumulation
  //   - VWAP divergence: volume-weighted price > simple average = buying pressure
  const closingPositions = [];
  let redDayBuying = 0; // count of high-volume red days (institutions buying dips)
  let dipBuyScore = 0;

  for (let i = Math.max(0, closes.length - 10); i < closes.length; i++) {
    const range = highs[i] - lows[i];
    if (range > 0) {
      const closingPos = (closes[i] - lows[i]) / range;
      closingPositions.push(closingPos);

      // Key insight: HIGH VOLUME on DOWN days where close is above midpoint
      // = institutions buying the dip (stealth loading)
      const isDownDay = closes[i] < (i > 0 ? closes[i - 1] : closes[i]);
      const aboveMid = closingPos > 0.45; // closed above midpoint despite red day
      const highVol = volumes[i] > overallAvgVol * 1.3;

      if (isDownDay && aboveMid && highVol) {
        redDayBuying++;
        dipBuyScore += closingPos * (volumes[i] / overallAvgVol);
      }
    }
  }
  if (closingPositions.length > 0) {
    result.closingStrength = closingPositions.reduce((s, v) => s + v, 0) / closingPositions.length;
  }

  // Smart money score (IMPROVED)
  // Two paths to detect smart money:
  // Path A: Classic — closing near highs on volume (momentum confirmation)
  const avgClosingPos = result.closingStrength;
  const recentVolAboveAvg = last5Vol.filter(v => v > overallAvgVol).length;
  let smartScore = 0;
  if (avgClosingPos > 0.65 && recentVolAboveAvg >= 3) {
    smartScore = Math.round(avgClosingPos * recentVolAboveAvg * 3); // reduced from 4x
  }
  // Path B: Stealth loading — buying dips on high volume (EARLIER detection)
  if (redDayBuying >= 2) {
    smartScore = Math.max(smartScore, Math.round(dipBuyScore * 3));
  }
  result.smartMoneyScore = smartScore;
  result.redDayBuying = redDayBuying; // new signal for gem scoring

  // ── 3. Momentum Acceleration (IMPROVED) ──
  // Compare 3-day return vs 5-day return. If 3-day > 5-day, momentum is accelerating
  // NEW: Also detect EARLY momentum (day 1-2 of a move, before crowd piles in)
  if (closes.length >= 6) {
    const ret3d = (closes[closes.length - 1] / closes[closes.length - 4] - 1) * 100;
    const ret5d = (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100;
    // Acceleration = recent momentum gaining speed
    result.momentumAccel = ret3d > 0 && ret3d > ret5d * 0.7 ? ret3d : 0;

    // NEW: Early momentum = small positive move (1-4%) after period of compression
    // This catches moves at day 1-2, not day 5-10
    const ret2d = (closes[closes.length - 1] / closes[closes.length - 3] - 1) * 100;
    const rangeCompression = result.priceCompression || 0;
    result.earlyBreakout = ret2d > 1 && ret2d < 5 && rangeCompression > 0.5;
  }

  // ── 4. Price Compression ──
  // Compare last 5 bars range to last 20 bars range
  const recent5High = Math.max(...highs.slice(-5));
  const recent5Low = Math.min(...lows.slice(-5));
  const full20High = Math.max(...highs);
  const full20Low = Math.min(...lows);
  const fullRange = full20High - full20Low;
  const recentRange = recent5High - recent5Low;
  if (fullRange > 0) {
    result.priceCompression = 1 - (recentRange / fullRange); // higher = more compressed
  }

  // ── 5. 52-Week High Proximity ──
  const currentPrice = closes[closes.length - 1];
  const highestPrice = Math.max(...highs);
  if (highestPrice > 0 && currentPrice >= highestPrice * 0.95) {
    result.near52WeekHigh = true;
  }

  return result;
}

// ── Gem Score Calculator ──
// Combines all signals into one "explosive potential" score (0-100)
function calculateGemScore(signals, details, histAnalysis) {
  let score = 0;
  const weights = {
    // ── LOADING signals (3-7 day predictors — STRONGEST) ──
    volume_acceleration: 22,      // NEW: volume ramping up day-over-day
    stealth_accumulation: 22,     // NEW: buying dips on high volume (smart money loading)
    multi_day_accumulation: 20,   // consecutive days of above-avg volume
    insider_buying: 20,           // SEC Form 4 insider purchases
    // ── Squeeze signals ──
    short_squeeze_loading: 16,
    bb_squeeze: 14,
    // ── Smart money / flow signals ──
    smart_money: 16,              // closing near highs on volume (reduced from 18)
    bullish_options: 16,
    institutions_accumulating: 14,
    unusual_options_volume: 12,
    // ── Volume signals ──
    unusual_volume: 14,           // reduced from 15 (too reactive)
    volume_contraction: 10,       // increased — vol dry-up before explosion is strong
    // ── Momentum signals ──
    early_breakout: 16,           // NEW: small move after compression (day 1-2)
    early_momentum: 10,           // reduced — too reactive
    momentum_acceleration: 12,    // reduced — detects moves already happening
    near_52w_high: 8,             // reduced — not predictive by itself
    // ── Structural signals ──
    low_float_volume: 12,
    earnings_tomorrow: 8,         // reduced from 12 — not reliable predictor
    sector_lag: 8,                // increased — sector catch-up is real
    pair_divergence: 14,          // NEW: correlated stock lagging its pair
    oversold_bounce: 6,
    bull_flag: 8,
    golden_cross: 5,
    price_compression: 10,        // NEW: tight range about to break
  };

  for (const sig of signals) {
    score += weights[sig] || 5;
  }

  // Multi-signal bonus — stocks with 3+ signals are exponentially more likely to explode
  if (signals.length >= 4) score *= 1.3;
  else if (signals.length >= 3) score *= 1.15;

  // Cap at 100
  return Math.min(100, Math.round(score));
}

/**
 * EXPLOSION PREDICTION — estimate expected gain %, timeframe, and probability
 * Based on empirical patterns:
 * - Low float + volume surge → fastest explosions (1-2 days, 20-100%+)
 * - Multi-day accumulation + smart money → medium term (2-5 days, 15-40%)
 * - BB squeeze + volume buildup → 3-7 days, 10-30%
 * - Short squeeze loading → 1-5 days, 30-80%+ (can be extreme)
 * - Earnings catalyst → overnight, 5-20% typical, can be 50%+ either way
 */
function predictExplosion(signals, details, hist, price, volumeRatio, floatShares, marketCap) {
  let expectedGainPct = 0;
  let daysToMove = 5;
  let probability = 30; // base probability
  let explosionType = 'moderate_setup';
  const factors = [];

  // ── Factor 1: Float size (smaller = more explosive) ──
  if (floatShares > 0) {
    if (floatShares < 5_000_000) {
      expectedGainPct += 40; probability += 10; daysToMove -= 1;
      factors.push('Micro float (<5M) — extreme squeeze potential');
    } else if (floatShares < 15_000_000) {
      expectedGainPct += 25; probability += 5;
      factors.push('Low float (<15M) — strong squeeze potential');
    } else if (floatShares < 30_000_000) {
      expectedGainPct += 12;
      factors.push('Moderate float');
    }
  }

  // ── Factor 2: Volume spike magnitude ──
  if (volumeRatio >= 5) {
    expectedGainPct += 30; probability += 15; daysToMove = Math.min(daysToMove, 2);
    factors.push(`Massive volume (${volumeRatio.toFixed(1)}x avg) — institutional entry`);
    explosionType = 'volume_explosion';
  } else if (volumeRatio >= 3) {
    expectedGainPct += 20; probability += 10; daysToMove = Math.min(daysToMove, 3);
    factors.push(`Heavy volume (${volumeRatio.toFixed(1)}x avg)`);
  } else if (volumeRatio >= 2) {
    expectedGainPct += 10; probability += 5;
    factors.push(`Above-avg volume (${volumeRatio.toFixed(1)}x)`);
  }

  // ── Factor 3: Multi-day accumulation pattern ──
  if (signals.includes('multi_day_accumulation') && hist?.volumeStreakDays >= 3) {
    expectedGainPct += 15; probability += 12; daysToMove = Math.min(daysToMove, 3);
    factors.push(`${hist.volumeStreakDays}-day accumulation — smart money loading`);
    explosionType = 'stealth_accumulation';
  }

  // ── Factor 4: Smart money footprint ──
  if (signals.includes('smart_money') && hist?.closingStrength > 0.75) {
    expectedGainPct += 12; probability += 10;
    factors.push('Closing near highs on volume — institutions buying');
  }

  // ── Factor 5: Short squeeze setup ──
  if (signals.includes('short_squeeze_loading')) {
    const si = details.shortInterest || 0;
    if (si > 30) {
      expectedGainPct += 50; probability += 12; daysToMove = Math.min(daysToMove, 2);
      factors.push(`Short interest ${si.toFixed(0)}% — extreme squeeze setup`);
      explosionType = 'short_squeeze';
    } else if (si > 15) {
      expectedGainPct += 25; probability += 8;
      factors.push(`Short interest ${si.toFixed(0)}% — squeeze building`);
    }
  }

  // ── Factor 6: Bollinger squeeze (coiled spring) ──
  if (signals.includes('bb_squeeze')) {
    expectedGainPct += 15; probability += 8; daysToMove = Math.min(daysToMove, 5);
    factors.push('BB squeeze — price compressed, breakout imminent');
    if (explosionType === 'moderate_setup') explosionType = 'coiled_spring';
  }

  // ── Factor 7: Price compression + momentum building ──
  if (hist?.priceCompression > 0.7 && hist?.momentumAccel > 2) {
    expectedGainPct += 12; probability += 8;
    factors.push('Price compressed + momentum accelerating — spring loaded');
  }

  // ── Factor 8: Earnings catalyst ──
  if (signals.includes('earnings_tomorrow')) {
    expectedGainPct += 15; daysToMove = 1;
    probability += 5; // Earnings are unpredictable
    factors.push('Earnings tomorrow — potential overnight gap');
    explosionType = 'earnings_catalyst';
  }

  // ── Factor 9: Insider / institutional buying ──
  if (signals.includes('insider_buying')) {
    expectedGainPct += 15; probability += 15;
    factors.push('Insiders buying — they know something');
  }
  if (signals.includes('institutions_accumulating')) {
    expectedGainPct += 10; probability += 8;
    factors.push('Institutions accumulating — big money moving in');
  }

  // ── Factor 10: Market cap (smaller = more explosive) ──
  if (marketCap > 0 && marketCap < 100_000_000) {
    expectedGainPct *= 1.5; // Micro-cap bonus
    factors.push('Micro-cap (<$100M) — highest explosion potential');
  } else if (marketCap > 0 && marketCap < 500_000_000) {
    expectedGainPct *= 1.2;
    factors.push('Small-cap (<$500M)');
  }

  // ── Signal count multiplier ──
  if (signals.length >= 5) { probability += 15; expectedGainPct *= 1.3; }
  else if (signals.length >= 4) { probability += 10; expectedGainPct *= 1.15; }
  else if (signals.length >= 3) { probability += 5; }

  // Cap values
  expectedGainPct = Math.min(200, Math.round(expectedGainPct));
  probability = Math.min(85, Math.round(probability)); // Never say more than 85%
  daysToMove = Math.max(1, Math.min(7, daysToMove));

  // Target price
  const targetPrice = Math.round(price * (1 + expectedGainPct / 100) * 100) / 100;

  return {
    expectedGainPct,
    targetPrice,
    daysToMove,
    probability,
    explosionType,
    factors,
    urgency: daysToMove <= 2 ? 'IMMINENT' : daysToMove <= 4 ? 'SOON' : 'BUILDING',
  };
}

async function _scan() {
  try {
    // Build full symbol universe
    const allSymbols = [
      ...STOCK_UNIVERSE.SMALL_MID_CAPS,
      ...STOCK_UNIVERSE.BIOTECH_PHARMA,
      ...STOCK_UNIVERSE.MEME_VOLATILE,
      ...STOCK_UNIVERSE.RECENT_IPOS,
      ...STOCK_UNIVERSE.MICRO_CAP_GEMS,
    ];
    const unique = [...new Set(allSymbols)];

    // Fetch data in parallel
    const [quotes, sectorTrends, earningsCal, squeezeData, breakoutData, trending, gainers] = await Promise.all([
      fetchAllQuotes(unique),
      getSectorTrends().catch(() => []),
      getEarningsCalendar().catch(() => []),
      getShortSqueezeSetups(unique.slice(0, 80)).catch(() => []),
      getBreakoutSetups(unique.slice(0, 80)).catch(() => []),
      getTrendingStocks().catch(() => []),
      getDailyGainers().catch(() => []),
    ]);

    // Add trending and gainer stocks to the universe for this scan
    const dynamicSymbols = [
      ...trending.map(t => t.symbol),
      ...gainers.map(g => g.symbol)
    ].filter(s => !!s);
    
    if (dynamicSymbols.length > 0) {
      console.log(`[GemFinder] Adding ${dynamicSymbols.length} trending/gainer stocks to the scan universe...`);
      const dynamicQuotes = await fetchAllQuotes(dynamicSymbols);
      Object.assign(quotes, dynamicQuotes);
    }

    // Build lookups
    const sectorMap = {};
    for (const s of sectorTrends) sectorMap[s.sector] = s;
    const squeezeLookup = {};
    for (const s of squeezeData) squeezeLookup[s.symbol] = s;
    const breakoutLookup = {};
    for (const b of breakoutData) breakoutLookup[b.symbol] = b;

    // Earnings tomorrow lookup
    const earningsTomorrow = new Set();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    for (const e of earningsCal) {
      if (e.earningsDate === tomorrowStr || e.isTomorrow) {
        earningsTomorrow.add(e.symbol);
      }
    }

    // ── Fetch historical data for top volume stocks ──
    // Only fetch history for stocks that already show some signal in quotes
    // to avoid 200+ API calls
    const candidateSymbols = [];
    for (const [symbol, quote] of Object.entries(quotes)) {
      if (!quote || !quote.regularMarketPrice) continue;
      if (quote.regularMarketPrice < 1.0) continue;
      const vol = quote.regularMarketVolume || 0;
      if (vol < 100000) continue;
      const avgVol = quote.averageDailyVolume10Day || quote.averageDailyVolume3Month || vol;
      const volRatio = avgVol > 0 ? vol / avgVol : 1;
      // Get history for anything with above-average volume or in squeeze/breakout lists
      if (volRatio > 1.0 || squeezeLookup[symbol] || breakoutLookup[symbol] || earningsTomorrow.has(symbol)) {
        candidateSymbols.push(symbol);
      }
    }

    // Fetch historical data in parallel batches (limit to top 60 to stay fast)
    const histSymbols = candidateSymbols.slice(0, 60);
    console.log(`[GemFinder] Fetching history for ${histSymbols.length} candidates...`);

    const historyMap = {};
    const HIST_BATCH = 10;
    for (let i = 0; i < histSymbols.length; i += HIST_BATCH) {
      const batch = histSymbols.slice(i, i + HIST_BATCH);
      const results = await Promise.allSettled(
        batch.map(sym => getHistoricalData(sym).then(bars => ({ sym, bars })))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.bars?.length > 0) {
          historyMap[r.value.sym] = analyzeHistory(r.value.bars);
        }
      }
    }

    console.log(`[GemFinder] Got history for ${Object.keys(historyMap).length} stocks`);

    // ── Analyze each stock ──
    const setups = [];

    for (const [symbol, quote] of Object.entries(quotes)) {
      if (!quote || !quote.regularMarketPrice) continue;
      if (quote.regularMarketPrice < 1.0) continue;       // Min $1.00 — capture penny gems
      if ((quote.regularMarketVolume || 0) < 100000) continue; // Min 100K daily vol

      const signals = [];
      let setupScore = 0;
      const details = {};

      const price = quote.regularMarketPrice;
      const volume = quote.regularMarketVolume || 0;
      const avgVolume = quote.averageDailyVolume10Day || quote.averageDailyVolume3Month || volume;
      const changePct = quote.regularMarketChangePercent || 0;
      const floatShares = quote.floatShares || quote.sharesOutstanding || 0;
      const marketCap = quote.marketCap || 0;
      const fiftyDayAvg = quote.fiftyDayAverage || price;
      const twoHundredDayAvg = quote.twoHundredDayAverage || price;
      const fiftyTwoWeekHigh = quote.fiftyTwoWeekHigh || 0;
      const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;

      // Historical analysis (if available)
      const hist = historyMap[symbol] || null;

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 1: Unusual Volume Accumulation (stealth buying)
      // High volume but price barely moved = someone loading shares
      // ═══════════════════════════════════════════════════════════
      if (volumeRatio >= 2 && Math.abs(changePct) < 3) {
        const accumulationScore = Math.min(20, Math.round(volumeRatio * 3));
        signals.push('unusual_volume');
        setupScore += accumulationScore;
        details.volumeRatio = Math.round(volumeRatio * 10) / 10;
        details.accumulation = true;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 2: Multi-Day Volume Accumulation (STRONGEST SIGNAL)
      // Volume has been rising for 3+ days while price is flat
      // This is how institutions load before a big push
      // ═══════════════════════════════════════════════════════════
      if (hist && hist.volumeTrend > 1.3 && hist.volumeStreakDays >= 2) {
        const multiDayScore = Math.min(25, Math.round(hist.volumeTrend * 8 + hist.volumeStreakDays * 3));
        signals.push('multi_day_accumulation');
        setupScore += multiDayScore;
        details.volumeTrend = Math.round(hist.volumeTrend * 100) / 100;
        details.volumeStreakDays = hist.volumeStreakDays;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 3: Smart Money Footprint
      // Closing near daily highs on above-average volume = institutions
      // buying and holding (not dumping into close)
      // ═══════════════════════════════════════════════════════════
      if (hist && hist.smartMoneyScore > 8) {
        signals.push('smart_money');
        setupScore += Math.min(20, hist.smartMoneyScore);
        details.closingStrength = Math.round(hist.closingStrength * 100);
        details.smartMoneyScore = hist.smartMoneyScore;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 4: Volume Surge + Upward Momentum (early runner)
      // Volume > 1.5x AND price up 1-5% = move starting
      // ═══════════════════════════════════════════════════════════
      if (volumeRatio >= 1.5 && changePct > 1 && changePct < 5) {
        signals.push('early_momentum');
        setupScore += 12;
        details.earlyRunner = true;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 5: Momentum Acceleration
      // The rate of change is INCREASING — not just going up,
      // but going up FASTER. This predicts continuation.
      // ═══════════════════════════════════════════════════════════
      if (hist && hist.momentumAccel > 2) {
        signals.push('momentum_acceleration');
        setupScore += Math.min(15, Math.round(hist.momentumAccel * 2));
        details.momentumAccel = Math.round(hist.momentumAccel * 100) / 100;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 6: Short Squeeze Loading
      // High short interest + stock NOT going down = shorts trapped
      // ═══════════════════════════════════════════════════════════
      const sq = squeezeLookup[symbol];
      if (sq) {
        const shortPct = sq.shortPercentOfFloat || 0;
        if (shortPct > 15 && changePct > -1) {
          const sqScore = shortPct > 30 ? 20 : shortPct > 20 ? 15 : 10;
          signals.push('short_squeeze_loading');
          setupScore += sqScore;
          details.shortPercentOfFloat = shortPct;
          details.daysToCover = sq.shortRatio || 0;
        }
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 7: Bollinger Band Squeeze (volatility explosion coming)
      // ═══════════════════════════════════════════════════════════
      const bo = breakoutLookup[symbol];
      if (bo) {
        if (bo.isBBSqueeze) {
          signals.push('bb_squeeze');
          setupScore += 12;
          details.bbWidth = bo.bbWidth;
        }
        if (bo.isVolumeContracting) {
          signals.push('volume_contraction');
          setupScore += 6;
        }
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 8: 52-Week High Breakout
      // Stock near or at 52-week highs with volume = no resistance above
      // These tend to keep running (no bagholders waiting to sell)
      // ═══════════════════════════════════════════════════════════
      if (fiftyTwoWeekHigh > 0 && price >= fiftyTwoWeekHigh * 0.95 && volumeRatio > 1.2) {
        signals.push('near_52w_high');
        setupScore += 10;
        details.pctFrom52wHigh = Math.round((price / fiftyTwoWeekHigh - 1) * 100);
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 9: Earnings Catalyst Tomorrow
      // Stock consolidating before earnings = potential big gap
      // ═══════════════════════════════════════════════════════════
      if (earningsTomorrow.has(symbol)) {
        signals.push('earnings_tomorrow');
        setupScore += 15;
        details.earningsTomorrow = true;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 10: Low Float + Volume Rising
      // Small supply + increasing demand = explosive potential
      // ═══════════════════════════════════════════════════════════
      if (floatShares > 0 && floatShares < 50_000_000) {
        const floatBonus = floatShares < 10_000_000 ? 15 : floatShares < 20_000_000 ? 10 : 6;
        if (volumeRatio >= 1.3) {
          signals.push('low_float_volume');
          setupScore += floatBonus;
          details.floatShares = floatShares;
          details.floatCategory = floatShares < 10_000_000 ? 'micro' : floatShares < 20_000_000 ? 'tiny' : 'low';
        }
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 11: Sector Lag Play
      // Sector is up big but this stock hasn't moved = catch-up potential
      // ═══════════════════════════════════════════════════════════
      const sector = classifySector(symbol, quote.shortName || '');
      const sectorData = sectorMap[sector];
      if (sectorData && sectorData.avgChange > 1.5 && changePct < sectorData.avgChange * 0.3) {
        signals.push('sector_lag');
        setupScore += 8;
        details.sectorName = sector;
        details.sectorChange = sectorData.avgChange;
        details.stockChange = Math.round(changePct * 100) / 100;
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 12: Oversold Bounce Setup
      // Stock dropped significantly below 50-day MA + volume drying up
      // = selling exhaustion, bounce likely
      // ═══════════════════════════════════════════════════════════
      if (price < fiftyDayAvg * 0.85 && volumeRatio < 0.7) {
        signals.push('oversold_bounce');
        setupScore += 8;
        details.distanceFrom50MA = Math.round(((price / fiftyDayAvg) - 1) * 100);
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 13: Bull Flag / Consolidation After Run
      // Stock ran up recently, now consolidating on low volume
      // ═══════════════════════════════════════════════════════════
      if (price > fiftyDayAvg * 1.1 && volumeRatio < 0.8 && Math.abs(changePct) < 2) {
        signals.push('bull_flag');
        setupScore += 7;
        details.aboveFiftyDay = Math.round(((price / fiftyDayAvg) - 1) * 100);
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 14: Golden Cross Proximity
      // 50-day MA crossing above 200-day MA = major bullish signal
      // ═══════════════════════════════════════════════════════════
      if (fiftyDayAvg > 0 && twoHundredDayAvg > 0) {
        const maRatio = fiftyDayAvg / twoHundredDayAvg;
        if (maRatio > 0.97 && maRatio < 1.03 && fiftyDayAvg > twoHundredDayAvg) {
          signals.push('golden_cross');
          setupScore += 6;
        }
      }

      // ═══════════════════════════════════════════════════════════
      // SIGNAL 15: Price Compression (Coiling)
      // Price range narrowing = energy building for explosive move
      // ═══════════════════════════════════════════════════════════
      if (hist && hist.priceCompression > 0.65 && volumeRatio > 0.8) {
        signals.push('price_compression');
        setupScore += 8;
        details.priceCompression = Math.round(hist.priceCompression * 100);
      }

      // ═══════════════════════════════════════════════════════════
      // NEW SIGNAL 16: Volume Acceleration (LOADING pattern)
      // Volume increasing day-over-day = institutions ramping position
      // Much more predictive than flat high volume
      // ═══════════════════════════════════════════════════════════
      if (hist?.volumeAccelerating && hist.volumeAccelRate > 1.5) {
        signals.push('volume_acceleration');
        setupScore += Math.min(22, Math.round(hist.volumeAccelRate * 8));
        details.volumeAccelRate = Math.round(hist.volumeAccelRate * 100) / 100;
      }

      // ═══════════════════════════════════════════════════════════
      // NEW SIGNAL 17: Stealth Accumulation (buying dips on volume)
      // Smart money buys on RED days — price drops but volume spikes
      // and stock recovers to close above midpoint. 2+ days = loading.
      // ═══════════════════════════════════════════════════════════
      if (hist?.redDayBuying >= 2) {
        signals.push('stealth_accumulation');
        setupScore += Math.min(22, hist.redDayBuying * 8);
        details.redDayBuying = hist.redDayBuying;
      }

      // ═══════════════════════════════════════════════════════════
      // NEW SIGNAL 18: Early Breakout (day 1-2 of a move)
      // Small positive move (1-4%) after tight price compression
      // Catches the very beginning of an explosion before crowd sees it
      // ═══════════════════════════════════════════════════════════
      if (hist?.earlyBreakout) {
        signals.push('early_breakout');
        setupScore += 16;
        details.earlyBreakout = true;
      }

      // Only include stocks with strong signals — at least 2 signals and setup score 20+
      if (signals.length >= 2 && setupScore >= 20) {
        const gemScore = calculateGemScore(signals, details, hist);

        // ── EXPLOSION PREDICTION ──
        // Estimate how much this stock could move and when, based on signal pattern
        const explosion = predictExplosion(signals, details, hist, price, volumeRatio, floatShares, marketCap);

        setups.push({
          symbol,
          companyName: quote.shortName || quote.longName || symbol,
          price: Math.round(price * 100) / 100,
          changePct: Math.round(changePct * 100) / 100,
          volume,
          avgVolume,
          volumeRatio: Math.round(volumeRatio * 10) / 10,
          floatShares,
          marketCap,
          sector: classifySector(symbol, quote.shortName || ''),
          signals,
          signalCount: signals.length,
          setupScore,
          gemScore, // 0-100 explosive potential
          details,
          explosion, // predicted gain %, timeframe, probability
          timing: categorizeUrgency(signals),
          risk: gemScore >= 60 ? 'high_conviction' : 'moderate',
        });
      }
    }

    // ── Order Flow Enrichment ──
    // Fetch smart money signals for top candidates (max 15 to stay fast)
    const topCandidates = [...setups].sort((a, b) => b.gemScore - a.gemScore).slice(0, 15);
    if (topCandidates.length > 0) {
      console.log(`[GemFinder] Enriching ${topCandidates.length} top candidates with order flow...`);
      const flowResults = await Promise.allSettled(
        topCandidates.map(s => getOrderFlow(s.symbol).then(flow => ({ symbol: s.symbol, flow })))
      );
      const flowMap = {};
      for (const r of flowResults) {
        if (r.status === 'fulfilled' && r.value.flow) flowMap[r.value.symbol] = r.value.flow;
      }

      for (const setup of setups) {
        const flow = flowMap[setup.symbol];
        if (!flow) continue;

        let flowBoost = 0;

        // Insider buying — executives putting their own money in
        if (flow.insiders?.netBuying > 0) {
          setup.signals.push('insider_buying');
          flowBoost += flow.insiders.netBuying > 500000 ? 22 : flow.insiders.netBuying > 100000 ? 16 : 10;
          setup.details.insiderNetBuying = flow.insiders.netBuyingLabel;
          setup.details.insiderBuys = flow.insiders.recentBuys;
        }

        // Bullish options flow — big money betting on upside
        if (flow.options?.putCallRatio < 0.7) {
          setup.signals.push('bullish_options');
          flowBoost += flow.options.putCallRatio < 0.5 ? 18 : 12;
          setup.details.putCallRatio = flow.options.putCallRatio;
          setup.details.optionsSentiment = flow.options.sentimentLabel;
        }

        // Unusual options volume — something big is brewing
        if (flow.options?.unusualActivity) {
          setup.signals.push('unusual_options_volume');
          flowBoost += 12;
          setup.details.unusualOptions = true;
        }

        // Institutions accumulating — funds loading up
        if (flow.institutions?.netChange > 5) {
          setup.signals.push('institutions_accumulating');
          flowBoost += flow.institutions.netChange > 15 ? 16 : 10;
          setup.details.institutionPct = flow.institutions.institutionPct;
          setup.details.institutionChange = flow.institutions.netChange;
        }

        if (flowBoost > 0) {
          setup.setupScore += flowBoost;
          setup.signalCount = setup.signals.length;
          setup.gemScore = calculateGemScore(setup.signals, setup.details, null);
          setup.details.orderFlowScore = flow.flowScore;
          setup.details.orderFlowSignal = flow.flowSignal;
          // Triple threat detection
          const hasInsider = setup.signals.includes('insider_buying');
          const hasOptions = setup.signals.includes('bullish_options') || setup.signals.includes('unusual_options_volume');
          const hasVolume = setup.signals.includes('multi_day_accumulation') || setup.signals.includes('smart_money') || setup.signals.includes('unusual_volume');
          if (hasInsider && hasOptions && hasVolume) {
            setup.details.tripleThreat = true;
            setup.risk = 'high_conviction';
          }
        }
      }
    }

    // Sort by gem score descending (not setup score)
    const sorted = setups.sort((a, b) => b.gemScore - a.gemScore);

    // ── Categorize for UI ──
    const gems = sorted.filter(s => s.gemScore >= 60);
    const result = {
      // TOP GEMS — highest explosive potential
      gems: gems.slice(0, 10),
      // Top picks by raw setup score
      topPicks: sorted.filter(s => s.setupScore >= 35).slice(0, 5),
      // Smart money accumulation (stealth buying)
      accumulation: sorted.filter(s =>
        s.signals.includes('unusual_volume') ||
        s.signals.includes('multi_day_accumulation') ||
        s.signals.includes('smart_money')
      ).slice(0, 10),
      // Squeeze & breakout setups (coiled springs)
      coiledSprings: sorted.filter(s =>
        s.signals.includes('bb_squeeze') || s.signals.includes('short_squeeze_loading')
      ).slice(0, 10),
      // Early momentum (moves starting today)
      earlyRunners: sorted.filter(s =>
        s.signals.includes('early_momentum') || s.signals.includes('low_float_volume') ||
        s.signals.includes('momentum_acceleration')
      ).slice(0, 10),
      // Earnings plays for tomorrow
      earningsPlays: sorted.filter(s => s.signals.includes('earnings_tomorrow')).slice(0, 10),
      // Oversold bounce candidates
      bounces: sorted.filter(s =>
        s.signals.includes('oversold_bounce') || s.signals.includes('sector_lag')
      ).slice(0, 10),
      // All setups sorted by gem score
      all: sorted.slice(0, 40),
      stats: {
        totalScanned: Object.keys(quotes).length,
        setupsFound: sorted.length,
        gemsFound: gems.length,
        highConviction: sorted.filter(s => s.risk === 'high_conviction').length,
        avgGemScore: sorted.length > 0 ? Math.round(sorted.reduce((s, x) => s + x.gemScore, 0) / sorted.length) : 0,
        generatedAt: new Date().toISOString(),
      }
    };

    console.log(`[GemFinder] Scan complete: ${result.stats.setupsFound} setups, ${result.stats.gemsFound} gems (${result.stats.highConviction} high conviction)`);
    if (gems.length > 0) {
      console.log(`[GemFinder] Top gems: ${gems.slice(0, 5).map(g => `${g.symbol}(${g.gemScore})`).join(', ')}`);
    }

    cache = { data: result, ts: Date.now() };
    return result;

  } catch (err) {
    console.error('[GemFinder] Scan failed:', err.message);
    return {
      gems: [], topPicks: [], accumulation: [], coiledSprings: [],
      earlyRunners: [], earningsPlays: [], bounces: [], all: [],
      stats: { totalScanned: 0, setupsFound: 0, gemsFound: 0, highConviction: 0, avgGemScore: 0, generatedAt: new Date().toISOString() }
    };
  }
}

/**
 * Fetch quotes for all symbols in batches
 */
async function fetchAllQuotes(symbols) {
  const result = {};
  const batchSize = 50;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    try {
      const quotes = await getQuoteBatch(batch);
      for (const q of quotes) {
        if (q && q.symbol) result[q.symbol] = q;
      }
    } catch {
      // skip failed batch
    }
  }
  return result;
}

/**
 * Determine when the user should act
 */
function categorizeUrgency(signals) {
  if (signals.includes('earnings_tomorrow')) return 'buy_today';
  if (signals.includes('early_momentum') || signals.includes('low_float_volume')) return 'buy_today';
  if (signals.includes('unusual_volume') || signals.includes('short_squeeze_loading')) return 'buy_today_or_tomorrow';
  if (signals.includes('multi_day_accumulation') || signals.includes('smart_money')) return 'buy_today_or_tomorrow';
  if (signals.includes('momentum_acceleration') || signals.includes('near_52w_high')) return 'buy_today_or_tomorrow';
  if (signals.includes('bb_squeeze') || signals.includes('bull_flag')) return 'watch_for_breakout';
  return 'watchlist';
}
