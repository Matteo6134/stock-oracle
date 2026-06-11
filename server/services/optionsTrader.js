/**
 * Options Trader — CASH-SECURED PUTS ONLY.
 *
 * Philosophy (Matteo's #1 rule: never realize a loss):
 *  - We only SELL puts, fully cash-secured, on setups that already pass every
 *    equity gate (Strong Buy consensus + 1000-sample analog evidence).
 *  - Premium is collected up front and is always kept.
 *  - We only ever BUY BACK the put in profit (premium decayed >= profit target).
 *  - If the stock drops below the strike: we get ASSIGNED 100 shares at a
 *    discount to the original price — a stock the bot wanted anyway, which is
 *    then managed under the normal never-sell-red exit regime.
 *  - We NEVER buy puts/calls: long options expire — a wrong pick would be a
 *    forced 100% loss, incompatible with the rule.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import * as alpaca from './alpaca.js';
import { getAutoTradeConfig } from './autoTrader.js';
import { sendMessage } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'data', 'optionsTrades.json');

const PAPER = 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';

const DEFAULTS = {
  cspEnabled: true,
  cspMaxCollateral: 1500,   // strike x 100 must fit under this
  cspMaxOpen: 1,            // pilot: one short put at a time
  cspMinPremiumPct: 0.8,    // premium / collateral, in % — skip thin premiums
  cspProfitClosePct: 65,    // buy back when we've captured 65% of the premium
  cspDteMin: 5,
  cspDteMax: 21,
  cspOtmMin: 0.03,          // strike 3-10% below current price
  cspOtmMax: 0.10,
};

function cfg() {
  const c = getAutoTradeConfig();
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith('csp'))) };
}

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return []; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export function getOpenCsps() {
  return loadState().filter(t => t.status === 'open');
}

async function optionsBuyingPower() {
  const { data } = await axios.get(`${PAPER}/v2/account`, { headers: headers(), timeout: 10000 });
  return parseFloat(data.options_buying_power) || 0;
}

/** Pick the best put contract for a candidate: 3-10% OTM, 5-21 DTE, liquid. */
async function pickPutContract(symbol, price, c) {
  const today = new Date();
  const gte = new Date(today.getTime() + c.cspDteMin * 86400000).toISOString().split('T')[0];
  const lte = new Date(today.getTime() + c.cspDteMax * 86400000).toISOString().split('T')[0];
  const strikeMin = price * (1 - c.cspOtmMax);
  const strikeMax = price * (1 - c.cspOtmMin);

  const { data } = await axios.get(`${PAPER}/v2/options/contracts`, {
    headers: headers(), timeout: 15000,
    params: {
      underlying_symbols: symbol, type: 'put', status: 'active',
      expiration_date_gte: gte, expiration_date_lte: lte,
      strike_price_gte: strikeMin.toFixed(2), strike_price_lte: strikeMax.toFixed(2),
      limit: 100,
    },
  });
  const contracts = (data.option_contracts || [])
    .filter(k => k.tradable && Number(k.open_interest || 0) >= 100)
    .filter(k => Number(k.strike_price) * 100 <= c.cspMaxCollateral);
  if (!contracts.length) return null;

  // Highest strike (most premium) at the nearest qualifying expiry
  contracts.sort((a, b) =>
    a.expiration_date.localeCompare(b.expiration_date) ||
    Number(b.strike_price) - Number(a.strike_price));
  const pick = contracts[0];

  // Live quote
  const snap = await axios.get(`${DATA}/v1beta1/options/snapshots`, {
    headers: headers(), timeout: 10000,
    params: { symbols: pick.symbol, feed: 'indicative' },
  });
  const q = snap.data?.snapshots?.[pick.symbol]?.latestQuote;
  if (!q || !(q.bp > 0)) return null;
  const mid = Math.round(((q.bp + (q.ap || q.bp)) / 2) * 100) / 100;

  return {
    occSymbol: pick.symbol,
    strike: Number(pick.strike_price),
    expiry: pick.expiration_date,
    bid: q.bp,
    ask: q.ap,
    mid: Math.max(q.bp, mid), // never below bid
    openInterest: Number(pick.open_interest || 0),
  };
}

/**
 * Try to open ONE cash-secured put on the best qualifying candidate.
 * Candidates must already carry consensus + analog from the scan pipeline.
 */
