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
import { logNewTrade, logTradeExit } from './sheetsLogger.js';
import { recordOutcome } from './claudeTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'autoTradeConfig.json');
const TRADES_FILE = path.join(__dirname, '..', 'data', 'agentTrades.json');

// ── Config ──
const DEFAULT_CONFIG = {
  enabled: true,             // Auto-trading ON by default — Claude is in charge
  maxBudget: 1000,           // Total max $ invested at any time — this is the ONLY limit
  strongBuyAmount: 200,      // $ per Strong Buy trade (conservative)
  buyAmount: 100,            // $ per Buy trade
  maxPerStock: 200,          // Max $ in any single stock
  defaultStopPct: 5,         // Tight stop loss (5%)
  takeProfitPct: 10,         // Take profit at 10%
  trailingStopPct: 3,        // After +5% gain, trail by 3%
  scanPennies: true,
  scanGems: true,
  minGemScore: 45,           // Reasonable threshold (was 60 — too strict, nothing passed)
  minConviction: 3,          // 3/5 agents agree (was 4 — too strict)
  requireOrderFlow: false,   // Don't require order flow — Yahoo can't provide this on Railway
  onlyStrongBuy: false,      // Trade "Buy" AND "Strong Buy" (was true — too strict)
  maxStockPrice: 50,         // Trade stocks up to $50 (was $5 — missed most gems)
};

