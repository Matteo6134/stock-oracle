/**
 * Telegram Bot Service — Trade notifications + command interface
 *
 * Commands: /start, /balance, /positions, /history, /agents, /signals
 * Notifications: new trades, exits, stop losses, take profits
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as alpaca from './alpaca.js';
import { getAutoTradeConfig, getAutoTradeLog } from './autoTrader.js';
import { getAgentProfiles } from './tradingDesk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'telegramConfig.json');

let bot = null;
let chatId = null;

// ── Config Persistence ──
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Initialize Bot ──
export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set — bot disabled');
    return null;
  }

  try {
    bot = new TelegramBot(token, { polling: true });
    console.log('[Telegram] Bot started (polling mode)');

    // Load saved chat ID
    const cfg = loadConfig();
    if (cfg.chatId) {
      chatId = cfg.chatId;
      console.log(`[Telegram] Restored chat ID: ${chatId}`);
    }

    // Register commands
    registerCommands();
    return bot;
  } catch (err) {
    console.error('[Telegram] Failed to start bot:', err.message);
    return null;
  }
}

export function isConnected() {
  return !!(bot && chatId);
}

export function getBotInfo() {
  return { connected: isConnected(), chatId, hasToken: !!process.env.TELEGRAM_BOT_TOKEN };
}

// ── Commands ──
function registerCommands() {
  // /start — Register chat
  bot.onText(/\/start/, (msg) => {
    chatId = msg.chat.id;
    saveConfig({ chatId });
    console.log(`[Telegram] Chat registered: ${chatId}`);
    bot.sendMessage(chatId, [
      '🤖 *Stock Oracle Bot Connected!*',
      '',
      'I\\'ll notify you when agents execute trades.',
      '',
      '*Commands:*',
      '/balance — Account overview',
      '/positions — Open positions',
      '/history — Recent trades',
      '/agents — Agent status',
      '/signals — Top signals now',
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  // /balance — Account info
  bot.onText(/\/balance/, async (msg) => {
    if (!alpaca.isConfigured()) return bot.sendMessage(msg.chat.id, '❌ Alpaca not configured');
    try {
      const acc = await alpaca.getAccount();
      const daySign = acc.dayPL >= 0 ? '+' : '';
      bot.sendMessage(msg.chat.id, [
        '💰 *Account Balance*',
        '',
        `💎 Equity: $${acc.equity.toFixed(2)}`,
        `💵 Cash: $${acc.cash.toFixed(2)}`,
        `🛒 Buying Power: $${acc.buyingPower.toFixed(2)}`,
        `📊 Today: ${daySign}$${acc.dayPL.toFixed(2)} (${daySign}${acc.dayPLPct.toFixed(2)}%)`,
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /positions — Open positions
  bot.onText(/\/positions/, async (msg) => {
    if (!alpaca.isConfigured()) return bot.sendMessage(msg.chat.id, '❌ Alpaca not configured');
    try {
      const positions = await alpaca.getPositions();
      if (positions.length === 0) {
        return bot.sendMessage(msg.chat.id, '📭 No open positions');
      }

      let totalPL = 0;
      const lines = positions.map(p => {
        totalPL += p.unrealizedPL;
        const sign = p.unrealizedPL >= 0 ? '+' : '';
        const emoji = p.unrealizedPL >= 0 ? '📈' : '📉';
        return `${emoji} *${p.symbol}* — ${p.qty} shares @ $${p.avgEntryPrice.toFixed(2)}\n   Now $${p.currentPrice.toFixed(2)} | ${sign}$${p.unrealizedPL.toFixed(2)} (${sign}${p.unrealizedPLPct.toFixed(1)}%)`;
      });

      const totalSign = totalPL >= 0 ? '+' : '';
      bot.sendMessage(msg.chat.id, [
        `📊 *Open Positions (${positions.length})*`,
        '',
        ...lines,
        '',
        `💰 Total P/L: ${totalSign}$${totalPL.toFixed(2)}`,
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
  });

  // /history — Recent trades
  bot.onText(/\/history/, (msg) => {
    const log = getAutoTradeLog();
    if (log.length === 0) {
      return bot.sendMessage(msg.chat.id, '📭 No trade history yet');
    }

    const recent = log.slice(0, 10);
    let wins = 0, losses = 0, totalPnl = 0;

    const lines = recent.map(t => {
      if (t.pnl != null) {
        if (t.pnl >= 0) wins++; else losses++;
        totalPnl += t.pnl;
      }
      const pnlStr = t.pnl != null ? ` → ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : ' ⏳ Open';
      const emoji = t.pnl == null ? '⏳' : t.pnl >= 0 ? '✅' : '❌';
      return `${emoji} *${t.symbol}* ${t.consensus} @ $${(t.price || 0).toFixed(2)}${pnlStr}`;
    });

    const totalSign = totalPnl >= 0 ? '+' : '';
    bot.sendMessage(msg.chat.id, [
      `📜 *Last ${recent.length} Trades*`,
      '',
      ...lines,
      '',
      `📊 ${wins}W / ${losses}L | Total: ${totalSign}$${totalPnl.toFixed(2)}`,
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  // /agents — Agent status
  bot.onText(/\/agents/, (msg) => {
    const profiles = getAgentProfiles();
    const config = getAutoTradeConfig();

    const lines = profiles.map(a => {
      const status = a.enabled ? '✅' : '⛔';
      return `${a.emoji} ${status} *${a.name}* — Stop ${a.stopPct}% | Target +${a.targetGainRange[0]}-${a.targetGainRange[1]}%`;
    });

    bot.sendMessage(msg.chat.id, [
      `🤖 *Agent Status* — Auto-trading: ${config.enabled ? 'ON ✅' : 'OFF ⛔'}`,
      '',
      ...lines,
      '',
      `💰 Budget: $${config.maxBudget} | Max ${config.maxPositions} positions`,
      `🎯 Min Score: ${config.minGemScore} | Min Conviction: ${config.minConviction}`,
    ].join('\n'), { parse_mode: 'Markdown' });
  });

  // /signals — Current top signals
  bot.onText(/\/signals/, (msg) => {
    // We'll read from the last scan cache
    const log = getAutoTradeLog();
    const recentBuys = log.filter(t => !t.exitPrice).slice(0, 5);

    if (recentBuys.length === 0) {
      return bot.sendMessage(msg.chat.id, '📭 No active signals — agents scanning every 5 min');
    }

    const lines = recentBuys.map(t => {
      return `📈 *${t.symbol}* — ${t.consensus} | Score ${t.gemScore} | $${(t.price || 0).toFixed(2)}`;
    });

    bot.sendMessage(msg.chat.id, [
      '📡 *Active Positions from Signals*',
      '',
      ...lines,
    ].join('\n'), { parse_mode: 'Markdown' });
  });
}

// ── Notification Functions ──

export async function notifyNewTrade(trade) {
  if (!bot || !chatId) return;

  const probability = trade.buyCount ? Math.round((trade.buyCount / 5) * 100) : 0;
  const targetPrice = trade.price ? (trade.price * (1 + (trade.targetPct || 10) / 100)).toFixed(2) : '?';
  const stopPrice = trade.price ? (trade.price * (1 - (trade.stopPct || 5) / 100)).toFixed(2) : '?';

  const msg = [
    `🚀 *NEW TRADE — ${trade.consensus}*`,
    '',
    `📈 *${trade.symbol}* @ $${(trade.price || 0).toFixed(2)}`,
    `💰 Amount: $${trade.amount} (Long)`,
    `🎯 Target: +${trade.targetPct || 10}% → $${targetPrice}`,
    `🛑 Stop Loss: -${trade.stopPct || 5}% → $${stopPrice}`,
    `📊 Probability: ${probability}% (${trade.buyCount}/5 agents, conviction ${trade.avgConviction})`,
    `🏆 Score: ${trade.gemScore} | Source: ${trade.source === 'penny' ? 'Penny Stocks' : 'Gem Finder'}`,
    `⏰ ${new Date(trade.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} ET`,
  ].join('\n');

  try {
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Telegram] Failed to send trade notification:', err.message);
  }
}

export async function notifyTradeExit(trade) {
  if (!bot || !chatId) return;

  const isProfit = (trade.pnl || 0) >= 0;
  const emoji = isProfit ? '✅' : '🛑';
  const icon = isProfit ? '📈' : '📉';
  const title = trade.exitReason || (isProfit ? 'TAKE PROFIT' : 'STOP LOSS');

  // Calculate hold duration
  const entryTime = new Date(trade.timestamp);
  const exitTime = new Date();
  const holdMs = exitTime - entryTime;
  const holdHours = Math.round(holdMs / 3600000);
  const holdStr = holdHours >= 24 ? `${Math.round(holdHours / 24)} days` : `${holdHours} hours`;

  const pnlSign = (trade.pnl || 0) >= 0 ? '+' : '';
  const pnlPct = trade.price ? ((((trade.exitPrice || 0) - trade.price) / trade.price) * 100).toFixed(1) : '?';

  const msg = [
    `${emoji} *${title.toUpperCase()}*`,
    '',
    `${icon} *${trade.symbol}*: $${(trade.price || 0).toFixed(2)} → $${(trade.exitPrice || 0).toFixed(2)}`,
    `💰 P/L: ${pnlSign}$${(trade.pnl || 0).toFixed(2)} (${pnlSign}${pnlPct}%)`,
    `🎯 Exit: ${trade.exitReason}`,
    `⏰ Held ${holdStr}`,
  ].join('\n');

  try {
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[Telegram] Failed to send exit notification:', err.message);
  }
}

export async function notifyError(message) {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, `⚠️ *Alert:* ${message}`, { parse_mode: 'Markdown' });
  } catch { /* ignore */ }
}

export async function sendTestMessage() {
  if (!bot || !chatId) return { success: false, error: 'Bot not connected or no chat ID' };
  try {
    await bot.sendMessage(chatId, '✅ *Test message from Stock Oracle*\n\nTelegram notifications are working!', { parse_mode: 'Markdown' });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Cleanup on shutdown
export function stopBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
}
