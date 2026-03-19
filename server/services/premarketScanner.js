import YahooFinance from 'yahoo-finance2';
import { getQuoteBatch, getHistoricalData } from './yahooFinance.js';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// ────────────────────────────────────────────────────────────────────────────
// Stock Universe (~200 symbols organized by category)
// ────────────────────────────────────────────────────────────────────────────

const SMALL_MID_CAPS = [
  // Fintech / Growth
  'SOFI', 'HOOD', 'UPST', 'AFRM', 'SQ', 'SHOP', 'NU', 'PAGS', 'STNE', 'FUTU', 'TIGR',
  // Cloud / Cyber / SaaS
  'NET', 'CRWD', 'SNOW', 'DDOG', 'ZS', 'BILL', 'MDB', 'S',
  // Consumer / Social / Streaming
  'PLTR', 'SNAP', 'PINS', 'ROKU', 'DKNG', 'RBLX', 'HIMS', 'CELH', 'MNST', 'MAX', 'GRAB',
  // Semis / Hardware
  'SMCI', 'ARM', 'IONQ', 'RGTI', 'QUBT', 'ON', 'MRVL', 'LSCC', 'SWKS', 'QRVO',
  'NXPI', 'MTSI', 'ACLS', 'POWI', 'DIOD', 'SLAB',
  // EV / Clean Energy
  'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'CHPT', 'PLUG', 'FCEL', 'BLDP', 'QS', 'NKLA', 'GOEV', 'WKHS',
  // Space / Defense
  'SPCE', 'ASTR', 'RDW', 'LUNR', 'RKLB', 'ASTS', 'JOBY', 'LILM', 'BBAI',
  // Green / Alt Energy
  'GEVO', 'BE', 'STEM', 'ENVX', 'WOLF', 'DNA',
  // Lidar / Sensors
  'LAZR', 'MVIS',
  // LatAm / Asia ecommerce
  'SE', 'MELI', 'BABA', 'PDD', 'JD', 'BIDU', 'TME', 'CPNG',
  // Misc small caps
  'CLOV', 'WISH', 'OPEN',
];

const BIOTECH_PHARMA = [
  // mRNA / Vaccines
  'MRNA', 'BNTX', 'NVAX',
  // Gene Editing / Therapy
  'CRSP', 'EDIT', 'NTLA', 'BEAM',
  // Rare Disease / Specialty
  'SRPT', 'SGEN', 'RARE', 'VRTX', 'BMRN',
  // Antisense / RNA
  'IONS', 'ALNY',
  // Oncology / Immunology
  'REGN', 'EXEL', 'INCY', 'HALO',
  // Clinical-stage
  'PCVX', 'IOVA', 'RCKT', 'FATE', 'KRTX', 'PRAX', 'ARVN', 'GTHX', 'TGTX',
];

const MEME_VOLATILE = [
  'GME', 'AMC', 'BBBY', 'BB', 'NOK', 'CLOV', 'WISH',
  'IRNT', 'ATER', 'FAZE', 'MULN', 'FFIE', 'NILE',
  'PHUN', 'DWAC', 'BENE', 'WISA',
];

const RECENT_IPOS = [
  'ARM', 'BIRK', 'CART', 'CAVA', 'KVYO', 'TOST', 'DUOL',
  'BROS', 'DNUT', 'VRT', 'SMCI', 'ONON', 'CELH',
];

// ────────────────────────────────────────────────────────────────────────────
// Caches
// ────────────────────────────────────────────────────────────────────────────

const scannerCache = { data: null, timestamp: 0 };
const SCANNER_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

const squeezeCache = { data: null, timestamp: 0 };
const SQUEEZE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

const breakoutCache = { data: null, timestamp: 0 };
const BREAKOUT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// In-flight dedup
let inflightScanPromise = null;
let inflightSqueezePromise = null;

