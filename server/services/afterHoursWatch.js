/**
 * After-Hours Watch — monitors 16:00-20:00 ET for big post-market moves.
 *
 * Earnings land 16:00-17:30 ET and the gap forms after-hours, while the rest
 * of the bot is winding down. This watcher snapshots the scan universe plus
 * today's earnings reporters via Alpaca (latestTrade includes extended-hours
 * trades) and alerts Telegram on moves >= 5% vs the regular-session close.
 *
 * Alert-only by design: orders stay inside the 09:45-13:30 entry window; the
 * morning scan re-evaluates these names with full signals before any buy.
 */

import axios from 'axios';
import { getFullUniverse } from './premarketScanner.js';
import { getEarningsCalendar } from './yahooFinance.js';

const ALPACA_DATA = 'https://data.alpaca.markets';

const MIN_MOVE_PCT = 5;
const MIN_PRICE = 1;
const MIN_DAY_VOLUME = 300_000;
const ALERT_COOLDOWN = 4 * 60 * 60 * 1000;

const alerted = new Map(); // symbol → ts

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

async function fetchSnapshots(symbols) {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return {};
  const out = {};
  const valid = [...new Set(symbols)].filter(s => /^[A-Z]{1,5}$/.test(s));
  for (let i = 0; i < valid.length; i += 200) {
    const chunk = valid.slice(i, i + 200);
    try {
      const { data } = await axios.get(
        `${ALPACA_DATA}/v2/stocks/snapshots?symbols=${encodeURIComponent(chunk.join(','))}`,
        { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, timeout: 15000 },
      );
      Object.assign(out, data || {});
    } catch (err) {
      console.error('[AfterHours] snapshot fetch failed:', err.message);
    }
    if (i + 200 < valid.length) await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

/**
 * Scan for after-hours movers. Returns fresh (non-cooldown) movers sorted by
 * absolute move; each: { symbol, close, last, ahChangePct, dayVolume, hasEarnings }.
 */
export async function scanAfterHoursMovers() {
  const earnings = await getEarningsCalendar().catch(() => []);
  const earningsToday = new Set(
    earnings.filter(e => e.isToday).map(e => String(e.symbol).toUpperCase()),
  );
  const symbols = [...getFullUniverse(), ...earningsToday];

  const snaps = await fetchSnapshots(symbols);
  const now = Date.now();
  const sessionCloseEt = new Date(etNow());
  sessionCloseEt.setHours(16, 0, 0, 0);

  const movers = [];
  for (const [sym, snap] of Object.entries(snaps)) {
    const close = snap.dailyBar?.c || 0;
    const last = snap.latestTrade?.p || 0;
    const tradeTs = snap.latestTrade?.t ? new Date(snap.latestTrade.t) : null;
    if (!close || !last || close < MIN_PRICE) continue;
    if ((snap.dailyBar?.v || 0) < MIN_DAY_VOLUME) continue;
    // Only trades that happened AFTER today's regular close count as AH moves
    if (!tradeTs) continue;
    const tradeEt = new Date(tradeTs.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (tradeEt < sessionCloseEt) continue;

    const ahChangePct = ((last - close) / close) * 100;
    if (Math.abs(ahChangePct) < MIN_MOVE_PCT) continue;

    const lastAlert = alerted.get(sym);
    if (lastAlert && now - lastAlert < ALERT_COOLDOWN) continue;

    movers.push({
      symbol: sym,
      close: Math.round(close * 100) / 100,
      last: Math.round(last * 100) / 100,
      ahChangePct: Math.round(ahChangePct * 10) / 10,
      dayVolume: snap.dailyBar?.v || 0,
      hasEarnings: earningsToday.has(sym),
    });
  }

  movers.sort((a, b) => Math.abs(b.ahChangePct) - Math.abs(a.ahChangePct));
  return movers;
}

export function markAlerted(symbols) {
  const now = Date.now();
  for (const s of symbols) alerted.set(s, now);
  for (const [sym, ts] of alerted) {
    if (now - ts > ALERT_COOLDOWN * 3) alerted.delete(sym);
  }
}
