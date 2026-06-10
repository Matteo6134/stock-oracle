/**
 * Dark Pool / Short Volume Scanner — FINRA Daily Regulatory Feed
 *
 * FINRA publishes daily short volume for every US-listed stock, free & public.
 * Source: https://cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt
 * Format: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
 *
 * High short volume + price NOT falling = shorts are trapped.
 * This is a leading indicator of short squeezes.
 */

import axios from 'axios';

// In-memory cache — refreshes once per day
let cache = { date: null, map: null, ts: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Fetch the most recent available FINRA short volume file.
 * Falls back to previous business day if today's file isn't posted yet.
 */
async function fetchLatestFinra() {
  const now = new Date();
  // FINRA posts at ~6PM ET; if before then, try yesterday first
  for (let offset = 0; offset < 5; offset++) {
    const d = new Date(now - offset * 24 * 60 * 60 * 1000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue; // skip weekends
    const dateStr = formatDate(d);
    const url = `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${dateStr}.txt`;
    try {
      const { data } = await axios.get(url, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'text',
      });
      if (data && typeof data === 'string' && data.length > 1000) {
        return { date: dateStr, text: data };
      }
    } catch { /* try earlier day */ }
  }
  return null;
}

/**
 * Parse pipe-delimited FINRA short volume file into a Map<symbol, stats>.
 */
function parseFinra(text) {
  const map = new Map();
  const lines = text.split('\n');
  // lines[0] = header: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('|');
    if (cols.length < 5) continue;
    const symbol = (cols[1] || '').trim().toUpperCase();
    if (!symbol) continue;
    const shortVol = parseFloat(cols[2]) || 0;
    const shortExempt = parseFloat(cols[3]) || 0;
    const totalVol = parseFloat(cols[4]) || 0;
    if (totalVol === 0) continue;
    const ratio = (shortVol + shortExempt) / totalVol;
    // CNMS aggregates across venues — sum if same symbol appears twice
    if (map.has(symbol)) {
      const prev = map.get(symbol);
      const combinedShort = prev.shortVol + shortVol + shortExempt;
      const combinedTotal = prev.totalVol + totalVol;
      map.set(symbol, {
        shortVol: combinedShort,
        totalVol: combinedTotal,
        ratio: combinedTotal > 0 ? combinedShort / combinedTotal : 0,
      });
    } else {
      map.set(symbol, {
        shortVol: shortVol + shortExempt,
        totalVol,
        ratio,
      });
    }
  }
  return map;
}

/**
 * Get the FINRA short volume map (today or most recent business day).
 * Cached for 6 hours.
 */
async function getFinraMap() {
  if (cache.map && Date.now() - cache.ts < CACHE_TTL) return cache.map;
  const latest = await fetchLatestFinra();
  if (!latest) {
    console.error('[DarkPool] Could not fetch any FINRA file');
    cache = { date: null, map: new Map(), ts: Date.now() };
    return cache.map;
  }
  const map = parseFinra(latest.text);
  cache = { date: latest.date, map, ts: Date.now() };
  console.log(`[DarkPool] Loaded FINRA short volume for ${latest.date}: ${map.size} symbols`);
  return map;
}

/**
 * Batch lookup — just filters the global FINRA map by symbols.
 * Returns Map<symbol, { shortVolumeRatio, shortVol, totalVol }>.
 */
export async function batchScanDarkPool(symbols) {
  if (!symbols?.length) return new Map();
  const finraMap = await getFinraMap();
  const result = new Map();
  for (const sym of symbols) {
    const s = sym.toUpperCase();
    const stat = finraMap.get(s);
    if (!stat || stat.totalVol < 10000) continue; // skip illiquid
    result.set(s, {
      symbol: s,
      shortVolumeRatio: Math.round(stat.ratio * 100) / 100,
      shortVolume: stat.shortVol,
      totalVolume: stat.totalVol,
    });
  }
  console.log(`[DarkPool] Looked up ${symbols.length} symbols, ${result.size} with FINRA data`);
  return result;
}

/**
 * Convert dark pool data into actionable signals.
 * High short volume + price holding = shorts trapped = squeeze setup.
 */
export function getDarkPoolSignals(darkPoolMap, quoteMap = {}) {
  const signals = [];
  for (const [symbol, dp] of darkPoolMap) {
    if (!dp) continue;
    const q = quoteMap[symbol] || {};
    const changePct = q.regularMarketChangePercent || q.changePct || 0;

    // >60% short vol + price NOT falling = shorts trapped
    if (dp.shortVolumeRatio >= 0.60 && changePct >= -2) {
      signals.push({
        symbol,
        signal: 'dark_pool_squeeze',
        shortRatio: dp.shortVolumeRatio,
        shortTrend: 'high',
        strength: 'strong',
        reason: `${Math.round(dp.shortVolumeRatio * 100)}% short volume but price holding — shorts trapped`,
      });
    } else if (dp.shortVolumeRatio >= 0.50 && changePct >= 0) {
      signals.push({
        symbol,
        signal: 'dark_pool_pressure',
        shortRatio: dp.shortVolumeRatio,
        shortTrend: 'elevated',
        strength: 'moderate',
        reason: `${Math.round(dp.shortVolumeRatio * 100)}% short volume, price green — building pressure`,
      });
    }
  }
  return signals;
}