// ────────────────────────────────────────────────────────────────────────────
// Utility: Float rotation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calculate float rotation ratio.
 * Returns volume / floatShares. A value above 1.0 means the entire float
 * has traded hands — a hallmark of explosive moves.
 */
export function calcFloatRotation(volume, floatShares) {
  if (!floatShares || floatShares <= 0 || !volume || volume <= 0) return 0;
  return Math.round((volume / floatShares) * 1000) / 1000;
}

// ────────────────────────────────────────────────────────────────────────────
// Build the full universe (deduplicated)
// ────────────────────────────────────────────────────────────────────────────

function buildUniverse(earningsCalendar = []) {
  const earningsSymbols = earningsCalendar
    .map(e => (e.symbol || e.ticker || '').toUpperCase())
    .filter(Boolean);

  const all = [
    ...earningsSymbols,
    ...SMALL_MID_CAPS,
    ...BIOTECH_PHARMA,
    ...MEME_VOLATILE,
    ...RECENT_IPOS,
  ];

  // Deduplicate
  return [...new Set(all)];
}

// ────────────────────────────────────────────────────────────────────────────
// Classify a stock into signal types
// ────────────────────────────────────────────────────────────────────────────

function classifySignals(stock) {
  const signals = [];
  const { gapPct, volumeRatio, floatShares, hasPositiveEarningsHistory } = stock;
  const absGap = Math.abs(gapPct);

  if (gapPct > 8 && volumeRatio > 3) {
    signals.push('gap_up_explosive');
  }
  if (gapPct > 3 && volumeRatio > 2) {
    signals.push('gap_up_momentum');
  }
  if (gapPct < -5 && hasPositiveEarningsHistory) {
    signals.push('gap_down_bounce');
  }
  if (volumeRatio > 5) {
    signals.push('volume_spike');
  }
  if (floatShares && floatShares < 50_000_000 && gapPct > 2) {
    signals.push('low_float_runner');
  }

  return signals;
}

// ────────────────────────────────────────────────────────────────────────────
// Main scanner
// ────────────────────────────────────────────────────────────────────────────

/**
 * Scan the full universe for pre-market movers.
 * @param {Array} earningsCalendar - Array of earnings objects with .symbol
 * @returns {Array} Top 30 movers sorted by impact score
 */
