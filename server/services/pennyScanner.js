/**
 * Penny Stock Scanner — Find explosive sub-$5 runners before they move
 *
 * Dedicated scanner for penny stocks with:
 * - Lower volume floor (50K vs 200K)
 * - Penny-specific universe + dynamic filter from main universe
 * - Penny-specific signals (micro float, dilution risk, penny breakout)
 * - User-selectable price ceiling ($1, $2, $5, $10)
 */

import { getQuoteBatch, getHistoricalData } from './yahooFinance.js';
import { getShortSqueezeSetups, STOCK_UNIVERSE } from './premarketScanner.js';
import { getOrderFlow } from './orderFlow.js';

// ── Penny-specific universe (known sub-$5 runners) ──
const PENNY_UNIVERSE = [
  // Biotech pennies
  'SNDL', 'TLRY', 'OCGN', 'VXRT', 'BNGO', 'SER', 'INBS', 'AQST', 'NKTR', 'MNKD',
  'CABA', 'MDXH', 'APRE', 'QURE', 'DNA', 'NVAX',
  // EV / Clean Energy pennies
  'NKLA', 'GOEV', 'WKHS', 'FCEL', 'PLUG', 'CHPT', 'BLDP', 'GEVO',
  // Meme / volatile pennies
  'AMC', 'FFIE', 'MULN', 'NILE', 'WISA', 'WISH', 'CLOV',
  // Space / Tech micro-caps
  'SPCE', 'ASTR', 'RDW', 'JOBY', 'LILM',
  // Lidar / Sensors
  'LAZR', 'MVIS',
  // Cannabis
  'CGC', 'ACB', 'HEXO', 'OGI', 'GRWG',
  // Additional volatile micro-caps
  'OPEN', 'STEM', 'QS', 'LCID', 'NIO', 'XPEV',
  'IONQ', 'RGTI', 'QUBT',
  // Mining / Resources
  'VALE', 'BTG', 'CDE', 'HL', 'AG',
  // Misc penny runners
  'BBAI', 'ASTS', 'LUNR', 'RKLB', 'ENVX',
];

// ── Cache keyed by maxPrice ──
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
let inflight = new Map();

/**
 * Scan for penny stocks under maxPrice.
 * @param {number} maxPrice - Maximum price (default $5)
 */
