/**
 * Auto-Trader — Agents automatically execute paper trades via Alpaca
 *
 * When enabled, after each scan cycle:
 * 1. Agents analyze gems + penny stocks
 * 2. "Strong Buy" consensus → auto-buy $500
 * 3. "Buy" consensus → auto-buy $250
 * 4. Every 2 min: check open positions for stop loss / take profit exits
 *
 * Starts DISABLED — user must toggle ON via UI.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import * as alpaca from './alpaca.js';
import { notifyNewTrade, notifyTradeExit } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'autoTradeConfig.json');
const TRADES_FILE = path.join(__dirname, '..', 'data', 'agentTrades.json');

// ── Config ──
const DEFAULT_CONFIG = {
  enabled: false,
  maxBudget: 1000,           // Total max $ invested at any time
  strongBuyAmount: 200,      // $ per Strong Buy trade (conservative)
  buyAmount: 100,            // $ per Buy trade
  maxPositions: 5,           // Max simultaneous positions
  maxPerStock: 200,          // Max $ in any single stock
  defaultStopPct: 5,         // Tight stop loss (5%)
  takeProfitPct: 10,         // Take profit at 10%
  trailingStopPct: 3,        // After +5% gain, trail by 3%
  scanPennies: true,
  scanGems: true,
  minGemScore: 60,           // Only high-quality setups
  minConviction: 4,          // Agents must be very confident
  requireOrderFlow: true,    // Must have insider/options/institutional signal
  onlyStrongBuy: true,       // Only trade "Strong Buy" consensus (3+ agents)
  maxStockPrice: 5,          // Only trade stocks under $5 (penny territory)
};

export function getAutoTradeConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch { /* use defaults */ }
  return { ...DEFAULT_CONFIG };
}

export function updateAutoTradeConfig(updates) {
  const config = { ...getAutoTradeConfig(), ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

// ── Trade Log ──
function loadTradeLog() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function saveTradeLog(log) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(log, null, 2), 'utf8');
}

function addTradeEntry(entry) {
  const log = loadTradeLog();
  log.unshift(entry); // newest first
  // Keep last 200 entries
  if (log.length > 200) log.length = 200;
  saveTradeLog(log);
}

export function getAutoTradeLog() {
  return loadTradeLog();
}

// ── Market Hours Check ──
function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = et.getHours();
  const min = et.getMinutes();
  const day = et.getDay();
  const totalMin = hour * 60 + min;
  return day >= 1 && day <= 5 && totalMin >= 570 && totalMin < 960; // 9:30 AM - 4:00 PM ET
}