export async function scanPremarketMovers(earningsCalendar = []) {
  // Check cache
  if (scannerCache.data && (Date.now() - scannerCache.timestamp) < SCANNER_CACHE_TTL) {
    return scannerCache.data;
  }

  // Dedup in-flight
  if (inflightScanPromise) return inflightScanPromise;

  inflightScanPromise = (async () => {
    try {
      const universe = buildUniverse(earningsCalendar);
      console.log(`[PremarketScanner] Scanning ${universe.length} symbols across all categories...`);

      // Track which symbols came from earnings calendar for the positive-earnings flag
      const earningsSymbolSet = new Set(
        (earningsCalendar || []).map(e => (e.symbol || e.ticker || '').toUpperCase()).filter(Boolean)
      );

      // Fetch quotes in batches of 50
      const BATCH_SIZE = 50;
      const allQuotes = [];

      for (let i = 0; i < universe.length; i += BATCH_SIZE) {
        const batch = universe.slice(i, i + BATCH_SIZE);
        try {
          const quotes = await getQuoteBatch(batch);
          allQuotes.push(...quotes);
        } catch (err) {
          console.warn(`[PremarketScanner] Batch ${i / BATCH_SIZE + 1} failed:`, err.message);
        }
      }

      console.log(`[PremarketScanner] Got ${allQuotes.length} quotes back from ${universe.length} symbols`);

      // Process each quote
      const movers = [];

      for (const q of allQuotes) {
        if (!q || !q.symbol) continue;

        const symbol = q.symbol;
        const previousClose = q.regularMarketPreviousClose || q.previousClose;
        const preMarketPrice = q.preMarketPrice;
        const regularPrice = q.regularMarketPrice;

        // We need previous close and at least one current price
        if (!previousClose || previousClose <= 0) continue;

        // Prefer pre-market price; fall back to regular for after-hours analysis
        const currentPrice = preMarketPrice || regularPrice;
        if (!currentPrice || currentPrice <= 0) continue;

        // Gap percentage
        const gapPct = ((currentPrice - previousClose) / previousClose) * 100;

        // Volume ratio: pre-market volume vs average daily volume
        const preMarketVol = q.preMarketVolume || 0;
        const avgVol = q.averageDailyVolume10Day || q.averageDailyVolume3Month || q.averageVolume10days || q.averageVolume || 1;
        // For pre-market, even a fraction of the avg daily volume is significant
        // Compare pre-market vol to avg vol (whole day). A ratio of 0.5 in pre-market
        // already suggests massive interest.
        const volumeRatio = avgVol > 0 ? preMarketVol / avgVol : 0;

        // Float shares (from quote if available)
        const floatShares = q.floatShares || q.sharesOutstanding || null;

        // Short interest (limited in standard quote, but some fields may exist)
        const shortInterest = q.shortPercentOfFloat || null;

        // Positive earnings history heuristic: if it's in the earnings calendar,
        // assume it COULD have positive history (caller can refine)
        const hasPositiveEarningsHistory = earningsSymbolSet.has(symbol);

        // Only include if there is a meaningful signal — 5%+ gap or extreme volume
        const absGap = Math.abs(gapPct);
        const hasSignal = absGap >= 5 || (volumeRatio > 3 && absGap > 2);
        if (!hasSignal) continue;
        // Min price $5 to skip penny stocks
        if (currentPrice < 5) continue;

        const entry = {
          symbol,
          companyName: q.shortName || q.longName || symbol,
          price: Math.round(currentPrice * 100) / 100,
          currentPrice: Math.round(currentPrice * 100) / 100,
          previousClose: Math.round(previousClose * 100) / 100,
          preMarketPrice: preMarketPrice ? Math.round(preMarketPrice * 100) / 100 : null,
          gapPct: Math.round(gapPct * 100) / 100,
          preMarketVolume: preMarketVol,
          avgVolume: Math.round(avgVol),
          volumeRatio: Math.round(volumeRatio * 100) / 100,
          floatShares: floatShares || null,
          floatRotation: calcFloatRotation(preMarketVol, floatShares),
          shortInterest: shortInterest ? Math.round(shortInterest * 100) / 100 : null,
          marketCap: q.marketCap || null,
          hasPositiveEarningsHistory,
          isEarningsPlay: earningsSymbolSet.has(symbol),
          signals: [],
          impactScore: 0,
        };

        entry.signals = classifySignals(entry);
        entry.impactScore = Math.round(Math.abs(gapPct) * Math.max(volumeRatio, 0.1) * 100) / 100;

        movers.push(entry);
      }

      // Sort by impact score descending, take top 30
      movers.sort((a, b) => b.impactScore - a.impactScore);
      const top30 = movers.slice(0, 30);

      console.log(`[PremarketScanner] Found ${movers.length} movers, returning top ${top30.length}`);
      if (top30.length > 0) {
        const topSymbols = top30.slice(0, 5).map(m => `${m.symbol}(${m.gapPct > 0 ? '+' : ''}${m.gapPct}%)`);
        console.log(`[PremarketScanner] Top movers: ${topSymbols.join(', ')}`);
      }

      scannerCache.data = top30;
      scannerCache.timestamp = Date.now();
      return top30;
    } catch (err) {
      console.error('[PremarketScanner] Scan failed:', err.message);
      return scannerCache.data || [];
    } finally {
      inflightScanPromise = null;
    }
  })();

  return inflightScanPromise;
}

