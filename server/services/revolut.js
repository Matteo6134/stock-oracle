/**
 * Revolut Stock Filter
 *
 * Revolut offers ~3,000+ US stocks from NYSE and NASDAQ.
 * They exclude: OTC/Pink Sheets, very small micro-caps (<$50M mkt cap),
 * some recent IPOs, and delisted stocks.
 *
 * Strategy:
 * 1. Maintain a known-excluded list (OTC tickers, delisted)
 * 2. Filter by exchange (NYSE, NASDAQ only)
 * 3. Filter by minimum market cap ($50M)
 * 4. Cache results to avoid repeated lookups
 */

import { getQuoteBatch } from './yahooFinance.js';

// ── Known NON-Revolut tickers ──
// OTC, Pink Sheets, delisted, or too small for Revolut
const EXCLUDED_TICKERS = new Set([
  // Delisted / OTC
  'BBBY', 'FFIE', 'NILE', 'BENE', 'WISA', 'FAZE', 'MULN',
  'DWAC', // merged into TMTG / DJT
  // Very small / obscure micro-caps unlikely on Revolut
  'JFB', 'ROMA', 'ANNA', 'MRLN', 'CUEN', 'BIMI', 'LIQT', 'SOPA', 'WIMI',
  'DTSS', 'SOS', 'CODA', 'MBOT', 'BIOR', 'SLDB', 'RVPH',
  'WKSP', 'CINT', 'PRPL', 'MNTS', 'VORB',
  // Cannabis (Revolut often excludes these)
  'SNDL', 'TLRY', 'MAPS', 'GRWG',
  // Chinese ADRs with compliance issues
  'BTBT',
]);

// ── Known Revolut-available tickers (confirmed popular) ──
const CONFIRMED_REVOLUT = new Set([
  // Mega-cap / Large-cap (always on Revolut)
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD', 'NFLX', 'CRM',
  'ORCL', 'ADBE', 'INTC', 'QCOM', 'AVGO', 'TXN', 'MU', 'LRCX', 'AMAT', 'KLAC',
  // Popular mid-caps (confirmed on Revolut)
  'PLTR', 'SOFI', 'HOOD', 'UPST', 'AFRM', 'SQ', 'SHOP', 'NU', 'SNAP', 'PINS',
  'ROKU', 'DKNG', 'RBLX', 'HIMS', 'NET', 'CRWD', 'SNOW', 'DDOG', 'ZS', 'MDB',
  'ARM', 'SMCI', 'IONQ', 'ON', 'MRVL', 'NXPI',
  // EV / Clean Energy (popular, on Revolut)
  'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'PLUG', 'QS',
  // Space / Defense
  'RKLB', 'JOBY', 'LUNR',
  // Biotech (established)
  'MRNA', 'BNTX', 'CRSP', 'REGN', 'VRTX', 'ALNY', 'EXEL', 'INCY',
  // E-commerce / Asia
  'SE', 'MELI', 'BABA', 'PDD', 'JD', 'CPNG',
  // Recent IPOs (popular, confirmed)
  'BIRK', 'CART', 'CAVA', 'KVYO', 'TOST', 'DUOL', 'VRT', 'ONON',
  // Meme (popular enough for Revolut)
  'GME', 'AMC', 'BB', 'NOK',
]);

// ── Cache for exchange/market cap lookups ──
const revolutCache = new Map(); // symbol → { available: bool, ts: number }
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if a single symbol is likely available on Revolut.
 * Uses cached data + heuristics.
 */
export function isRevolutAvailable(symbol, quoteData = null) {
  if (!symbol) return false;
  const sym = symbol.toUpperCase();

  // Instant lookups
  if (EXCLUDED_TICKERS.has(sym)) return false;
  if (CONFIRMED_REVOLUT.has(sym)) return true;

  // Check cache
  const cached = revolutCache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.available;

  // If we have quote data, use it for heuristics
  if (quoteData) {
    const result = checkQuoteForRevolut(sym, quoteData);
    revolutCache.set(sym, { available: result, ts: Date.now() });
    return result;
  }

  // Default: assume available if not excluded (conservative)
  return true;
}

/**
 * Check quote data to determine Revolut availability.
 * Revolut requires: listed exchange, minimum market cap, active trading.
 */
function checkQuoteForRevolut(symbol, q) {
  // Must have a valid exchange
  const exchange = (q.exchange || q.fullExchangeName || '').toUpperCase();
  const validExchanges = ['NYQ', 'NMS', 'NGM', 'NCM', 'NYSE', 'NASDAQ', 'NAS',
    'NEW YORK STOCK EXCHANGE', 'NASDAQ GLOBAL SELECT', 'NASDAQ GLOBAL MARKET',
    'NASDAQ CAPITAL MARKET'];
  const hasValidExchange = validExchanges.some(e => exchange.includes(e));
  if (!hasValidExchange && exchange) return false;

  // Must have minimum market cap ($50M)
  const marketCap = q.marketCap || 0;
  if (marketCap > 0 && marketCap < 50_000_000) return false;

  // Must have minimum price ($0.50) — Revolut doesn't list sub-penny stocks
  const price = q.regularMarketPrice || 0;
  if (price > 0 && price < 0.50) return false;

  // Must have some trading activity
  const volume = q.regularMarketVolume || q.averageDailyVolume10Day || 0;
  if (volume > 0 && volume < 10_000) return false;

  return true;
}

/**
 * Filter an array of stocks to only Revolut-available ones.
 * Enriches each stock with `revolutAvailable: true`.
 * @param {Array} stocks - Array of stock objects with .symbol and optionally quote data
 * @returns {Array} Filtered stocks available on Revolut
 */
export function filterRevolutStocks(stocks) {
  if (!stocks?.length) return [];

  return stocks.filter(stock => {
    const available = isRevolutAvailable(stock.symbol, stock);
    stock.revolutAvailable = available;
    return available;
  });
}

/**
 * Batch-check symbols for Revolut availability using quote data.
 * Useful for enriching the stock universe on startup.
 */
export async function batchCheckRevolut(symbols) {
  if (!symbols?.length) return new Map();

  const results = new Map();
  const uncached = symbols.filter(sym => {
    if (EXCLUDED_TICKERS.has(sym)) { results.set(sym, false); return false; }
    if (CONFIRMED_REVOLUT.has(sym)) { results.set(sym, true); return false; }
    const cached = revolutCache.get(sym);
    if (cached && Date.now() - cached.ts < CACHE_TTL) { results.set(sym, cached.available); return false; }
    return true;
  });

  if (uncached.length > 0) {
    try {
      const BATCH = 50;
      for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH);
        const quotes = await getQuoteBatch(batch);
        for (const q of quotes) {
          if (!q?.symbol) continue;
          const available = checkQuoteForRevolut(q.symbol, q);
          results.set(q.symbol, available);
          revolutCache.set(q.symbol, { available, ts: Date.now() });
        }
      }
    } catch (err) {
      console.error('[Revolut] Batch check failed:', err.message);
      // Default to available for unknowns
      for (const sym of uncached) {
        if (!results.has(sym)) results.set(sym, true);
      }
    }
  }

  console.log(`[Revolut] Checked ${symbols.length} symbols: ${[...results.values()].filter(v => v).length} available`);
  return results;
}

/**
 * Get the Revolut-filtered stock universe.
 * Returns only symbols from the main universe that pass the Revolut filter.
 */
export function getRevolutUniverse(allSymbols) {
  return allSymbols.filter(sym => !EXCLUDED_TICKERS.has(sym));
}
