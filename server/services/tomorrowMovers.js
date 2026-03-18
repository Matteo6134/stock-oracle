/**
 * Tomorrow's Big Movers Detector
 *
 * Scans stocks DURING regular hours to find setups that predict
 * 20-100%+ moves in the next 1-3 days. This gives the user time
 * to buy during market hours BEFORE the move happens.
 *
 * Key predictive signals:
 * 1. Unusual Volume Accumulation — big volume, small price move = smart money loading
 * 2. Bollinger Band Squeeze — volatility at extreme low, breakout imminent
 * 3. Short Squeeze Loading — high SI + price rising = shorts getting trapped
 * 4. Earnings Catalyst Tomorrow — stock coiling before earnings
 * 5. Volume Dry-Up After Selloff — selling exhaustion, bounce incoming
 * 6. Sector Lag Play — sector is hot, this stock hasn't moved yet
 * 7. Low Float + Rising Volume — small supply + demand = explosive potential
 */

import { getQuoteBatch, getHistoricalData, getEarningsCalendar } from './yahooFinance.js';
import { getShortSqueezeSetups, getBreakoutSetups, STOCK_UNIVERSE } from './premarketScanner.js';
import { classifySector, getSectorTrends } from './sectorAnalysis.js';

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

async function _scan() {
  try {
    // Build full symbol universe
    const allSymbols = [
      ...STOCK_UNIVERSE.SMALL_MID_CAPS,
      ...STOCK_UNIVERSE.BIOTECH_PHARMA,
      ...STOCK_UNIVERSE.MEME_VOLATILE,
      ...STOCK_UNIVERSE.RECENT_IPOS,
    ];
    const unique = [...new Set(allSymbols)];

    // Fetch data in parallel
    const [quotes, sectorTrends, earningsCal, squeezeData, breakoutData] = await Promise.all([
      fetchAllQuotes(unique),
      getSectorTrends().catch(() => []),
      getEarningsCalendar().catch(() => []),
      getShortSqueezeSetups(unique.slice(0, 80)).catch(() => []),
      getBreakoutSetups(unique.slice(0, 80)).catch(() => []),
    ]);

    // Build sector performance map
    const sectorMap = {};
    for (const s of sectorTrends) {
      sectorMap[s.sector] = s;
    }

    // Build squeeze lookup
    const squeezeLookup = {};
    for (const s of squeezeData) {
      squeezeLookup[s.symbol] = s;
    }

    // Build breakout lookup
    const breakoutLookup = {};
    for (const b of breakoutData) {
      breakoutLookup[b.symbol] = b;
    }

    // Earnings tomorrow lookup
    const earningsTomorrow = new Set();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    for (const e of earningsCal) {
      if (e.date === tomorrowStr || e.when === 'pre-market') {
        earningsTomorrow.add(e.symbol);
      }
    }

    // Analyze each stock for setup signals
    const setups = [];

    for (const [symbol, quote] of Object.entries(quotes)) {
      if (!quote || !quote.regularMarketPrice) continue;
      if (quote.regularMarketPrice < 2) continue; // skip penny stocks
      if ((quote.regularMarketVolume || 0) < 100000) continue; // skip illiquid

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

      // Volume ratio
      const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;

      // ═══════════════════════════════════════════════════════
      // SIGNAL 1: Unusual Volume Accumulation (stealth buying)
      // High volume but price barely moved = someone loading shares
      // ═══════════════════════════════════════════════════════
      if (volumeRatio >= 2 && Math.abs(changePct) < 3) {
        const accumulationScore = Math.min(20, Math.round(volumeRatio * 3));
        signals.push('unusual_volume');
        setupScore += accumulationScore;
        details.volumeRatio = Math.round(volumeRatio * 10) / 10;
        details.accumulation = true;
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 2: Volume Surge + Upward Momentum (early runner)
      // Volume > 1.5x AND price up 1-5% = move starting
      // ═══════════════════════════════════════════════════════
      if (volumeRatio >= 1.5 && changePct > 1 && changePct < 5) {
        signals.push('early_momentum');
        setupScore += 12;
        details.earlyRunner = true;
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 3: Short Squeeze Loading
      // High short interest + stock NOT going down = shorts trapped
      // ═══════════════════════════════════════════════════════
      const sq = squeezeLookup[symbol];
      if (sq) {
        const shortPct = sq.shortPercentOfFloat || 0;
        if (shortPct > 15 && changePct > -1) {
          const sqScore = shortPct > 30 ? 20 : shortPct > 20 ? 15 : 10;
          signals.push('short_squeeze_loading');
          setupScore += sqScore;
          details.shortPercentOfFloat = shortPct;
          details.daysToCover = sq.daysToCover || 0;
        }
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 4: Bollinger Band Squeeze (volatility explosion coming)
      // ═══════════════════════════════════════════════════════
      const bo = breakoutLookup[symbol];
      if (bo) {
        if (bo.bbSqueeze) {
          signals.push('bb_squeeze');
          setupScore += 12;
          details.bbWidth = bo.bbWidth;
        }
        if (bo.volumeContraction) {
          signals.push('volume_contraction');
          setupScore += 6;
        }
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 5: Earnings Catalyst Tomorrow
      // Stock consolidating before earnings = potential big gap
      // ═══════════════════════════════════════════════════════
      if (earningsTomorrow.has(symbol)) {
        signals.push('earnings_tomorrow');
        setupScore += 15;
        details.earningsTomorrow = true;
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 6: Low Float + Volume Rising
      // Small supply + increasing demand = explosive potential
      // ═══════════════════════════════════════════════════════
      if (floatShares > 0 && floatShares < 50_000_000) {
        const floatBonus = floatShares < 10_000_000 ? 15 : floatShares < 20_000_000 ? 10 : 6;
        if (volumeRatio >= 1.3) {
          signals.push('low_float_volume');
          setupScore += floatBonus;
          details.floatShares = floatShares;
          details.floatCategory = floatShares < 10_000_000 ? 'micro' : floatShares < 20_000_000 ? 'tiny' : 'low';
        }
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 7: Sector Lag Play
      // Sector is up big but this stock hasn't moved = catch-up potential
      // ═══════════════════════════════════════════════════════
      const sector = classifySector(symbol, quote.shortName || '');
      const sectorData = sectorMap[sector];
      if (sectorData && sectorData.avgChange > 1.5 && changePct < sectorData.avgChange * 0.3) {
        signals.push('sector_lag');
        setupScore += 8;
        details.sectorName = sector;
        details.sectorChange = sectorData.avgChange;
        details.stockChange = Math.round(changePct * 100) / 100;
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 8: Oversold Bounce Setup
      // Stock dropped significantly below 50-day MA + volume drying up
      // = selling exhaustion, bounce likely
      // ═══════════════════════════════════════════════════════
      if (price < fiftyDayAvg * 0.85 && volumeRatio < 0.7) {
        signals.push('oversold_bounce');
        setupScore += 8;
        details.distanceFrom50MA = Math.round(((price / fiftyDayAvg) - 1) * 100);
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 9: Bull Flag / Consolidation After Run
      // Stock ran up recently, now consolidating on low volume
      // ═══════════════════════════════════════════════════════
      if (price > fiftyDayAvg * 1.1 && volumeRatio < 0.8 && Math.abs(changePct) < 2) {
        signals.push('bull_flag');
        setupScore += 7;
        details.aboveFiftyDay = Math.round(((price / fiftyDayAvg) - 1) * 100);
      }

      // ═══════════════════════════════════════════════════════
      // SIGNAL 10: Golden Cross Proximity
      // 50-day MA crossing above 200-day MA = major bullish signal
      // ═══════════════════════════════════════════════════════
      if (fiftyDayAvg > 0 && twoHundredDayAvg > 0) {
        const maRatio = fiftyDayAvg / twoHundredDayAvg;
        if (maRatio > 0.97 && maRatio < 1.03 && fiftyDayAvg > twoHundredDayAvg) {
          signals.push('golden_cross');
          setupScore += 6;
        }
      }

      // Only include stocks with at least one signal and minimum score
      if (signals.length >= 1 && setupScore >= 10) {
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
          details,
          // Timing category
          timing: categorizeUrgency(signals),
          // Risk level
          risk: setupScore > 30 ? 'high_conviction' : setupScore > 20 ? 'moderate' : 'speculative',
        });
      }
    }

    // Sort by setup score descending
    const sorted = setups.sort((a, b) => b.setupScore - a.setupScore);

    // Categorize for the UI
    const result = {
      // Top 5 highest conviction plays
      topPicks: sorted.filter(s => s.setupScore >= 25).slice(0, 5),
      // Accumulation patterns (stealth buying)
      accumulation: sorted.filter(s => s.signals.includes('unusual_volume')).slice(0, 10),
      // Squeeze & breakout setups (coiled springs)
      coiledSprings: sorted.filter(s =>
        s.signals.includes('bb_squeeze') || s.signals.includes('short_squeeze_loading')
      ).slice(0, 10),
      // Early momentum (moves starting today)
      earlyRunners: sorted.filter(s =>
        s.signals.includes('early_momentum') || s.signals.includes('low_float_volume')
      ).slice(0, 10),
      // Earnings plays for tomorrow
      earningsPlays: sorted.filter(s => s.signals.includes('earnings_tomorrow')).slice(0, 10),
      // Oversold bounce candidates
      bounces: sorted.filter(s =>
        s.signals.includes('oversold_bounce') || s.signals.includes('sector_lag')
      ).slice(0, 10),
      // All setups sorted by score
      all: sorted.slice(0, 30),
      stats: {
        totalScanned: Object.keys(quotes).length,
        setupsFound: sorted.length,
        highConviction: sorted.filter(s => s.risk === 'high_conviction').length,
        avgScore: sorted.length > 0 ? Math.round(sorted.reduce((s, x) => s + x.setupScore, 0) / sorted.length) : 0,
        generatedAt: new Date().toISOString(),
      }
    };

    cache = { data: result, ts: Date.now() };
    return result;

  } catch (err) {
    console.error('[TomorrowMovers] Scan failed:', err.message);
    return { topPicks: [], accumulation: [], coiledSprings: [], earlyRunners: [], earningsPlays: [], bounces: [], all: [], stats: { totalScanned: 0, setupsFound: 0, highConviction: 0, avgScore: 0, generatedAt: new Date().toISOString() } };
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
  if (signals.includes('bb_squeeze') || signals.includes('bull_flag')) return 'watch_for_breakout';
  return 'watchlist';
}