// ────────────────────────────────────────────────────────────────────────────
// Squeeze Classification & Price Target Engine
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify squeeze type and predict price targets.
 *
 * Types:
 * - MOASS: SI > 50%, DTC > 8, low float → extreme squeeze (100-500%+)
 * - Short Squeeze: SI > 20%, DTC > 3 → forced covering (30-100%)
 * - Gamma Squeeze: High SI + rapidly increasing call options (estimated from volume surge)
 * - Squeeze Watch: SI > 15%, needs catalyst → potential (15-40%)
 *
 * Price targets based on historical squeeze patterns:
 * - The higher the SI% and DTC, the more violent the squeeze
 * - Low float amplifies the move (less shares to absorb buying pressure)
 * - Volume/float ratio indicates buying pressure intensity
 */
function classifySqueeze(shortPct, daysToCover, floatShares, currentPrice, avgVolume) {
  const si = shortPct ?? 0;
  const dtc = daysToCover ?? 0;
  const fl = floatShares ?? 0;
  const price = currentPrice ?? 0;

  if (price <= 0) return { squeezeType: 'unknown', targets: null, probability: 0, explanation: '' };

  // ── Classification ──
  let squeezeType = 'watch';
  let minGain = 15, midGain = 30, maxGain = 60;
  let probability = 20;

  // MOASS conditions: extreme SI + high DTC + low float
  if (si >= 50 && dtc >= 8) {
    squeezeType = 'moass';
    minGain = 100; midGain = 250; maxGain = 500;
    probability = 15; // rare but explosive
  } else if (si >= 50 && dtc >= 5) {
    squeezeType = 'moass';
    minGain = 80; midGain = 200; maxGain = 400;
    probability = 20;
  }
  // Short Squeeze: high SI, meaningful DTC
  else if (si >= 30 && dtc >= 5) {
    squeezeType = 'short_squeeze';
    minGain = 50; midGain = 100; maxGain = 200;
    probability = 30;
  } else if (si >= 20 && dtc >= 3) {
    squeezeType = 'short_squeeze';
    minGain = 30; midGain = 60; maxGain = 120;
    probability = 35;
  }
  // Gamma Squeeze potential: moderate SI + high volume activity
  else if (si >= 15 && avgVolume && fl > 0 && (avgVolume / fl) > 0.03) {
    squeezeType = 'gamma_squeeze';
    minGain = 25; midGain = 50; maxGain = 100;
    probability = 25;
  }
  // Squeeze Watch: meets threshold but needs catalyst
  else if (si >= 15 || dtc >= 5) {
    squeezeType = 'squeeze_watch';
    minGain = 15; midGain = 30; maxGain = 60;
    probability = 15;
  }

  // ── Float amplifier ── low float = more explosive
  if (fl > 0 && fl < 10e6) {
    minGain *= 1.5; midGain *= 1.5; maxGain *= 1.5; probability += 5;
  } else if (fl > 0 && fl < 30e6) {
    minGain *= 1.2; midGain *= 1.2; maxGain *= 1.2; probability += 3;
  }

  // ── DTC amplifier ── longer to cover = more violent squeeze
  if (dtc >= 10) {
    minGain *= 1.3; midGain *= 1.3; maxGain *= 1.3; probability += 5;
  }

  // Cap probability
  probability = Math.min(probability, 60);

  // ── Price targets ──
  const targets = {
    conservative: Math.round(price * (1 + minGain / 100) * 100) / 100,
    moderate: Math.round(price * (1 + midGain / 100) * 100) / 100,
    extreme: Math.round(price * (1 + maxGain / 100) * 100) / 100,
    conservativeGain: Math.round(minGain),
    moderateGain: Math.round(midGain),
    extremeGain: Math.round(maxGain),
  };

  // ── Explanation ──
  const typeLabels = {
    moass: 'MOASS (Mother Of All Short Squeezes)',
    short_squeeze: 'Short Squeeze',
    gamma_squeeze: 'Gamma Squeeze',
    squeeze_watch: 'Squeeze Watch',
  };

  const explanations = {
    moass: `Extreme setup: ${si.toFixed(1)}% of shares are sold short with ${dtc.toFixed(1)} days to cover. If buying pressure starts, shorts need ${dtc.toFixed(0)}+ days to exit — creating a violent chain reaction. ${fl < 30e6 ? 'Low float amplifies the move.' : ''}`,
    short_squeeze: `${si.toFixed(1)}% short interest with ${dtc.toFixed(1)} days to cover. When shorts are forced to buy back shares, demand spikes while supply is limited. A catalyst (earnings beat, news, volume surge) could trigger forced covering.`,
    gamma_squeeze: `${si.toFixed(1)}% short interest combined with high options activity. Market makers hedging call options are forced to buy shares, pushing price up, which forces more hedging — a self-reinforcing loop.`,
    squeeze_watch: `${si.toFixed(1)}% short interest detected — above average but needs a catalyst to trigger. Watch for volume spikes, positive news, or earnings surprises that could start the squeeze.`,
  };

  return {
    squeezeType,
    squeezeLabel: typeLabels[squeezeType] || 'Unknown',
    targets,
    probability,
    explanation: explanations[squeezeType] || '',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Short Squeeze Setups
// ────────────────────────────────────────────────────────────────────────────

/**
 * Identify short squeeze candidates from a list of symbols.
 * Fetches defaultKeyStatistics from quoteSummary for each symbol.
 * Filters for high short interest (>15%) or high days-to-cover (>5).
 * @param {string[]} symbols - Array of ticker symbols to check
 * @returns {Array} Sorted by squeeze potential (shortPct * shortRatio)
 */
export async function getShortSqueezeSetups(symbols = []) {
  if (!symbols || symbols.length === 0) return [];

  // Check cache
  const cacheKey = symbols.sort().join(',');
  if (
    squeezeCache.data &&
    squeezeCache.cacheKey === cacheKey &&
    (Date.now() - squeezeCache.timestamp) < SQUEEZE_CACHE_TTL
  ) {
    return squeezeCache.data;
  }

  if (inflightSqueezePromise) return inflightSqueezePromise;

  inflightSqueezePromise = (async () => {
    try {
      console.log(`[PremarketScanner] Checking ${symbols.length} symbols for short squeeze setups...`);

      const results = [];

      // Process in parallel batches of 10 to avoid rate limiting
      const BATCH_SIZE = 10;
      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (symbol) => {
            try {
              const summary = await yf.quoteSummary(symbol, {
                modules: ['defaultKeyStatistics', 'price'],
              });

              const stats = summary?.defaultKeyStatistics;
              if (!stats) return null;

              const shortPercentOfFloat = stats.shortPercentOfFloat?.raw ?? stats.shortPercentOfFloat ?? null;
              const sharesShort = stats.sharesShort?.raw ?? stats.sharesShort ?? null;
              const shortRatio = stats.shortRatio?.raw ?? stats.shortRatio ?? null;
              const floatShares = stats.floatShares?.raw ?? stats.floatShares ?? null;
              const sharesOutstanding = stats.sharesOutstanding?.raw ?? stats.sharesOutstanding ?? null;

              // Convert shortPercentOfFloat to percentage if it's a decimal < 1
              const shortPct = shortPercentOfFloat != null
                ? (shortPercentOfFloat < 1 ? shortPercentOfFloat * 100 : shortPercentOfFloat)
                : null;

              // Filter: shortPct > 15% OR shortRatio (days to cover) > 5
              const meetsThreshold =
                (shortPct != null && shortPct > 15) ||
                (shortRatio != null && shortRatio > 5);

              if (!meetsThreshold) return null;

              const squeezePotential =
                (shortPct || 0) * (shortRatio || 1);

              // ── Squeeze Classification & Price Prediction ──
              const price = summary?.price?.regularMarketPrice?.raw
                ?? summary?.price?.regularMarketPrice ?? null;
              const avgVol = summary?.defaultKeyStatistics?.averageDailyVolume10Day?.raw
                ?? summary?.price?.averageDailyVolume10Day?.raw ?? null;

              const analysis = classifySqueeze(shortPct, shortRatio, floatShares, price, avgVol);

              return {
                symbol,
                shortPercentOfFloat: shortPct != null ? Math.round(shortPct * 100) / 100 : null,
                sharesShort,
                shortRatio: shortRatio != null ? Math.round(shortRatio * 100) / 100 : null,
                floatShares,
                sharesOutstanding,
                squeezePotential: Math.round(squeezePotential * 100) / 100,
                floatRotation: calcFloatRotation(sharesShort, floatShares),
                price: price ?? null,
                ...analysis,
              };
            } catch (err) {
              // Silently skip symbols that fail
              return null;
            }
          })
        );

        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value) {
            results.push(r.value);
          }
        }
      }

      // Sort by squeeze potential descending
      results.sort((a, b) => b.squeezePotential - a.squeezePotential);

      console.log(`[PremarketScanner] Found ${results.length} short squeeze candidates`);
      if (results.length > 0) {
        const top3 = results.slice(0, 3).map(r => `${r.symbol}(SI:${r.shortPercentOfFloat}%, DTC:${r.shortRatio})`);
        console.log(`[PremarketScanner] Top squeeze setups: ${top3.join(', ')}`);
      }

      squeezeCache.data = results;
      squeezeCache.cacheKey = cacheKey;
      squeezeCache.timestamp = Date.now();
      return results;
    } catch (err) {
      console.error('[PremarketScanner] Short squeeze scan failed:', err.message);
      return squeezeCache.data || [];
    } finally {
      inflightSqueezePromise = null;
    }
  })();

  return inflightSqueezePromise;
}

