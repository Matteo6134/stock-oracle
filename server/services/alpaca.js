/**
 * Alpaca Paper Trading API Client
 *
 * Uses Alpaca REST API v2 for paper trading.
 * Get free paper trading keys at https://app.alpaca.markets/paper/dashboard/overview
 *
 * All functions return null or throw on error — callers should handle gracefully.
 */

import axios from 'axios';

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';

function getHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '',
    'Content-Type': 'application/json',
  };
}

const api = axios.create({ baseURL: BASE_URL, headers: getHeaders(), timeout: 10000 });
const dataApi = axios.create({ baseURL: DATA_URL, headers: getHeaders(), timeout: 10000 });

// Refresh headers on each request (in case env vars change)
api.interceptors.request.use(config => {
  config.headers['APCA-API-KEY-ID'] = process.env.ALPACA_API_KEY || '';
  config.headers['APCA-API-SECRET-KEY'] = process.env.ALPACA_SECRET_KEY || '';
  return config;
});
dataApi.interceptors.request.use(config => {
  config.headers['APCA-API-KEY-ID'] = process.env.ALPACA_API_KEY || '';
  config.headers['APCA-API-SECRET-KEY'] = process.env.ALPACA_SECRET_KEY || '';
  return config;
});

// ── Simple cache ──
const cache = new Map();
function getCached(key, ttl) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ttl) return c.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

/**
 * Check if Alpaca API keys are configured.
 */
export function isConfigured() {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
}

/**
 * Get account info — equity, buying power, cash, P/L.
 */
export async function getAccount() {
  const cached = getCached('account', 10_000);
  if (cached) return cached;

  const { data } = await api.get('/v2/account');
  const account = {
    id: data.id,
    status: data.status,
    currency: data.currency,
    cash: parseFloat(data.cash),
    portfolioValue: parseFloat(data.portfolio_value),
    equity: parseFloat(data.equity),
    buyingPower: parseFloat(data.buying_power),
    longMarketValue: parseFloat(data.long_market_value),
    shortMarketValue: parseFloat(data.short_market_value),
    initialMargin: parseFloat(data.initial_margin),
    lastEquity: parseFloat(data.last_equity),
    daytradeCount: data.daytrade_count,
    dayTradingBuyingPower: parseFloat(data.daytrading_buying_power),
    patternDayTrader: data.pattern_day_trader,
    tradingBlocked: data.trading_blocked,
    accountBlocked: data.account_blocked,
    // Computed
    dayPL: parseFloat(data.equity) - parseFloat(data.last_equity),
    dayPLPct: parseFloat(data.last_equity) > 0
      ? ((parseFloat(data.equity) - parseFloat(data.last_equity)) / parseFloat(data.last_equity)) * 100
      : 0,
  };

  setCache('account', account);
  return account;
}

/**
 * Get all open positions.
 */
export async function getPositions() {
  const cached = getCached('positions', 5_000);
  if (cached) return cached;

  const { data } = await api.get('/v2/positions');
  const positions = data.map(p => ({
    symbol: p.symbol,
    qty: parseFloat(p.qty),
    side: p.side,
    avgEntryPrice: parseFloat(p.avg_entry_price),
    currentPrice: parseFloat(p.current_price),
    marketValue: parseFloat(p.market_value),
    costBasis: parseFloat(p.cost_basis),
    unrealizedPL: parseFloat(p.unrealized_pl),
    unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
    changeToday: parseFloat(p.change_today) * 100,
    assetClass: p.asset_class,
  }));

  setCache('positions', positions);
  return positions;
}

/**
 * Get a single position.
 */
export async function getPosition(symbol) {
  try {
    const { data } = await api.get(`/v2/positions/${symbol}`);
    return {
      symbol: data.symbol,
      qty: parseFloat(data.qty),
      side: data.side,
      avgEntryPrice: parseFloat(data.avg_entry_price),
      currentPrice: parseFloat(data.current_price),
      marketValue: parseFloat(data.market_value),
      costBasis: parseFloat(data.cost_basis),
      unrealizedPL: parseFloat(data.unrealized_pl),
      unrealizedPLPct: parseFloat(data.unrealized_plpc) * 100,
    };
  } catch (err) {
    if (err.response?.status === 404) return null; // No position
    throw err;
  }
}

/**
 * Get orders by status.
 * @param {string} status - 'open', 'closed', 'all'
 * @param {number} limit - max orders to return
 */
export async function getOrders(status = 'all', limit = 50) {
  const { data } = await api.get('/v2/orders', {
    params: { status, limit, direction: 'desc' },
  });
  return data.map(formatOrder);
}

/**
 * Submit a new order.
 */
export async function submitOrder({ symbol, qty, notional, side = 'buy', type = 'market', timeInForce = 'day', limitPrice, stopPrice }) {
  const order = {
    symbol: symbol.toUpperCase(),
    side,
    type,
    time_in_force: timeInForce,
  };

  // Use qty (shares) or notional (dollar amount), not both
  if (notional && !qty) {
    order.notional = String(notional);
  } else {
    order.qty = String(qty || 1);
  }

  if (type === 'limit' && limitPrice) order.limit_price = String(limitPrice);
  if (type === 'stop' && stopPrice) order.stop_price = String(stopPrice);
  if (type === 'stop_limit') {
    if (limitPrice) order.limit_price = String(limitPrice);
    if (stopPrice) order.stop_price = String(stopPrice);
  }

  const { data } = await api.post('/v2/orders', order);
  // Invalidate caches
  cache.delete('positions');
  cache.delete('account');
  cache.delete('orders_open');
  return formatOrder(data);
}

/**
 * Cancel a pending order.
 */
export async function cancelOrder(orderId) {
  await api.delete(`/v2/orders/${orderId}`);
  cache.delete('orders_open');
  return { success: true };
}

/**
 * Close an entire position (market sell).
 */
export async function closePosition(symbol) {
  const { data } = await api.delete(`/v2/positions/${symbol.toUpperCase()}`);
  cache.delete('positions');
  cache.delete('account');
  return formatOrder(data);
}

/**
 * Close all positions.
 */
export async function closeAllPositions() {
  await api.delete('/v2/positions');
  cache.delete('positions');
  cache.delete('account');
  return { success: true };
}

/**
 * Get portfolio history for equity chart.
 * @param {string} period - '1D', '1W', '1M', '3M', '1A', 'all'
 */
export async function getPortfolioHistory(period = '1M') {
  const cacheKey = `history_${period}`;
  const cached = getCached(cacheKey, 60_000);
  if (cached) return cached;

  const { data } = await api.get('/v2/account/portfolio/history', {
    params: { period, timeframe: period === '1D' ? '5Min' : '1D' },
  });

  const history = {
    timestamps: data.timestamp || [],
    equity: data.equity || [],
    profitLoss: data.profit_loss || [],
    profitLossPct: data.profit_loss_pct || [],
    baseValue: data.base_value,
  };

  setCache(cacheKey, history);
  return history;
}

// ── Helpers ──
function formatOrder(o) {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    qty: parseFloat(o.qty || o.filled_qty || 0),
    filledQty: parseFloat(o.filled_qty || 0),
    notional: o.notional ? parseFloat(o.notional) : null,
    limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
    stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
    filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
    status: o.status,
    timeInForce: o.time_in_force,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    filledAt: o.filled_at,
    cancelledAt: o.cancelled_at,
    assetClass: o.asset_class,
  };
}