// ── Main: Process Signals from Scan ──
export async function processSignals(analyzedStocks) {
  const config = getAutoTradeConfig();

  if (!config.enabled) return { skipped: true, reason: 'Auto-trading disabled' };
  if (!alpaca.isConfigured()) return { skipped: true, reason: 'Alpaca not configured' };
  if (!isMarketOpen()) return { skipped: true, reason: 'Market closed' };

  let positions;
  try {
    positions = await alpaca.getPositions();
  } catch (err) {
    console.error('[AutoTrader] Failed to get positions:', err.message);
    return { skipped: true, reason: 'Failed to get positions' };
  }

  const heldSymbols = new Set(positions.map(p => p.symbol));
  const openCount = positions.length;
  const totalInvested = positions.reduce((s, p) => s + Math.abs(p.costBasis || 0), 0);

  // Check account has buying power
  let account;
  try {
    account = await alpaca.getAccount();
  } catch { return { skipped: true, reason: 'Failed to get account' }; }

  const results = { bought: [], skipped: [], errors: [] };

  // Sort by gemScore descending — trade the best setups first
  const sorted = [...analyzedStocks].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0));

  for (const stock of sorted) {
    const { symbol, consensus, buyCount, avgConviction, gemScore, signals, verdicts, price, companyName } = stock;

    // ── Strict quality filters — only trade the best ──
    if (!consensus || consensus === 'No Trade' || consensus === 'Speculative') continue;
    if (config.onlyStrongBuy && consensus !== 'Strong Buy') continue;
    if (gemScore < config.minGemScore) continue;
    if (avgConviction < config.minConviction) continue;
    // Price filter — focus on penny stocks under maxStockPrice
    if (config.maxStockPrice && price > config.maxStockPrice) {
      results.skipped.push({ symbol, reason: `Price $${price} > max $${config.maxStockPrice}` });
      continue;
    }

    // Require order flow confirmation (insider buying, options, or institutions)
    if (config.requireOrderFlow) {
      const hasOrderFlow = (signals || []).some(s =>
        ['insider_buying', 'bullish_options', 'unusual_options_volume', 'institutions_accumulating'].includes(s)
      );
      if (!hasOrderFlow) {
        results.skipped.push({ symbol, reason: 'No order flow confirmation' });
        continue;
      }
    }

    if (heldSymbols.has(symbol)) {
      results.skipped.push({ symbol, reason: 'Already holding' });
      continue;
    }
    if (openCount + results.bought.length >= config.maxPositions) {
      results.skipped.push({ symbol, reason: 'Max positions reached' });
      continue;
    }

    // Budget check — don't exceed max budget
    const currentlyInvested = totalInvested + results.bought.reduce((s, b) => s + b.amount, 0);
    const amount = consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount;
    if (currentlyInvested + amount > config.maxBudget) {
      results.skipped.push({ symbol, reason: `Budget limit ($${config.maxBudget})` });
      continue;
    }

    // Check buying power
    if (amount > account.buyingPower) {
      results.skipped.push({ symbol, reason: 'Insufficient buying power' });
      continue;
    }

    // Calculate stop loss from agent verdicts
    const buyAgents = (verdicts || []).filter(v => v.action === 'BUY');
    const avgStopPct = buyAgents.length > 0
      ? buyAgents.reduce((s, v) => {
          const agent = getAgentStopPct(v.style);
          return s + agent;
        }, 0) / buyAgents.length
      : config.defaultStopPct;

    const avgTargetPct = buyAgents.length > 0 && buyAgents[0].targetGain
      ? parseFloat(buyAgents[0].targetGain) || config.takeProfitPct
      : config.takeProfitPct;

    try {
      console.log(`[AutoTrader] BUY ${symbol} — ${consensus} (${buyCount}/5 agents, conviction ${avgConviction}, score ${gemScore}) — $${amount}`);

      const order = await alpaca.submitOrder({
        symbol,
        notional: amount,
        side: 'buy',
        type: 'market',
        timeInForce: 'day',
      });

      const tradeEntry = {
        id: randomUUID(),
        symbol,
        side: 'buy',
        amount,
        price: price || 0,
        consensus,
        buyCount,
        avgConviction,
        agents: buyAgents.map(v => v.agent),
        signals: signals || [],
        gemScore,
        source: stock.source || 'gem',
        orderId: order.id,
        status: order.status,
        stopPct: Math.round(avgStopPct * 10) / 10,
        targetPct: Math.round(avgTargetPct * 10) / 10,
        exitPrice: null,
        exitReason: null,
        pnl: null,
        timestamp: new Date().toISOString(),
      };

      addTradeEntry(tradeEntry);
      heldSymbols.add(symbol);
      results.bought.push({ symbol, amount, consensus, orderId: order.id });

      // Notify Telegram + Google Sheets (fire & forget)
      notifyNewTrade(tradeEntry).catch(() => {});

    } catch (err) {
      console.error(`[AutoTrader] Failed to buy ${symbol}:`, err.response?.data?.message || err.message);
      results.errors.push({ symbol, error: err.response?.data?.message || err.message });
    }
  }

  if (results.bought.length > 0) {
    console.log(`[AutoTrader] Executed ${results.bought.length} trades: ${results.bought.map(b => `${b.symbol}($${b.amount})`).join(', ')}`);
  }

  return results;
}

