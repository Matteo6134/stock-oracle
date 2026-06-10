/**
 * Options Flow Scanner — Batch scan for unusual options activity
 *
 * Unusual call sweeps are the #1 predictor of big moves.
 * Institutional money shows up in options BEFORE stock price moves.
 *
 * Signals detected:
 * - call_sweep: Large call volume >> open interest (someone just bought heavy)
 * - put_call_bullish: P/C ratio < 0.5 (extreme call dominance)
 * - options_volume_spike: Total options vol > 3x estimated daily average
 * - deep_itm_calls: Large volume on deep in-the-money calls (institutional conviction)
 * - near_expiry_calls: Heavy call buying on this week's expiry (urgent bet)
 */

import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Cache: symbol → { data, ts }
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 min

/**
 * Scan options chain for a single symbol.
 * Returns signals and metrics if unusual activity is detected.
 */
async function scanSymbolOptions(symbol, currentPrice) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const chain = await yf.options(symbol);
    if (!chain?.options?.length) return null;

    const signals = [];
    let score = 0;

    // Analyze nearest 2 expiries for more signal
    const expiries = chain.options.slice(0, 2);

    let totalCallVol = 0, totalPutVol = 0;
    let totalCallOI = 0, totalPutOI = 0;
    let maxCallSweep = 0;
    let deepITMCallVol = 0;
    let nearExpiryCallVol = 0;

    for (let ei = 0; ei < expiries.length; ei++) {
      const opt = expiries[ei];
      const calls = opt.calls || [];
      const puts = opt.puts || [];
      const isNearExpiry = ei === 0; // nearest expiry

      for (const c of calls) {
        const vol = c.volume?.raw ?? c.volume ?? 0;
        const oi = c.openInterest?.raw ?? c.openInterest ?? 0;
        const strike = c.strike?.raw ?? c.strike ?? 0;

        totalCallVol += vol;
        totalCallOI += oi;

        // Call sweep: volume >> open interest (new large position)
        if (vol > 0 && oi > 0 && vol > oi * 2 && vol >= 500) {
          maxCallSweep = Math.max(maxCallSweep, vol);
        }

        // Deep ITM calls: strike < 90% of current price with high volume
        if (currentPrice > 0 && strike < currentPrice * 0.9 && vol >= 200) {
          deepITMCallVol += vol;
        }

        // Near expiry call volume
        if (isNearExpiry && vol >= 100) {
          nearExpiryCallVol += vol;
        }
      }

      for (const p of puts) {
        const vol = p.volume?.raw ?? p.volume ?? 0;
        const oi = p.openInterest?.raw ?? p.openInterest ?? 0;
        totalPutVol += vol;
        totalPutOI += oi;
      }
    }

    const putCallRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : 1;
    const totalVol = totalCallVol + totalPutVol;
    const totalOI = totalCallOI + totalPutOI;
    // Volume-to-OI ratio (V/OI) — industry standard for "unusual activity".
    // Above 1.0 means more contracts traded today than existing open positions,
    // which is what matters (not an invented "daily avg"). Requires a min
    // absolute volume floor so thinly-traded names don't trigger on noise.
    const volOIRatio = totalOI > 0 ? totalVol / totalOI : 0;

    // ── Signal detection ──

    // Call sweep detected
    if (maxCallSweep >= 1000) {
      signals.push('call_sweep_large');
      score += 20;
    } else if (maxCallSweep >= 500) {
      signals.push('call_sweep');
      score += 12;
    }

    // Extreme bullish P/C ratio
    if (putCallRatio < 0.3 && totalCallVol >= 1000) {
      signals.push('put_call_extreme_bullish');
      score += 18;
    } else if (putCallRatio < 0.5 && totalCallVol >= 500) {
      signals.push('put_call_bullish');
      score += 10;
    }

    // Options volume spike — V/OI based, with liquidity floor to avoid
    // false positives on illiquid chains
    const MIN_TOTAL_VOL = 2000; // avoid triggering on 10-contract chains
    if (volOIRatio >= 1.5 && totalVol >= MIN_TOTAL_VOL) {
      signals.push('options_volume_explosion');
      score += 16;
    } else if (volOIRatio >= 0.75 && totalVol >= MIN_TOTAL_VOL) {
      signals.push('options_volume_spike');
      score += 10;
    }

    // Deep ITM calls (institutional conviction — they're not gambling, they're loading)
    if (deepITMCallVol >= 500) {
      signals.push('deep_itm_calls');
      score += 15;
    }

    // Heavy near-expiry calls (urgent directional bet)
    if (nearExpiryCallVol >= 2000) {
      signals.push('near_expiry_call_rush');
      score += 12;
    }

    if (signals.length === 0) {
      cache.set(symbol, { data: null, ts: Date.now() });
      return null;
    }

    const data = {
      symbol,
      signals,
      score,
      putCallRatio: Math.round(putCallRatio * 100) / 100,
      totalCallVol,
      totalPutVol,
      maxCallSweep,
      deepITMCallVol,
      nearExpiryCallVol,
    };

    cache.set(symbol, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

/**
 * Batch scan options for multiple symbols.
 * Only fetches for symbols that pass a basic volume filter.
 * Returns Map<symbol, optionsData>.
 */
export async function batchScanOptions(symbols, quoteMap = {}) {
  if (!symbols?.length) return new Map();

  const results = new Map();
  const BATCH = 5; // Yahoo rate-limits options calls

  // Filter to symbols with decent volume (avoid wasting API calls on dead stocks)
  const candidates = symbols.filter(sym => {
    const q = quoteMap[sym];
    if (!q) return true; // no filter data, try anyway
    const vol = q.regularMarketVolume || q.averageDailyVolume10Day || 0;
    return vol >= 100000; // at least 100K daily volume
  }).slice(0, 60); // max 60 to avoid rate limits

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(sym => {
        const price = quoteMap[sym]?.regularMarketPrice || 0;
        return scanSymbolOptions(sym, price).then(data => ({ sym, data }));
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.data) {
        results.set(r.value.sym, r.value.data);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH < candidates.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[OptionsScanner] Scanned ${candidates.length} symbols, ${results.size} with unusual activity`);
  return results;
}