export async function findAndSellCsp(analyzedStocks) {
  const c = cfg();
  if (!c.cspEnabled) return { skipped: 'disabled' };
  if (!alpaca.isConfigured()) return { skipped: 'alpaca not configured' };

  const state = loadState();
  const open = state.filter(t => t.status === 'open');
  if (open.length >= c.cspMaxOpen) return { skipped: 'max open CSPs' };
  const openUnderlyings = new Set(open.map(t => t.underlying));

  // Same evidence bar as the AI-free prediction path
  const candidates = (analyzedStocks || [])
    .filter(s => s.consensus === 'Strong Buy')
    .filter(s => s.analog && s.analog.n >= 1000 && s.analog.avgFwd5 >= 0.5)
    .filter(s => s.price > 2 && s.price * 100 * 0.90 <= c.cspMaxCollateral)
    .filter(s => !openUnderlyings.has(s.symbol))
    .sort((a, b) => (b.analog.avgFwd5 || 0) - (a.analog.avgFwd5 || 0));
  if (!candidates.length) return { skipped: 'no qualifying candidates' };

  for (const stock of candidates.slice(0, 3)) {
    try {
      const contract = await pickPutContract(stock.symbol, stock.price, c);
      if (!contract) continue;

      const collateral = contract.strike * 100;
      const premium = contract.mid * 100;
      const premiumPct = (premium / collateral) * 100;
      if (premiumPct < c.cspMinPremiumPct) continue;

      const obp = await optionsBuyingPower();
      if (collateral > obp) return { skipped: `collateral $${collateral} > options BP $${Math.round(obp)}` };

      const order = await alpaca.submitOrder({
        symbol: contract.occSymbol,
        qty: 1,
        side: 'sell',
        type: 'limit',
        timeInForce: 'day',
        limitPrice: contract.mid,
      });

      const entry = {
        id: randomUUID(),
        occSymbol: contract.occSymbol,
        underlying: stock.symbol,
        strike: contract.strike,
        expiry: contract.expiry,
        qty: 1,
        premiumPerShare: contract.mid,
        premiumTotal: Math.round(premium),
        collateral,
        underlyingPriceAtOpen: stock.price,
        analogKey: stock.analog?.key || null,
        orderId: order.id,
        status: 'open',
        openedAt: new Date().toISOString(),
      };
      state.push(entry);
      saveState(state);

      const effectiveCost = Math.round((contract.strike - contract.mid) * 100) / 100;
      const discountPct = Math.round((1 - effectiveCost / stock.price) * 1000) / 10;
      console.log(`[CSP] SOLD ${contract.occSymbol} premium $${Math.round(premium)} (${premiumPct.toFixed(1)}% on $${collateral})`);
      sendMessage([
        `💰 *Sold cash-secured put: ${stock.symbol}*`,
        '',
        `Strike *$${contract.strike}* · expiry ${contract.expiry} · premium *$${Math.round(premium)}* (${premiumPct.toFixed(1)}% on $${collateral} collateral)`,
        '',
        `💬 _In plain words: we just got paid $${Math.round(premium)} cash. If ${stock.symbol} stays above $${contract.strike} until ${contract.expiry}, the money is pure profit. If it drops below, we buy 100 shares at an effective $${effectiveCost} — ${discountPct}% cheaper than today's price — and hold them under the never-sell-red rule. Either way, nothing is ever sold at a loss._`,
      ].join('\n')).catch(() => {});

      return { opened: entry };
    } catch (err) {
      console.error(`[CSP] ${stock.symbol} failed:`, err.response?.data?.message || err.message);
    }
  }
  return { skipped: 'no contract met premium/liquidity bar' };
}

/**
 * Manage open CSPs: profit-close when premium has decayed enough; detect
 * expiry/assignment. NEVER closes at a loss — that's the whole point.
 */
export async function manageCsps() {
  const c = cfg();
  const state = loadState();
  const open = state.filter(t => t.status === 'open');
  if (!open.length) return;

  let positions = [];
  try { positions = await alpaca.getPositions(); } catch { return; }
  const posBySymbol = new Map(positions.map(p => [p.symbol, p]));
  const todayIso = new Date().toISOString().split('T')[0];
  let dirty = false;

  for (const t of open) {
    const optPos = posBySymbol.get(t.occSymbol);

    // Position gone → expired worthless (win) or assigned (shares appeared)
    if (!optPos && t.expiry < todayIso) {
      const stockPos = posBySymbol.get(t.underlying);
      if (stockPos && Math.abs(stockPos.qty) >= 100) {
        t.status = 'assigned';
        t.closedAt = new Date().toISOString();
        sendMessage(`📦 *${t.underlying} put assigned* — bought 100 shares at $${t.strike} (effective $${(t.strike - t.premiumPerShare).toFixed(2)} after premium). Now managed by the normal profit-only exits.`).catch(() => {});
      } else {
        t.status = 'expired';
        t.pnl = t.premiumTotal;
        t.closedAt = new Date().toISOString();
        sendMessage(`✅ *${t.underlying} put expired worthless* — the $${t.premiumTotal} premium is pure profit.`).catch(() => {});
      }
      dirty = true;
      continue;
    }
    if (!optPos) continue; // order may not have filled yet

    // Profit-close: current cost to buy back <= (1 - target) of premium received
    try {
      const snap = await axios.get(`${DATA}/v1beta1/options/snapshots`, {
        headers: headers(), timeout: 10000,
        params: { symbols: t.occSymbol, feed: 'indicative' },
      });
      const q = snap.data?.snapshots?.[t.occSymbol]?.latestQuote;
      const askNow = q?.ap || 0;
      if (askNow > 0 && askNow <= t.premiumPerShare * (1 - c.cspProfitClosePct / 100)) {
        await alpaca.submitOrder({
          symbol: t.occSymbol, qty: 1, side: 'buy', type: 'limit',
          timeInForce: 'day', limitPrice: askNow,
        });
        t.status = 'closed';
        t.closePrice = askNow;
        t.pnl = Math.round((t.premiumPerShare - askNow) * 100);
        t.closedAt = new Date().toISOString();
        dirty = true;
        sendMessage(`🔒 *${t.underlying} put closed in profit* — bought back at $${askNow} vs $${t.premiumPerShare} received → *+$${t.pnl}* locked (${c.cspProfitClosePct}% of premium captured).`).catch(() => {});
      }
    } catch (err) {
      console.error(`[CSP] manage ${t.occSymbol}:`, err.message);
    }
  }

  if (dirty) saveState(state);
}