// ────────────────────────────────────────────────────────────────────────────
// Breakout / Bollinger Squeeze Setups
// ────────────────────────────────────────────────────────────────────────────

/**
 * Simple Moving Average.
 */
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * Standard deviation.
 */
function stddev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((sum, v) => sum + v, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

/**
 * Identify breakout / "coiled spring" setups using Bollinger Band squeeze
 * and volume contraction analysis.
 *
 * A stock is "coiled" when:
 *   1. Bollinger Band width is at its 20-bar low (squeeze)
 *   2. Volume is contracting (recent avg < historical avg * 0.7)
 *   3. Price range is contracting (last 5 bars tighter than last 20)
 *
 * @param {string[]} symbols - Symbols to analyze
 * @returns {Array} Stocks with active squeeze setups
 */
export async function getBreakoutSetups(symbols = []) {
  if (!symbols || symbols.length === 0) return [];

  // Check cache
  const cacheKey = symbols.sort().join(',');
  if (
    breakoutCache.data &&
    breakoutCache.cacheKey === cacheKey &&
    (Date.now() - breakoutCache.timestamp) < BREAKOUT_CACHE_TTL
  ) {
    return breakoutCache.data;
  }

  console.log(`[PremarketScanner] Analyzing ${symbols.length} symbols for breakout setups...`);

  const results = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          const bars = await getHistoricalData(symbol);
          if (!bars || bars.length < 20) return null;

          // Use last 20 bars
          const recent20 = bars.slice(-20);
          const closes = recent20.map(b => b.close).filter(v => v != null && v > 0);
          const volumes = recent20.map(b => b.volume).filter(v => v != null && v > 0);
          const highs = recent20.map(b => b.high).filter(v => v != null && v > 0);
          const lows = recent20.map(b => b.low).filter(v => v != null && v > 0);

          if (closes.length < 20 || volumes.length < 20) return null;

          // ── Bollinger Band analysis ──
          const period = 20;
          const middle = sma(closes, period);
          const sd = stddev(closes, period);
          if (!middle || !sd || middle === 0) return null;

          const upperBand = middle + 2 * sd;
          const lowerBand = middle - 2 * sd;
          const currentBBWidth = (upperBand - lowerBand) / middle;

          // Calculate BB width for each rolling window to find if current is at 20-bar low
          const bbWidths = [];
          for (let j = 0; j < closes.length; j++) {
            if (j < period - 1) continue;
            const windowCloses = closes.slice(j - period + 1, j + 1);
            const wMean = windowCloses.reduce((s, v) => s + v, 0) / period;
            const wVar = windowCloses.reduce((s, v) => s + (v - wMean) ** 2, 0) / period;
            const wSd = Math.sqrt(wVar);
            const wUpper = wMean + 2 * wSd;
            const wLower = wMean - 2 * wSd;
            bbWidths.push(wMean > 0 ? (wUpper - wLower) / wMean : 999);
          }

          const minBBWidth = bbWidths.length > 0 ? Math.min(...bbWidths) : 999;
          const isBBSqueeze = bbWidths.length > 0 && currentBBWidth <= minBBWidth * 1.05; // within 5% of min

          // ── Volume contraction ──
          const recentVolAvg5 = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
          const fullVolAvg20 = volumes.reduce((s, v) => s + v, 0) / volumes.length;
          const isVolumeContracting = recentVolAvg5 < fullVolAvg20 * 0.7;

          // ── Price range contraction ──
          const recentRange5 = Math.max(...highs.slice(-5)) - Math.min(...lows.slice(-5));
          const fullRange20 = Math.max(...highs) - Math.min(...lows);
          const rangeRatio = fullRange20 > 0 ? recentRange5 / fullRange20 : 1;
          const isPriceContracting = rangeRatio < 0.4; // last 5 bars use less than 40% of 20-bar range

          // A valid breakout setup requires BB squeeze AND at least one of the other two
          const isCoiledSpring = isBBSqueeze && (isVolumeContracting || isPriceContracting);

          if (!isCoiledSpring) return null;

          const lastClose = closes[closes.length - 1];

          return {
            symbol,
            lastClose: Math.round(lastClose * 100) / 100,
            bbWidth: Math.round(currentBBWidth * 10000) / 10000,
            minBBWidth: Math.round(minBBWidth * 10000) / 10000,
            isBBSqueeze,
            volumeContraction: Math.round((recentVolAvg5 / fullVolAvg20) * 100) / 100,
            isVolumeContracting,
            rangeContraction: Math.round(rangeRatio * 100) / 100,
            isPriceContracting,
            // Strength score: tighter squeeze + lower volume = more explosive potential
            squeezeStrength: Math.round(
              (1 / Math.max(currentBBWidth, 0.001)) *
              (1 / Math.max(recentVolAvg5 / fullVolAvg20, 0.01)) *
              (1 / Math.max(rangeRatio, 0.01))
            ),
            upperBand: Math.round(upperBand * 100) / 100,
            lowerBand: Math.round(lowerBand * 100) / 100,
            middleBand: Math.round(middle * 100) / 100,
          };
        } catch (err) {
          return null;
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      }
    }
  }

  // Sort by squeeze strength descending
  results.sort((a, b) => b.squeezeStrength - a.squeezeStrength);

  console.log(`[PremarketScanner] Found ${results.length} breakout/coiled-spring setups`);
  if (results.length > 0) {
    const top3 = results.slice(0, 3).map(r => `${r.symbol}(BBW:${r.bbWidth}, VC:${r.volumeContraction})`);
    console.log(`[PremarketScanner] Top breakout setups: ${top3.join(', ')}`);
  }

  breakoutCache.data = results;
  breakoutCache.cacheKey = cacheKey;
  breakoutCache.timestamp = Date.now();
  return results;
}

// ────────────────────────────────────────────────────────────────────────────
// Exports summary for convenience
// ────────────────────────────────────────────────────────────────────────────

export const STOCK_UNIVERSE = {
  SMALL_MID_CAPS,
  BIOTECH_PHARMA,
  MEME_VOLATILE,
  RECENT_IPOS,
  get ALL() {
    return buildUniverse();
  },
};