// ── Check Exit Signals for Open Positions ──
export async function checkExitSignals() {
  const config = getAutoTradeConfig();
  if (!config.enabled) return;
  if (!alpaca.isConfigured()) return;

  let positions;
  try {
    positions = await alpaca.getPositions();
  } catch { return; }

  if (positions.length === 0) return;

  const log = loadTradeLog();
  const results = { closed: [], held: [] };

  for (const pos of positions) {
    const { symbol, avgEntryPrice, currentPrice, unrealizedPLPct } = pos;

    // Find the original trade entry to get stop/target
    const entry = log.find(t => t.symbol === symbol && t.side === 'buy' && !t.exitPrice);
    const stopPct = entry?.stopPct || config.defaultStopPct;
    const targetPct = entry?.targetPct || config.takeProfitPct;

    // Trailing stop: once stock is up > 5%, tighten stop to trailingStopPct from peak
    const trailingStop = config.trailingStopPct || 3;
    const maxGainSeen = entry?.maxGainSeen || 0;
    // Track max gain seen for trailing stop
    if (unrealizedPLPct > maxGainSeen && entry) {
      entry.maxGainSeen = unrealizedPLPct;
    }
    // If we were up > 5% but now dropped by trailingStopPct from peak → close
    if (maxGainSeen >= 5 && unrealizedPLPct < maxGainSeen - trailingStop) {
      try {
        console.log(`[AutoTrader] TRAILING STOP ${symbol} — was +${maxGainSeen.toFixed(1)}%, now +${unrealizedPLPct.toFixed(1)}% (trail ${trailingStop}%)`);
        await alpaca.closePosition(symbol);
        if (entry) {
          entry.exitPrice = currentPrice;
          entry.exitReason = `Trailing stop (was +${maxGainSeen.toFixed(1)}%, trailed ${trailingStop}%)`;
          entry.pnl = Math.round(pos.unrealizedPL * 100) / 100;
          entry.status = 'closed';
        }
        results.closed.push({ symbol, reason: 'trailing_stop', pnl: pos.unrealizedPL });
        // Notify Telegram + Sheets
        if (entry) { notifyTradeExit(entry).catch(() => {}); }
      } catch (err) {
        console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message);
      }
      continue;
    }

    // Check stop loss
    if (unrealizedPLPct <= -stopPct) {
      try {
        console.log(`[AutoTrader] STOP LOSS ${symbol} at ${unrealizedPLPct.toFixed(1)}% (limit: -${stopPct}%)`);
        await alpaca.closePosition(symbol);

        if (entry) {
          entry.exitPrice = currentPrice;
          entry.exitReason = `Stop loss hit (-${stopPct}%)`;
          entry.pnl = Math.round(pos.unrealizedPL * 100) / 100;
          entry.status = 'closed';
        }
        results.closed.push({ symbol, reason: 'stop_loss', pnl: pos.unrealizedPL });
        // Notify Telegram + Sheets
        if (entry) { notifyTradeExit(entry).catch(() => {}); }
      } catch (err) {
        console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message);
      }
      continue;
    }

    // Check take profit
    if (unrealizedPLPct >= targetPct) {
      try {
        console.log(`[AutoTrader] TAKE PROFIT ${symbol} at +${unrealizedPLPct.toFixed(1)}% (target: +${targetPct}%)`);
        await alpaca.closePosition(symbol);

        if (entry) {
          entry.exitPrice = currentPrice;
          entry.exitReason = `Take profit hit (+${targetPct}%)`;
          entry.pnl = Math.round(pos.unrealizedPL * 100) / 100;
          entry.status = 'closed';
        }
        results.closed.push({ symbol, reason: 'take_profit', pnl: pos.unrealizedPL });
        // Notify Telegram + Sheets
        if (entry) { notifyTradeExit(entry).catch(() => {}); }
      } catch (err) {
        console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message);
      }
      continue;
    }

    results.held.push({ symbol, pnlPct: unrealizedPLPct });
  }

  if (results.closed.length > 0) {
    saveTradeLog(log);
    console.log(`[AutoTrader] Closed ${results.closed.length} positions: ${results.closed.map(c => `${c.symbol}(${c.reason})`).join(', ')}`);
  }

  return results;
}

// ── Helper: agent stop % by style ──
function getAgentStopPct(style) {
  const stops = { momentum: 7, squeeze: 5, accumulation: 8, catalyst: 3, contrarian: 10 };
  return stops[style] || 7;
}