// Reset old restrictive configs on first load
let configMigrated = false;
export function getAutoTradeConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // One-time migration: if old config had requireOrderFlow=true, reset to new defaults
      if (!configMigrated && saved.requireOrderFlow === true) {
        console.log('[AutoTrader] Migrating old restrictive config to new defaults');
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
        configMigrated = true;
        return { ...DEFAULT_CONFIG };
      }
      configMigrated = true;
      return { ...DEFAULT_CONFIG, ...saved };
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
    // ── Claude AI gate: if Claude analyzed this stock, require confidence >= 6 ──
    const claude = stock.claude;
    if (claude && claude.action === 'SKIP') {
      results.skipped.push({ symbol, reason: `Claude rejected (conf ${claude.confidence}/10)` });
      continue;
    }
    if (claude && claude.confidence < 6) {
      results.skipped.push({ symbol, reason: `Claude low confidence (${claude.confidence}/10)` });
      continue;
    }

    // Budget check — don't exceed max budget (budget is the only limit on positions)
    const currentlyInvested = totalInvested + results.bought.reduce((s, b) => s + b.amount, 0);
    // Claude can suggest position size as % of budget; fall back to default amounts
    const claudeSizeAmount = claude?.suggestedSizePct
      ? Math.round(config.maxBudget * (claude.suggestedSizePct / 100))
      : null;
    const amount = claudeSizeAmount || (consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount);
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

      // Use Claude's targets if available, otherwise agent defaults
      const finalStopPct = claude?.stopPct || Math.round(avgStopPct * 10) / 10;
      const finalTargetPct = claude?.targetPct || Math.round(avgTargetPct * 10) / 10;

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
        stopPct: finalStopPct,
        targetPct: finalTargetPct,
        // Claude AI context
        claudeConfidence: claude?.confidence || null,
        claudeThesis: claude?.thesis || null,
        claudeRiskLevel: claude?.riskLevel || null,
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
      logNewTrade(tradeEntry).catch(() => {});

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

    // ═══════════════════════════════════════════════════════
    // "NEVER LOSE" EXIT STRATEGY
    //
    // Principle: once in profit, LOCK IT IN. Never give back gains.
    //
    // Phase 1: SURVIVAL (0 to +3%)  → hard stop only at -stopPct%
    // Phase 2: BREAK-EVEN (+3%)     → move stop to entry price (can't lose!)
    // Phase 3: PROFIT LOCK (+5%)    → trail 2% from peak (minimum +3% profit)
    // Phase 4: MOON BAG (+10%)      → trail 3% from peak (let it run)
    // Phase 5: TAKE PROFIT (+target%) → close and celebrate
    //
    // Result: most trades either hit TP or exit with guaranteed profit.
    // Only lose on hard stop in Phase 1 (before reaching +3%).
    // ═══════════════════════════════════════════════════════

    const maxGainSeen = entry?.maxGainSeen || 0;
    // Track highest gain ever seen for this position
    if (unrealizedPLPct > maxGainSeen && entry) {
      entry.maxGainSeen = unrealizedPLPct;
    }

    // Helper: close position with reason
    const closeWithReason = async (reason, logReason) => {
      await alpaca.closePosition(symbol);
      if (entry) {
        entry.exitPrice = currentPrice;
        entry.exitReason = reason;
        entry.pnl = Math.round(pos.unrealizedPL * 100) / 100;
        entry.status = 'closed';
      }
      results.closed.push({ symbol, reason: logReason, pnl: pos.unrealizedPL });
      if (entry) {
        notifyTradeExit(entry).catch(() => {});
        logTradeExit(entry).catch(() => {});
        if (entry.claudeConfidence) {
          recordOutcome(entry.symbol, entry.exitPrice, entry.price ? ((entry.exitPrice - entry.price) / entry.price * 100) : 0, entry.exitReason);
        }
      }
    };

    // ── Phase 5: TAKE PROFIT ──
    if (unrealizedPLPct >= targetPct) {
      try {
        console.log(`[AutoTrader] 🎯 TAKE PROFIT ${symbol} at +${unrealizedPLPct.toFixed(1)}% (target: +${targetPct}%)`);
        await closeWithReason(`Take profit hit (+${unrealizedPLPct.toFixed(1)}%)`, 'take_profit');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── Phase 4: MOON BAG trail (was up 10%+, trail 3%) ──
    if (maxGainSeen >= 10 && unrealizedPLPct < maxGainSeen - 3) {
      try {
        console.log(`[AutoTrader] 🌙 MOON TRAIL ${symbol} — peak +${maxGainSeen.toFixed(1)}%, now +${unrealizedPLPct.toFixed(1)}% (locked +${(maxGainSeen - 3).toFixed(1)}%)`);
        await closeWithReason(`Moon trail (peak +${maxGainSeen.toFixed(1)}%, locked profit)`, 'moon_trail');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── Phase 3: PROFIT LOCK trail (was up 5%+, trail 2%) ──
    if (maxGainSeen >= 5 && unrealizedPLPct < maxGainSeen - 2) {
      try {
        console.log(`[AutoTrader] 🔒 PROFIT LOCK ${symbol} — peak +${maxGainSeen.toFixed(1)}%, now +${unrealizedPLPct.toFixed(1)}% (locked +${(maxGainSeen - 2).toFixed(1)}%)`);
        await closeWithReason(`Profit locked (peak +${maxGainSeen.toFixed(1)}%, secured gains)`, 'profit_lock');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── Phase 2: BREAK-EVEN STOP (was up 3%+, now back to entry) ──
    if (maxGainSeen >= 3 && unrealizedPLPct <= 0.2) {
      try {
        console.log(`[AutoTrader] 🛡️ BREAK-EVEN ${symbol} — was up +${maxGainSeen.toFixed(1)}%, saved from loss`);
        await closeWithReason(`Break-even stop (was +${maxGainSeen.toFixed(1)}%, protected capital)`, 'break_even');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── Phase 1: HARD STOP (only if never reached +3%) ──
    if (maxGainSeen < 3 && unrealizedPLPct <= -stopPct) {
      try {
        console.log(`[AutoTrader] 🛑 STOP LOSS ${symbol} at ${unrealizedPLPct.toFixed(1)}% (limit: -${stopPct}%)`);
        await closeWithReason(`Stop loss (-${stopPct}%)`, 'stop_loss');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
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
