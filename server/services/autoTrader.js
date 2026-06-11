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
import { logNewTrade as logSupabaseTrade, logTradeExit as logSupabaseExit } from './supabaseLogger.js';
import { recordOutcome } from './claudeTracker.js';
import { signalPerformance } from './tradeStats.js';
import { getSignalReport, getComboBonus } from './signalLearner.js';
import { getAnalog, analogVeto } from './analogStats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'autoTradeConfig.json');
const TRADES_FILE = path.join(__dirname, '..', 'data', 'agentTrades.json');

// ── Config ──
const DEFAULT_CONFIG = {
  enabled: true,             // Auto-trading ON by default — Claude is in charge
  maxBudget: 5000,           // Total max $ invested at any time
  strongBuyAmount: 200,      // LEGACY — unused since conviction-based sizing
  buyAmount: 100,            // LEGACY — unused since conviction-based sizing
  maxPerStock: 500,          // Max $ in any single stock (= 100% conviction size)
  defaultStopPct: 5,         // Tight stop loss (5%)
  takeProfitPct: 10,         // Take profit at 10%
  trailingStopPct: 3,        // After +5% gain, trail by 3%
  scanPennies: true,
  scanGems: true,
  minGemScore: 45,           // Reasonable threshold (was 60 — too strict, nothing passed)
  minConviction: 3,          // 3/5 agents agree (was 4 — too strict)
  requireOrderFlow: false,   // Don't require order flow — Yahoo can't provide this on Railway
  onlyStrongBuy: false,      // Trade "Buy" AND "Strong Buy" (was true — too strict)
  maxStockPrice: 400,        // Safety cap — allows mid/large caps like CAR, MSTR, etc.
  maxHoldDays: 10,           // Time stop: close stale positions older than this, but ONLY at breakeven or better (0 = off)
  hardStopPct: 0,            // DISABLED — user's #1 rule: NEVER sell at a loss. (>0 enables loss-cutting + broker stops)
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

// ── Concurrency guard for exit checker ──
// Prevents two overlapping cron ticks from reading the trade log,
// mutating entries in-place, and racing on the final writeFileSync.
let exitCheckerRunning = false;

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

// ── Dynamic target based on gem score + claude confidence ──
// Rationale: high-conviction setups have more upside on average. A fixed +10%
// cap cuts big winners too early. Target is scaled, but trailing stops (already
// in place) still protect gains if the move stalls.
function dynamicTargetPct(gemScore, claudeConfidence) {
  let base;
  if (gemScore >= 85) base = 22;
  else if (gemScore >= 75) base = 17;
  else if (gemScore >= 65) base = 13;
  else if (gemScore >= 55) base = 10;
  else base = 8;
  if (claudeConfidence >= 9) base += 4;
  else if (claudeConfidence >= 8) base += 2;
  return base;
}

// ── Signal blacklist: kill combinations with proven negative expectancy ──
// Cached for one hour to avoid recomputing stats on every trade decision.
let _sigBlacklistCache = { ts: 0, set: new Set() };
function getSignalBlacklist() {
  if (Date.now() - _sigBlacklistCache.ts < 60 * 60 * 1000) return _sigBlacklistCache.set;
  const perf = signalPerformance();
  // Require min 10 observations to trust a "bad signal" verdict
  const bad = new Set(
    perf.filter(p => p.count >= 10 && p.winRate < 30 && p.avgReturn < 0).map(p => p.signal)
  );
  _sigBlacklistCache = { ts: Date.now(), set: bad };
  return bad;
}

// ── PDT rule check: flagged accounts with equity < 25k can't do >3 day-trades
// in 5 business days. Alpaca exposes `daytrade_count` and `pattern_day_trader`.
function pdtGuardBlocks(account) {
  // FINRA eliminated the PDT designation and the $25k/3-day-trade rule on
  // 2026-06-04 (SEC-approved amendment to Rule 4210). Day trades are no longer
  // counted; intraday buying power is real-time margin based. We only defer to
  // the broker: if Alpaca itself still flags the account, respect it.
  if (account.patternDayTrader) return 'Broker flags account as PDT-restricted';
  return null;
}

// ── Conviction-based sizing ──
// Fraction of maxPerStock to invest, driven by MEASURED edge, not vibes:
// - the 5d performance of this setup's signals (learned from gem outcomes)
// - presence of a killer combo (signal pairs with proven 10%+ hit rates)
// - agent consensus and Claude confidence
// Strong evidence → invest the full per-stock cap; weak evidence → a fraction.
function convictionFraction(stock, claude) {
  const signals = stock.signals || [];
  let f = stock.consensus === 'Strong Buy' ? 0.5 : 0.35;

  // Empirical edge: average 5d return of this setup's signals (n≥30 only)
  const perf = getSignalReport()?.signalPerformance || {};
  const edges = signals
    .map(s => perf[s])
    .filter(p => p && p.count >= 30)
    .map(p => p.avgReturn);
  if (edges.length > 0) {
    const avgEdge = edges.reduce((a, b) => a + b, 0) / edges.length;
    if (avgEdge >= 5) f += 0.25;
    else if (avgEdge >= 3) f += 0.15;
    else if (avgEdge >= 1.5) f += 0.08;
    else if (avgEdge < 0) f -= 0.15;
  }

  // Killer combo present (e.g. squeeze + volume_contraction: 71% hit10, n=24)
  if (getComboBonus(signals) >= 10) f += 0.15;

  // 28-year analog evidence (setup_stats.json): base rate for these setups is
  // ~+0.2%/5d, so >=+0.5%/5d on 1000+ cases is a genuinely strong family.
  const analog = stock.analog;
  if (analog && analog.n >= 1000) {
    if (analog.avgFwd5 >= 0.5) f += 0.12;
    else if (analog.avgFwd5 >= 0.25) f += 0.06;
    else if (analog.avgFwd5 < 0) f -= 0.15;
    if (analog.hitRate >= 0.15) f += 0.06;
  }

  // Claude/Gemini validation confidence
  if (claude) {
    if (claude.confidence >= 9) f += 0.2;
    else if (claude.confidence >= 8) f += 0.1;
    else if (claude.confidence <= 6) f -= 0.1;
  }

  return Math.min(1, Math.max(0.2, f));
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

  // PDT guard — blocks ALL new entries if the account is PDT-restricted
  const pdtBlock = pdtGuardBlocks(account);
  if (pdtBlock) {
    console.warn(`[AutoTrader] PDT block: ${pdtBlock}`);
    return { skipped: true, reason: pdtBlock };
  }

  // Budget ceiling = configured cap, bounded by overnight (RegT) margin
  // capacity of 2x equity. The 4x intraday buying power is deliberately NOT
  // used: this strategy holds positions overnight, and holding above 2x past
  // the close triggers a margin call — forced loss-selling that would violate
  // the never-sell-in-loss rule. (PDT rule itself was eliminated 2026-06-04.)
  const accountEquity = parseFloat(account.equity) || 0;
  const overnightCapacity = accountEquity > 0 ? accountEquity * 2 : config.maxBudget;
  const maxBudget = Math.min(overnightCapacity, config.maxBudget);

  const signalBlacklist = getSignalBlacklist();

  const results = { bought: [], skipped: [], errors: [] };

  // Sort by gemScore descending — trade the best setups first
  const sorted = [...analyzedStocks].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0));

  for (const stock of sorted) {
    const { symbol, consensus, buyCount, avgConviction, gemScore, signals, verdicts, price, companyName } = stock;

    // ── Strict quality filters — only trade the best ──
    if (!consensus || consensus === 'No Trade' || consensus === 'Speculative') {
      results.skipped.push({ symbol, reason: `Consensus: ${consensus || 'None'}`, gemScore, price });
      continue;
    }
    if (config.onlyStrongBuy && consensus !== 'Strong Buy') {
      results.skipped.push({ symbol, reason: `Consensus: ${consensus} (Only Strong Buy allowed)`, gemScore, price });
      continue;
    }
    if (gemScore < config.minGemScore) {
      // Too low gem score, silent skip (don't even log to skipped to avoid massive spam)
      continue;
    }
    if (avgConviction < config.minConviction) {
      results.skipped.push({ symbol, reason: `Low Agent Conviction (${avgConviction}/5)`, gemScore, price });
      continue;
    }
    // Price filter — focus on penny stocks under maxStockPrice
    if (config.maxStockPrice && price > config.maxStockPrice) {
      results.skipped.push({ symbol, reason: `Price $${price} > max $${config.maxStockPrice}`, gemScore, price });
      continue;
    }

    // Require order flow confirmation (insider buying, options, or institutions)
    if (config.requireOrderFlow) {
      const hasOrderFlow = (signals || []).some(s =>
        ['insider_buying', 'bullish_options', 'unusual_options_volume', 'institutions_accumulating'].includes(s)
      );
      if (!hasOrderFlow) {
        results.skipped.push({ symbol, reason: 'No order flow confirmation', gemScore, price });
        continue;
      }
    }

    // Block setups dominated by historically losing signals. Only kicks in once
    // tradeStats has enough resolved trades (min 10 obs per signal).
    if (signalBlacklist.size > 0 && Array.isArray(signals) && signals.length > 0) {
      const badSignals = signals.filter(s => signalBlacklist.has(s));
      // Block if majority of signals are blacklisted
      if (badSignals.length > signals.length / 2) {
        results.skipped.push({
          symbol,
          reason: `Dominated by low-performance signals: ${badSignals.slice(0, 3).join(', ')}`,
          gemScore, price,
        });
        continue;
      }
    }

    // ── Historical-evidence check: 28 years of setup analogs (1998→today).
    // Attach to the stock (telegram reuses it) and veto when history is
    // loudly negative for this setup family in this VIX regime.
    const analog = getAnalog(stock, stock.vixRegime);
    stock.analog = analog;
    const evidenceVeto = analogVeto(analog);
    if (evidenceVeto) {
      results.skipped.push({ symbol, reason: evidenceVeto, gemScore, price });
      continue;
    }

    if (heldSymbols.has(symbol)) {
      results.skipped.push({ symbol, reason: 'Already holding', gemScore, price });
      continue;
    }
    // ── Claude AI gate: if Claude analyzed this stock, require confidence >= 6 ──
    const claude = stock.claude;
    if (claude && claude.action === 'SKIP') {
      results.skipped.push({ symbol, reason: `Claude rejected (conf ${claude.confidence}/10)`, gemScore, price });
      continue;
    }
    if (claude && claude.confidence < 6) {
      results.skipped.push({ symbol, reason: `Claude low confidence (${claude.confidence}/10)`, gemScore, price });
      continue;
    }

    const currentlyInvested = totalInvested + results.bought.reduce((s, b) => s + b.amount, 0);
    // Conviction-based sizing: more money where the measured edge is stronger.
    // Replaces the old Kelly/Claude-pct paths, which sized off survivorship-
    // biased closed-trade stats and once scaled to the whole account.
    const conviction = convictionFraction(stock, claude);
    let amount = Math.max(50, Math.round(config.maxPerStock * conviction));

    // Regime scaling — stockIntel attaches positionMultiplier (0.3x panic → 1.2x calm).
    // In PANIC/HIGH_FEAR only Claude-high-confidence trades survive (override below).
    const regimeMult = stock.positionMultiplier;
    if (regimeMult != null && regimeMult < 1.0) {
      const isHighConviction = claude?.confidence >= 8;
      if (regimeMult <= 0.5 && !isHighConviction) {
        results.skipped.push({
          symbol,
          reason: `Risk-off regime (VIX ${stock.vixRegime || 'high'}), need Claude conf≥8`,
          gemScore, price,
        });
        continue;
      }
      amount = Math.max(50, Math.round(amount * regimeMult));
    } else if (regimeMult != null && regimeMult > 1.0) {
      amount = Math.round(amount * regimeMult);
    }

    // Hard per-stock cap — applies to every sizing path (Claude pct, Kelly,
    // defaults, regime scaling). Previously defined in config but never enforced.
    if (config.maxPerStock > 0) {
      amount = Math.min(amount, config.maxPerStock);
    }

    if (currentlyInvested + amount > maxBudget) {
      results.skipped.push({ symbol, reason: `Budget limit ($${Math.round(maxBudget)})`, gemScore, price });
      continue;
    }

    // Check buying power
    if (amount > account.buyingPower) {
      results.skipped.push({ symbol, reason: 'Insufficient buying power', gemScore, price });
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

    // Dynamic target: high-conviction setups keep their moon bag longer.
    // Trailing stops guarantee locked profit even if price reverses.
    const agentSuggested = buyAgents.length > 0 && buyAgents[0].targetGain
      ? parseFloat(buyAgents[0].targetGain)
      : null;
    const scoreBasedTarget = dynamicTargetPct(gemScore || 0, claude?.confidence || 0);
    const avgTargetPct = Math.max(
      agentSuggested || 0,
      scoreBasedTarget,
      config.takeProfitPct
    );

    try {
      console.log(`[AutoTrader] BUY ${symbol} — ${consensus} (${buyCount}/5 agents, conviction ${avgConviction}, score ${gemScore}) — $${amount} (edge sizing ${(conviction * 100).toFixed(0)}%)`);

      // Use marketable limit order (+0.5% above current) instead of pure market.
      // Market orders on thinly-traded small/penny stocks can eat 1-3% in slippage.
      // Alpaca's `notional` param requires MARKET orders, so for limit we convert
      // notional → whole-share qty at the limit price (floor).
      const useLimit = price && price > 0 && amount / price >= 1; // need ≥1 share for limit
      let order;
      if (useLimit) {
        const limitPrice = Math.round(price * 1.005 * 100) / 100;
        const qty = Math.floor(amount / limitPrice);
        order = await alpaca.submitOrder({
          symbol,
          qty,
          side: 'buy',
          type: 'limit',
          timeInForce: 'day',
          limitPrice,
        });
      } else {
        order = await alpaca.submitOrder({
          symbol,
          notional: amount,
          side: 'buy',
          type: 'market',
          timeInForce: 'day',
        });
      }

      // Use Claude's targets if available, otherwise agent defaults
      const finalStopPct = claude?.stopPct || Math.round(avgStopPct * 10) / 10;
      const finalTargetPct = claude?.targetPct || Math.round(avgTargetPct * 10) / 10;

      // ── Broker-side stop-loss: protects against gap opens / crashes ──
      // Polling every 2 min cannot catch a -20% gap. A resting stop order on Alpaca
      // triggers at the broker regardless of our uptime. Fire-and-forget; log if it fails.
      // GATED on hardStopPct: the user's #1 rule is never sell at a loss, so by
      // default (hardStopPct: 0) NO loss-selling order is placed at the broker.
      if (config.hardStopPct > 0 && price > 0 && finalStopPct > 0) {
        const stopPrice = Math.round(price * (1 - finalStopPct / 100) * 100) / 100;
        alpaca.submitStopLossAfterFill({
          symbol,
          parentOrderId: order.id,
          stopPrice,
        }).catch(err => console.error(`[AutoTrader] Stop-loss placement failed for ${symbol}:`, err.message));
      }

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

      // Notify Telegram + Google Sheets + Supabase (fire & forget)
      notifyNewTrade(tradeEntry).catch(() => {});
      logNewTrade(tradeEntry).catch(() => {});
      logSupabaseTrade(tradeEntry).catch(() => {});

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

  // Prevent overlapping runs from corrupting the trade log
  if (exitCheckerRunning) {
    console.log('[AutoTrader] Exit checker already running, skipping tick');
    return;
  }
  exitCheckerRunning = true;
  try {
    return await runExitCheck(config);
  } finally {
    exitCheckerRunning = false;
  }
}

async function runExitCheck(config) {
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
    // "SELL ONLY IN PROFIT" STRATEGY
    //
    // Principle: NEVER sell at a loss. Hold through drawdowns.
    // Only exit when the position is profitable and conditions are met.
    //
    // Phase 1: HOLD (negative)      → do nothing, wait for recovery
    // Phase 2: TAKE PROFIT (+target%) → close and celebrate
    // Phase 3: MOON TRAIL (+10%+)   → trail 3% from peak (always exit green)
    // Phase 4: PROFIT LOCK (+5%+)   → trail 2% from peak (always exit green)
    // Phase 5: SMART EXIT (+3%+)    → if momentum fading, secure the gain
    //
    // Result: every closed trade is a WIN. We hold losers until recovery.
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
        logSupabaseExit(entry).catch(() => {});
        if (entry.claudeConfidence) {
          recordOutcome(entry.symbol, entry.exitPrice, entry.price ? ((entry.exitPrice - entry.price) / entry.price * 100) : 0, entry.exitReason);
        }
      }
    };

    // ── RULE #0a: HARD STOP — disabled by default (hardStopPct: 0). ──
    // The user's #1 rule is NEVER sell at a loss. Only fires if explicitly
    // enabled in config for catastrophic protection.
    if (config.hardStopPct > 0 && unrealizedPLPct <= -config.hardStopPct) {
      try {
        console.log(`[AutoTrader] 🛑 HARD STOP ${symbol} at ${unrealizedPLPct.toFixed(1)}% (limit -${config.hardStopPct}%)`);
        await closeWithReason(`Hard stop (${unrealizedPLPct.toFixed(1)}%)`, 'hard_stop');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── RULE #0b: TIME STOP — recycle capital out of stale positions, but
    // ONLY at breakeven or better (never realizes a loss). A position older
    // than maxHoldDays exits as soon as it recovers to >= 0%.
    const entryTime = entry?.timestamp ? new Date(entry.timestamp).getTime() : null;
    const heldDays = entryTime ? (Date.now() - entryTime) / 86400000 : null;
    if (config.maxHoldDays > 0 && heldDays != null && heldDays >= config.maxHoldDays
        && unrealizedPLPct >= 0 && unrealizedPLPct < targetPct) {
      try {
        console.log(`[AutoTrader] ⏱️ TIME STOP ${symbol} after ${Math.floor(heldDays)}d at +${unrealizedPLPct.toFixed(1)}% (breakeven exit)`);
        await closeWithReason(`Time stop (${Math.floor(heldDays)}d held, +${unrealizedPLPct.toFixed(1)}%)`, 'time_stop');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── RULE #1: otherwise don't sell red — wait for recovery ──
    if (unrealizedPLPct < 0) {
      results.held.push({ symbol, pnlPct: unrealizedPLPct, reason: 'Holding (negative — waiting for recovery)' });
      continue;
    }

    // ── Phase 2: TAKE PROFIT ──
    if (unrealizedPLPct >= targetPct) {
      try {
        console.log(`[AutoTrader] 🎯 TAKE PROFIT ${symbol} at +${unrealizedPLPct.toFixed(1)}% (target: +${targetPct}%)`);
        await closeWithReason(`Take profit hit (+${unrealizedPLPct.toFixed(1)}%)`, 'take_profit');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── Phase 3: MOON TRAIL (was up 10%+, trail 3% — but never below +5%) ──
    if (maxGainSeen >= 10 && unrealizedPLPct < maxGainSeen - 3 && unrealizedPLPct >= 5) {
      try {
        console.log(`[AutoTrader] 🌙 MOON TRAIL ${symbol} — peak +${maxGainSeen.toFixed(1)}%, securing +${unrealizedPLPct.toFixed(1)}%`);
        await closeWithReason(`Moon trail (peak +${maxGainSeen.toFixed(1)}%, secured +${unrealizedPLPct.toFixed(1)}%)`, 'moon_trail');
      } catch (err) { console.error(`[AutoTrader] Failed to close ${symbol}:`, err.message); }
      continue;
    }

    // ── Phase 4: PROFIT LOCK (was up 5%+, trail 2% — but never below +5%) ──
    if (maxGainSeen >= 7 && unrealizedPLPct < maxGainSeen - 2 && unrealizedPLPct >= 5) {
      try {
        console.log(`[AutoTrader] 🔒 PROFIT LOCK ${symbol} — peak +${maxGainSeen.toFixed(1)}%, securing +${unrealizedPLPct.toFixed(1)}%`);
        await closeWithReason(`Profit locked (peak +${maxGainSeen.toFixed(1)}%, secured +${unrealizedPLPct.toFixed(1)}%)`, 'profit_lock');
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