export async function scanPennyStocks(maxPrice = 5) {
  const key = String(maxPrice);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  if (inflight.has(key)) return inflight.get(key);

  const promise = _scan(maxPrice).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ── History analysis (same pattern as tomorrowMovers) ──
function analyzeHistory(bars) {
  if (!bars || bars.length < 10) return null;

  const recent = bars.slice(-20);
  const closes = recent.map(b => b.close).filter(Boolean);
  const volumes = recent.map(b => b.volume).filter(Boolean);
  const highs = recent.map(b => b.high).filter(Boolean);
  const lows = recent.map(b => b.low).filter(Boolean);

  if (closes.length < 10 || volumes.length < 10) return null;

  const result = {
    volumeTrend: 0,
    smartMoneyScore: 0,
    momentumAccel: 0,
    priceCompression: 0,
    volumeStreakDays: 0,
    closingStrength: 0,
  };

  // Volume trend: last 5 vs prior 10
  const last5Vol = volumes.slice(-5);
  const prior10Vol = volumes.slice(-15, -5);
  if (prior10Vol.length >= 5) {
    const avgLast5 = last5Vol.reduce((s, v) => s + v, 0) / last5Vol.length;
    const avgPrior10 = prior10Vol.reduce((s, v) => s + v, 0) / prior10Vol.length;
    if (avgPrior10 > 0) result.volumeTrend = avgLast5 / avgPrior10;
  }

  // Volume streak
  const overallAvgVol = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  let streak = 0;
  for (let i = volumes.length - 1; i >= 0; i--) {
    if (volumes[i] > overallAvgVol * 1.2) streak++;
    else break;
  }
  result.volumeStreakDays = streak;

  // Closing strength
  const closingPositions = [];
  for (let i = Math.max(0, closes.length - 5); i < closes.length; i++) {
    const range = highs[i] - lows[i];
    if (range > 0) closingPositions.push((closes[i] - lows[i]) / range);
  }
  if (closingPositions.length > 0) {
    result.closingStrength = closingPositions.reduce((s, v) => s + v, 0) / closingPositions.length;
  }

  // Smart money
  const avgClosingPos = result.closingStrength;
  const recentVolAboveAvg = last5Vol.filter(v => v > overallAvgVol).length;
  if (avgClosingPos > 0.65 && recentVolAboveAvg >= 3) {
    result.smartMoneyScore = Math.round(avgClosingPos * recentVolAboveAvg * 4);
  }

  // Momentum acceleration
  if (closes.length >= 6) {
    const ret3d = (closes[closes.length - 1] / closes[closes.length - 4] - 1) * 100;
    const ret5d = (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100;
    result.momentumAccel = ret3d > 0 && ret3d > ret5d * 0.7 ? ret3d : 0;
  }

  // Price compression
  const recent5High = Math.max(...highs.slice(-5));
  const recent5Low = Math.min(...lows.slice(-5));
  const full20High = Math.max(...highs);
  const full20Low = Math.min(...lows);
  const fullRange = full20High - full20Low;
  const recentRange = recent5High - recent5Low;
  if (fullRange > 0) result.priceCompression = 1 - (recentRange / fullRange);

  return result;
}

// ── Gem Score for penny stocks ──
function calculatePennyScore(signals, details, hist) {
  let score = 0;
  const weights = {
    // Standard signals
    unusual_volume: 15,
    multi_day_accumulation: 20,
    smart_money: 18,
    short_squeeze_loading: 16,
    bb_squeeze: 12,
    early_momentum: 12,
    momentum_acceleration: 14,
    low_float_volume: 12,
    oversold_bounce: 6,
    price_compression: 8,
    // Penny-specific signals
    penny_breakout: 18,
    micro_float: 15,
    penny_squeeze: 16,
    penny_volume_spike: 14,
    dilution_risk: -10, // NEGATIVE — deducts score
    // Order flow signals (smart money)
    insider_buying: 20,
    bullish_options: 16,
    institutions_accumulating: 14,
    unusual_options_volume: 12,
  };

  for (const sig of signals) {
    score += weights[sig] || 5;
  }

  // Multi-signal bonus
  if (signals.length >= 4) score *= 1.3;
  else if (signals.length >= 3) score *= 1.15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

async function _scan(maxPrice) {
  try {
    // Build universe: penny-specific + anything from main universe
    const mainSymbols = [
      ...STOCK_UNIVERSE.SMALL_MID_CAPS,
      ...STOCK_UNIVERSE.BIOTECH_PHARMA,
      ...STOCK_UNIVERSE.MEME_VOLATILE,
      ...STOCK_UNIVERSE.RECENT_IPOS,
    ];
    const allSymbols = [...new Set([...PENNY_UNIVERSE, ...mainSymbols])];

    console.log(`[PennyScanner] Scanning ${allSymbols.length} symbols for pennies under $${maxPrice}...`);

    // Fetch quotes in batches
    const quotes = {};
    const BATCH = 50;
    for (let i = 0; i < allSymbols.length; i += BATCH) {
      const batch = allSymbols.slice(i, i + BATCH);
      try {
        const qs = await getQuoteBatch(batch);
        for (const q of qs) {
          if (q && q.symbol) quotes[q.symbol] = q;
        }
      } catch { /* skip failed batch */ }
    }

    // Fetch squeeze data for penny symbols
    const pennySymbols = Object.entries(quotes)
      .filter(([, q]) => q.regularMarketPrice && q.regularMarketPrice >= 0.10 && q.regularMarketPrice <= maxPrice)
      .map(([sym]) => sym);

    const squeezeData = await getShortSqueezeSetups(pennySymbols.slice(0, 80)).catch(() => []);
    const squeezeLookup = {};
    for (const s of squeezeData) squeezeLookup[s.symbol] = s;

    // Fetch history for candidates with some volume
    const histCandidates = pennySymbols.filter(sym => {
      const q = quotes[sym];
      const vol = q.regularMarketVolume || 0;
      const avgVol = q.averageDailyVolume10Day || q.averageDailyVolume3Month || vol;
      const volRatio = avgVol > 0 ? vol / avgVol : 1;
      return vol >= 50000 && (volRatio > 1.0 || squeezeLookup[sym]);
    }).slice(0, 60);

    console.log(`[PennyScanner] Fetching history for ${histCandidates.length} penny candidates...`);

    const historyMap = {};
    for (let i = 0; i < histCandidates.length; i += 10) {
      const batch = histCandidates.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(sym => getHistoricalData(sym).then(bars => ({ sym, bars })))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.bars?.length > 0) {
          historyMap[r.value.sym] = analyzeHistory(r.value.bars);
        }
      }
    }

    // ── Analyze each penny stock ──
    const setups = [];

    for (const symbol of pennySymbols) {
      const quote = quotes[symbol];
      if (!quote) continue;

      const price = quote.regularMarketPrice;
      if (!price || price < 0.10 || price > maxPrice) continue;

      const volume = quote.regularMarketVolume || 0;
      const avgVolume = quote.averageDailyVolume10Day || quote.averageDailyVolume3Month || volume;
      if (volume < 50000) continue; // Lower floor for pennies

      const changePct = quote.regularMarketChangePercent || 0;
      const floatShares = quote.floatShares || quote.sharesOutstanding || 0;
      const sharesOutstanding = quote.sharesOutstanding || 0;
      const marketCap = quote.marketCap || 0;
      const fiftyDayAvg = quote.fiftyDayAverage || price;
      const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1;
      const hist = historyMap[symbol] || null;

      const signals = [];
      let setupScore = 0;
      const details = {};

      // ── Standard signals (same as Gem Finder) ──

      // Unusual volume
      if (volumeRatio >= 2 && Math.abs(changePct) < 5) {
        signals.push('unusual_volume');
        setupScore += Math.min(20, Math.round(volumeRatio * 3));
        details.volumeRatio = Math.round(volumeRatio * 10) / 10;
      }

      // Multi-day accumulation
      if (hist && hist.volumeTrend > 1.3 && hist.volumeStreakDays >= 2) {
        signals.push('multi_day_accumulation');
        setupScore += Math.min(25, Math.round(hist.volumeTrend * 8 + hist.volumeStreakDays * 3));
        details.volumeStreakDays = hist.volumeStreakDays;
      }

      // Smart money
      if (hist && hist.smartMoneyScore > 8) {
        signals.push('smart_money');
        setupScore += Math.min(20, hist.smartMoneyScore);
        details.closingStrength = Math.round(hist.closingStrength * 100);
      }

      // Early momentum
      if (volumeRatio >= 1.5 && changePct > 1 && changePct < 8) {
        signals.push('early_momentum');
        setupScore += 12;
      }

      // Momentum acceleration
      if (hist && hist.momentumAccel > 2) {
        signals.push('momentum_acceleration');
        setupScore += Math.min(15, Math.round(hist.momentumAccel * 2));
        details.momentumAccel = Math.round(hist.momentumAccel * 100) / 100;
      }

      // Short squeeze loading
      const sq = squeezeLookup[symbol];
      if (sq) {
        const shortPct = sq.shortPercentOfFloat || 0;
        if (shortPct > 15 && changePct > -2) {
          signals.push('short_squeeze_loading');
          setupScore += shortPct > 30 ? 20 : shortPct > 20 ? 15 : 10;
          details.shortPercentOfFloat = shortPct;
          details.daysToCover = sq.shortRatio || 0;
        }
      }

      // BB squeeze (price compression)
      if (hist && hist.priceCompression > 0.65 && volumeRatio > 0.8) {
        signals.push('bb_squeeze');
        setupScore += 10;
        details.priceCompression = Math.round(hist.priceCompression * 100);
      }

      // Low float + volume
      if (floatShares > 0 && floatShares < 50_000_000 && volumeRatio >= 1.3) {
        signals.push('low_float_volume');
        setupScore += floatShares < 10_000_000 ? 15 : floatShares < 20_000_000 ? 10 : 6;
        details.floatShares = floatShares;
      }

      // Oversold bounce
      if (price < fiftyDayAvg * 0.80 && volumeRatio < 0.8) {
        signals.push('oversold_bounce');
        setupScore += 8;
        details.distanceFrom50MA = Math.round(((price / fiftyDayAvg) - 1) * 100);
      }

      // Price compression
      if (hist && hist.priceCompression > 0.6 && !signals.includes('bb_squeeze')) {
        signals.push('price_compression');
        setupScore += 6;
      }

      // ── Penny-specific signals ──

      // Penny Breakout: price up >5% on 2x+ volume
      if (changePct > 5 && volumeRatio >= 2) {
        signals.push('penny_breakout');
        setupScore += 18;
        details.pennyBreakout = true;
      }

      // Micro Float: float < 10M shares — explosive potential
      if (floatShares > 0 && floatShares < 10_000_000) {
        signals.push('micro_float');
        setupScore += 15;
        details.microFloat = true;
        details.floatShares = floatShares;
      }

      // Penny Squeeze: SI >20% on sub-$5 stock
      if (sq && (sq.shortPercentOfFloat || 0) > 20 && price < 5) {
        if (!signals.includes('short_squeeze_loading')) {
          signals.push('penny_squeeze');
          setupScore += 14;
        }
        details.pennySqueeze = true;
      }

      // Penny Volume Spike: 5x+ average volume
      if (volumeRatio >= 5) {
        signals.push('penny_volume_spike');
        setupScore += 14;
        details.volumeSpike = true;
      }

      // Dilution Risk: shares outstanding >> float (negative signal)
      if (floatShares > 0 && sharesOutstanding > 0 && sharesOutstanding > floatShares * 3) {
        signals.push('dilution_risk');
        setupScore -= 8;
        details.dilutionRisk = true;
        details.dilutionRatio = Math.round((sharesOutstanding / floatShares) * 10) / 10;
      }

      // Require at least 1 signal for pennies (lower bar than main scanner)
      if (signals.length >= 1 && setupScore >= 10) {
        const gemScore = calculatePennyScore(signals, details, hist);

        setups.push({
          symbol,
          companyName: quote.shortName || quote.longName || symbol,
          price: Math.round(price * 10000) / 10000, // 4 decimal places for sub-$1
          changePct: Math.round(changePct * 100) / 100,
          volume,
          avgVolume,
          volumeRatio: Math.round(volumeRatio * 10) / 10,
          floatShares,
          marketCap,
          signals,
          signalCount: signals.length,
          setupScore,
          gemScore,
          details,
          timing: categorizeTiming(signals, changePct),
          risk: gemScore >= 50 ? 'high_potential' : 'speculative',
        });
      }
    }

    // ── Order Flow Enrichment ──
    // Fetch smart money signals for top candidates (max 12 to stay fast)
    const topCandidates = [...setups].sort((a, b) => b.gemScore - a.gemScore).slice(0, 12);
    if (topCandidates.length > 0) {
      console.log(`[PennyScanner] Enriching ${topCandidates.length} top candidates with order flow...`);
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

        if (flow.insiders?.netBuying > 0) {
          setup.signals.push('insider_buying');
          flowBoost += flow.insiders.netBuying > 500000 ? 22 : flow.insiders.netBuying > 100000 ? 16 : 10;
          setup.details.insiderNetBuying = flow.insiders.netBuyingLabel;
          setup.details.insiderBuys = flow.insiders.recentBuys;
        }

        if (flow.options?.putCallRatio < 0.7) {
          setup.signals.push('bullish_options');
          flowBoost += flow.options.putCallRatio < 0.5 ? 18 : 12;
          setup.details.putCallRatio = flow.options.putCallRatio;
          setup.details.optionsSentiment = flow.options.sentimentLabel;
        }

        if (flow.options?.unusualActivity) {
          setup.signals.push('unusual_options_volume');
          flowBoost += 12;
          setup.details.unusualOptions = true;
        }

        if (flow.institutions?.netChange > 5) {
          setup.signals.push('institutions_accumulating');
          flowBoost += flow.institutions.netChange > 15 ? 16 : 10;
          setup.details.institutionPct = flow.institutions.institutionPct;
          setup.details.institutionChange = flow.institutions.netChange;
        }

        if (flowBoost > 0) {
          setup.setupScore += flowBoost;
          setup.signalCount = setup.signals.length;
          setup.gemScore = calculatePennyScore(setup.signals, setup.details, null);
          setup.details.orderFlowScore = flow.flowScore;
          setup.details.orderFlowSignal = flow.flowSignal;
          // Triple threat: insider + options + volume = extremely high conviction
          const hasInsider = setup.signals.includes('insider_buying');
          const hasOptions = setup.signals.includes('bullish_options') || setup.signals.includes('unusual_options_volume');
          const hasVolume = setup.signals.includes('multi_day_accumulation') || setup.signals.includes('smart_money') || setup.signals.includes('unusual_volume');
          if (hasInsider && hasOptions && hasVolume) {
            setup.details.tripleThreat = true;
            setup.risk = 'high_potential';
          }
        }
      }
    }

    // Sort by gem score
    const sorted = setups.sort((a, b) => b.gemScore - a.gemScore);

    const result = {
      stocks: sorted.slice(0, 50),
      stats: {
        totalScanned: Object.keys(quotes).length,
        pennyFound: pennySymbols.length,
        setupsFound: sorted.length,
        highPotential: sorted.filter(s => s.risk === 'high_potential').length,
        maxPrice,
        avgGemScore: sorted.length > 0 ? Math.round(sorted.reduce((s, x) => s + x.gemScore, 0) / sorted.length) : 0,
        generatedAt: new Date().toISOString(),
      },
    };

    console.log(`[PennyScanner] Found ${result.stats.setupsFound} penny setups under $${maxPrice} (${result.stats.highPotential} high potential)`);
    cache.set(String(maxPrice), { data: result, ts: Date.now() });
    return result;

  } catch (err) {
    console.error('[PennyScanner] Scan failed:', err.message);
    return {
      stocks: [],
      stats: { totalScanned: 0, pennyFound: 0, setupsFound: 0, highPotential: 0, maxPrice, avgGemScore: 0, generatedAt: new Date().toISOString() },
    };
  }
}

function categorizeTiming(signals, changePct) {
  if (signals.includes('penny_breakout')) return 'breaking_out';
  if (signals.includes('penny_volume_spike')) return 'volume_alert';
  if (signals.includes('early_momentum')) return 'starting_move';
  if (signals.includes('short_squeeze_loading') || signals.includes('penny_squeeze')) return 'squeeze_setup';
  if (signals.includes('multi_day_accumulation') || signals.includes('smart_money')) return 'accumulating';
  if (signals.includes('oversold_bounce')) return 'bounce_setup';
  return 'watching';
}
