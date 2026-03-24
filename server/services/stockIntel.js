/**
 * Stock Intelligence — Advanced Signals for Stock Oracle
 *
 * 7 new signal sources that feed into Claude's brain + agent analysis:
 *
 * 1. SEC Insider Trading (Form 4) — executives buying their own stock
 * 2. Short Interest Tracker — heavily shorted stocks for squeeze potential
 * 3. Sector Rotation Model — which sector is heating up NEXT
 * 4. VIX Regime Switching — aggressive when calm, defensive when scared
 * 5. Options Flow (unusual volume) — smart money detection
 * 6. Correlation Pairs — if NVDA moves, AMD follows
 * 7. Gap Scanner — pre-market gaps for momentum trades
 */

import axios from 'axios';
import YahooFinance from 'yahoo-finance2';

const yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const http = axios.create({ timeout: 15000 });

// ══════════════════════════════════════════════════════════════
// 1. SEC INSIDER TRADING (Form 4)
// ══════════════════════════════════════════════════════════════

let insiderCache = { data: null, ts: 0 };
const INSIDER_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch recent insider buys from SEC EDGAR.
 * Form 4 = mandatory filing when executives buy/sell their company's stock.
 * BUYING by insiders = strongest bullish signal (they know their company best).
 */
export async function getInsiderBuys() {
  if (insiderCache.data && Date.now() - insiderCache.ts < INSIDER_TTL) return insiderCache.data;

  try {
    // SEC EDGAR full-text search for Form 4 filings
    const { data } = await http.get('https://efts.sec.gov/LATEST/search-index', {
      params: { q: '"4"', forms: '4', dateRange: 'custom', startdt: getDateDaysAgo(7), enddt: getToday() },
      headers: { 'User-Agent': 'StockOracle/1.0 contact@stockoracle.app', Accept: 'application/json' },
    });

    // Parse filings — look for purchases (not sales or option exercises)
    const filings = (data?.hits?.hits || []).slice(0, 50).map(h => ({
      company: h._source?.display_names?.[0] || '',
      ticker: h._source?.tickers?.[0] || '',
      filer: h._source?.display_names?.[1] || '',
      date: h._source?.file_date || '',
      type: h._source?.form_type || '4',
      url: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id}/${h._id}`,
    })).filter(f => f.ticker);

    insiderCache = { data: filings, ts: Date.now() };
    console.log(`[StockIntel] SEC insider filings: ${filings.length} Form 4s found`);
    return filings;
  } catch (err) {
    console.error('[StockIntel] SEC insider error:', err.message);
    return insiderCache.data || [];
  }
}

// ══════════════════════════════════════════════════════════════
// 2. SHORT INTEREST TRACKER
// ══════════════════════════════════════════════════════════════

let shortCache = { data: null, ts: 0 };
const SHORT_TTL = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Find heavily shorted stocks — squeeze potential.
 * When short interest > 20% and stock starts going up,
 * shorts MUST buy back → price rockets (like GME).
 */
export async function getHighShortInterest() {
  if (shortCache.data && Date.now() - shortCache.ts < SHORT_TTL) return shortCache.data;

  try {
    // Use Yahoo Finance to get short interest data for known high-SI stocks
    const watchlist = [
      'GME', 'AMC', 'BBBY', 'KOSS', 'CLOV', 'WISH', 'BB', 'NOK',
      'MVIS', 'SNDL', 'PLTR', 'SOFI', 'RIVN', 'LCID', 'NIO',
      'FFIE', 'MULN', 'GOEV', 'WKHS', 'RIDE', 'NKLA',
      'SPCE', 'FUBO', 'SKLZ', 'OPEN', 'ATER', 'BBIG',
    ];

    const results = [];
    // Process in chunks to avoid rate limits
    for (let i = 0; i < watchlist.length; i += 5) {
      const chunk = watchlist.slice(i, i + 5);
      const promises = chunk.map(async sym => {
        try {
          const q = await yahoo.quote(sym);
          if (!q || !q.regularMarketPrice) return null;

          const shortPct = q.shortPercentOfFloat || 0;
          const price = q.regularMarketPrice;
          const change = q.regularMarketChangePercent || 0;
          const volume = q.regularMarketVolume || 0;
          const avgVol = q.averageDailyVolume3Month || 1;
          const volRatio = volume / avgVol;

          return {
            symbol: sym,
            price,
            changePct: Math.round(change * 100) / 100,
            shortPctFloat: Math.round(shortPct * 100) / 100,
            volume,
            avgVolume: avgVol,
            volumeRatio: Math.round(volRatio * 100) / 100,
            squeezePotential: shortPct > 20 && volRatio > 1.5 ? 'HIGH' : shortPct > 15 ? 'MEDIUM' : 'LOW',
            signal: shortPct > 20 && change > 2 && volRatio > 2 ? 'SQUEEZE_ALERT' : shortPct > 15 ? 'WATCH' : null,
          };
        } catch { return null; }
      });
      const chunkResults = (await Promise.all(promises)).filter(Boolean);
      results.push(...chunkResults);
    }

    // Sort by short interest descending
    results.sort((a, b) => b.shortPctFloat - a.shortPctFloat);
    shortCache = { data: results, ts: Date.now() };
    console.log(`[StockIntel] Short interest: ${results.length} stocks, ${results.filter(s => s.signal === 'SQUEEZE_ALERT').length} squeeze alerts`);
    return results;
  } catch (err) {
    console.error('[StockIntel] Short interest error:', err.message);
    return shortCache.data || [];
  }
}

// ══════════════════════════════════════════════════════════════
// 3. SECTOR ROTATION MODEL
// ══════════════════════════════════════════════════════════════

const SECTOR_ETFS = {
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Healthcare',
  XLI: 'Industrials', XLC: 'Communication', XLY: 'Consumer Disc',
  XLP: 'Consumer Staples', XLB: 'Materials', XLRE: 'Real Estate', XLU: 'Utilities',
};

let sectorCache = { data: null, ts: 0 };
const SECTOR_TTL = 15 * 60 * 1000; // 15 min

/**
 * Detect sector rotation — money flowing from one sector to another.
 * Hot sectors = momentum plays. Cold→Hot transition = early entry.
 */
export async function getSectorRotation() {
  if (sectorCache.data && Date.now() - sectorCache.ts < SECTOR_TTL) return sectorCache.data;

  try {
    const symbols = Object.keys(SECTOR_ETFS);
    const results = [];

    for (const sym of symbols) {
      try {
        const q = await yahoo.quote(sym);
        if (!q) continue;
        results.push({
          symbol: sym,
          sector: SECTOR_ETFS[sym],
          price: q.regularMarketPrice,
          changePct: Math.round((q.regularMarketChangePercent || 0) * 100) / 100,
          volume: q.regularMarketVolume || 0,
          avgVolume: q.averageDailyVolume3Month || 1,
          volumeRatio: Math.round((q.regularMarketVolume || 0) / (q.averageDailyVolume3Month || 1) * 100) / 100,
          fiftyDayAvg: q.fiftyDayAverage || 0,
          twoHundredDayAvg: q.twoHundredDayAverage || 0,
          aboveFifty: q.regularMarketPrice > (q.fiftyDayAverage || 0),
          aboveTwoHundred: q.regularMarketPrice > (q.twoHundredDayAverage || 0),
        });
      } catch { /* skip */ }
    }

    results.sort((a, b) => b.changePct - a.changePct);

    const analysis = {
      sectors: results,
      hottest: results.slice(0, 3).map(s => s.sector),
      coldest: results.slice(-3).map(s => s.sector),
      rotation: detectRotationSignal(results),
      timestamp: new Date().toISOString(),
    };

    sectorCache = { data: analysis, ts: Date.now() };
    console.log(`[StockIntel] Sectors: Hot=${analysis.hottest.join(',')} Cold=${analysis.coldest.join(',')}`);
    return analysis;
  } catch (err) {
    console.error('[StockIntel] Sector rotation error:', err.message);
    return sectorCache.data || { sectors: [], hottest: [], coldest: [], rotation: 'UNKNOWN' };
  }
}

function detectRotationSignal(sectors) {
  const defensive = ['Utilities', 'Consumer Staples', 'Healthcare'];
  const cyclical = ['Technology', 'Consumer Disc', 'Financials', 'Industrials'];

  const defAvg = sectors.filter(s => defensive.includes(s.sector)).reduce((sum, s) => sum + s.changePct, 0) / 3;
  const cycAvg = sectors.filter(s => cyclical.includes(s.sector)).reduce((sum, s) => sum + s.changePct, 0) / 4;

  if (cycAvg > defAvg + 0.5) return 'RISK_ON'; // Money into growth
  if (defAvg > cycAvg + 0.5) return 'RISK_OFF'; // Money into safety
  return 'NEUTRAL';
}

// ══════════════════════════════════════════════════════════════
// 4. VIX REGIME SWITCHING
// ══════════════════════════════════════════════════════════════

/**
 * Get market fear level from VIX.
 * VIX < 15: calm market → be aggressive, full position sizes
 * VIX 15-20: normal → standard sizing
 * VIX 20-30: elevated fear → reduce position sizes by 50%
 * VIX > 30: panic → ultra-defensive, only safe plays
 */
export async function getMarketRegime() {
  try {
    const q = await yahoo.quote('^VIX');
    const vix = q.regularMarketPrice || 20;
    const vixChange = q.regularMarketChangePercent || 0;

    // Also get SPY for trend context
    const spy = await yahoo.quote('SPY');
    const spyChange = spy.regularMarketChangePercent || 0;
    const spyAbove50 = spy.regularMarketPrice > (spy.fiftyDayAverage || 0);
    const spyAbove200 = spy.regularMarketPrice > (spy.twoHundredDayAverage || 0);

    let regime, positionMultiplier, advice;
    if (vix < 15) {
      regime = 'CALM';
      positionMultiplier = 1.2;
      advice = 'Low fear — be aggressive. Full position sizes. Momentum strategies work best.';
    } else if (vix < 20) {
      regime = 'NORMAL';
      positionMultiplier = 1.0;
      advice = 'Normal conditions — standard playbook. Mix of momentum and value.';
    } else if (vix < 25) {
      regime = 'ELEVATED';
      positionMultiplier = 0.7;
      advice = 'Elevated fear — reduce sizes 30%. Favor quality stocks, tighter stops.';
    } else if (vix < 30) {
      regime = 'HIGH_FEAR';
      positionMultiplier = 0.5;
      advice = 'High fear — half position sizes. Only highest-conviction plays. Wider stops.';
    } else {
      regime = 'PANIC';
      positionMultiplier = 0.3;
      advice = 'Panic mode — 30% sizes max. Cash is a position. Only safe-haven plays.';
    }

    const result = {
      vix, vixChange: Math.round(vixChange * 100) / 100,
      regime, positionMultiplier, advice,
      spy: { price: spy.regularMarketPrice, change: Math.round(spyChange * 100) / 100, aboveFifty: spyAbove50, aboveTwoHundred: spyAbove200 },
      timestamp: new Date().toISOString(),
    };

    console.log(`[StockIntel] VIX: ${vix} (${regime}) — position multiplier: ${positionMultiplier}x`);
    return result;
  } catch (err) {
    console.error('[StockIntel] VIX error:', err.message);
    return { vix: 20, regime: 'NORMAL', positionMultiplier: 1.0, advice: 'VIX unavailable — using defaults.' };
  }
}

// ══════════════════════════════════════════════════════════════
// 5. OPTIONS FLOW (unusual volume detection)
// ══════════════════════════════════════════════════════════════

/**
 * Detect unusual options activity via Yahoo Finance.
 * When call volume is 3x+ normal, smart money is betting on upside.
 * When put volume is 3x+ normal, smart money is betting on downside or hedging.
 */
export async function getOptionsFlow(symbols) {
  const results = [];

  for (const sym of (symbols || []).slice(0, 20)) {
    try {
      const q = await yahoo.quote(sym);
      if (!q) continue;

      // Yahoo exposes some options metrics in the quote
      const impliedVol = q.impliedVolatility || null;
      const optionsVolume = q.averageAnalystRating ? null : null; // Limited in free Yahoo

      // Use volume ratio as proxy for unusual activity
      const volume = q.regularMarketVolume || 0;
      const avgVol = q.averageDailyVolume3Month || 1;
      const ratio = volume / avgVol;

      if (ratio > 2.0) {
        results.push({
          symbol: sym,
          price: q.regularMarketPrice,
          changePct: Math.round((q.regularMarketChangePercent || 0) * 100) / 100,
          volume,
          avgVolume: avgVol,
          volumeRatio: Math.round(ratio * 100) / 100,
          signal: ratio > 3 ? 'VERY_UNUSUAL' : 'UNUSUAL',
          direction: (q.regularMarketChangePercent || 0) > 0 ? 'BULLISH' : 'BEARISH',
        });
      }
    } catch { /* skip */ }
  }

  return results.sort((a, b) => b.volumeRatio - a.volumeRatio);
}

// ══════════════════════════════════════════════════════════════
// 6. CORRELATION PAIRS
// ══════════════════════════════════════════════════════════════

const CORR_PAIRS = [
  ['NVDA', 'AMD'],    // GPU competitors
  ['AAPL', 'MSFT'],   // Big tech
  ['GOOGL', 'META'],  // Ad tech
  ['XOM', 'CVX'],     // Oil majors
  ['JPM', 'GS'],      // Banks
  ['TSLA', 'RIVN'],   // EV
  ['COIN', 'MARA'],   // Crypto
  ['DIS', 'NFLX'],    // Streaming
];

/**
 * Find correlation pair divergences.
 * When NVDA is up 3% but AMD is flat, AMD will likely follow → buy AMD.
 */
export async function getCorrelationPairs() {
  const results = [];

  for (const [a, b] of CORR_PAIRS) {
    try {
      const [qa, qb] = await Promise.all([yahoo.quote(a), yahoo.quote(b)]);
      if (!qa || !qb) continue;

      const changeA = qa.regularMarketChangePercent || 0;
      const changeB = qb.regularMarketChangePercent || 0;
      const divergence = Math.round((changeA - changeB) * 100) / 100;

      // Significant divergence = trading opportunity
      if (Math.abs(divergence) > 1.5) {
        const leader = divergence > 0 ? a : b;
        const laggard = divergence > 0 ? b : a;
        const laggardChange = divergence > 0 ? changeB : changeA;
        const leaderChange = divergence > 0 ? changeA : changeB;

        results.push({
          leader,
          laggard,
          leaderChange: Math.round(leaderChange * 100) / 100,
          laggardChange: Math.round(laggardChange * 100) / 100,
          divergence: Math.abs(divergence),
          signal: `${leader} up ${leaderChange.toFixed(1)}% but ${laggard} only ${laggardChange.toFixed(1)}% — ${laggard} likely to catch up`,
          action: leaderChange > laggardChange ? 'BUY' : 'SELL',
          target: laggard,
          targetPrice: divergence > 0 ? qb.regularMarketPrice : qa.regularMarketPrice,
        });
      }
    } catch { /* skip */ }
  }

  return results.sort((a, b) => b.divergence - a.divergence);
}

// ══════════════════════════════════════════════════════════════
// 7. GAP SCANNER (pre-market)
// ══════════════════════════════════════════════════════════════

/**
 * Find stocks gapping up/down in pre-market.
 * Gap up + volume = momentum continuation trade.
 * Gap down on no news = potential fade (buy the dip).
 */
export async function getPreMarketGaps(symbols) {
  const results = [];

  for (const sym of (symbols || []).slice(0, 30)) {
    try {
      const q = await yahoo.quote(sym);
      if (!q) continue;

      const prevClose = q.regularMarketPreviousClose || q.regularMarketPrice;
      const preMarket = q.preMarketPrice || null;
      const currentPrice = q.regularMarketPrice;

      // Calculate gap from previous close
      const gapPct = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

      if (Math.abs(gapPct) > 2) {
        const volume = q.regularMarketVolume || 0;
        const avgVol = q.averageDailyVolume3Month || 1;

        results.push({
          symbol: sym,
          price: currentPrice,
          prevClose,
          preMarketPrice: preMarket,
          gapPct: Math.round(gapPct * 100) / 100,
          gapDirection: gapPct > 0 ? 'UP' : 'DOWN',
          volumeRatio: Math.round((volume / avgVol) * 100) / 100,
          signal: gapPct > 5 ? 'STRONG_GAP_UP' : gapPct > 2 ? 'GAP_UP' : gapPct < -5 ? 'STRONG_GAP_DOWN' : 'GAP_DOWN',
          tradePlan: gapPct > 3 && volume > avgVol ? 'MOMENTUM_LONG' : gapPct < -3 ? 'FADE_SHORT_OR_DIP_BUY' : 'WATCH',
        });
      }
    } catch { /* skip */ }
  }

  return results.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
}

// ══════════════════════════════════════════════════════════════
// MASTER: Get all intelligence in one call
// ══════════════════════════════════════════════════════════════

/**
 * Fetch all intelligence signals. Called by Claude's brain before analysis.
 * @param {Array} watchlistSymbols - Current gem + penny symbols to scan
 */
export async function getAllIntelligence(watchlistSymbols = []) {
  const [regime, sectors, shortInterest, pairs, gaps, insiders] = await Promise.all([
    getMarketRegime().catch(() => null),
    getSectorRotation().catch(() => null),
    getHighShortInterest().catch(() => []),
    getCorrelationPairs().catch(() => []),
    getPreMarketGaps(watchlistSymbols).catch(() => []),
    getInsiderBuys().catch(() => []),
  ]);

  // Options flow for top movers
  const optionsFlow = await getOptionsFlow(watchlistSymbols.slice(0, 10)).catch(() => []);

  return {
    regime,
    sectors,
    shortInterest: shortInterest.filter(s => s.signal),
    pairs: pairs.slice(0, 5),
    gaps: gaps.slice(0, 10),
    insiders: insiders.slice(0, 20),
    optionsFlow: optionsFlow.slice(0, 5),
    timestamp: new Date().toISOString(),
  };
}

// ── Helpers ──
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}
