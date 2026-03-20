/**
 * Stock Oracle — Premium Telegram Bot
 *
 * Simple. Clean. Only what you need.
 * Real-time trade alerts + quick portfolio check.
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as alpaca from './alpaca.js';
import { getAutoTradeConfig, getAutoTradeLog } from './autoTrader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'telegramConfig.json');

let bot = null;
let chatId = null;
let scanCacheRef = { gems: [], pennies: [], allAnalyzed: [], lastScanTime: null };

export function setScanCache(cache) { scanCacheRef = cache; }

// ── Helpers ──
function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {};
}
function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function money(n) { return `$${(n || 0).toFixed(2)}`; }
function pct(n) { return `${(n || 0) >= 0 ? '+' : ''}${(n || 0).toFixed(1)}%`; }
function timeET() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
}
function send(id, text) {
  if (!bot) return;
  bot.sendMessage(id, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
}

// ── Init ──
export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('[Telegram] No token — bot disabled'); return null; }

  try {
    bot = new TelegramBot(token, { polling: true });
    const cfg = loadConfig();
    if (cfg.chatId) chatId = cfg.chatId;
    console.log(`[Telegram] Bot online${chatId ? ` (chat: ${chatId})` : ''}`);
    registerCommands();
    return bot;
  } catch (err) {
    console.error('[Telegram] Failed:', err.message);
    return null;
  }
}

export function isConnected() { return !!(bot && chatId); }
export function getBotInfo() { return { connected: isConnected(), chatId, hasToken: !!process.env.TELEGRAM_BOT_TOKEN }; }

// ════════════════════════════════════════
// COMMANDS — Premium & Simple
// ════════════════════════════════════════
function registerCommands() {

  // ── /start ──
  bot.onText(/\/start/, (msg) => {
    chatId = msg.chat.id;
    saveConfig({ chatId });
    send(chatId, [
      '                  *STOCK ORACLE*',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '   Your AI trading assistant is active.',
      '   You will receive alerts when trades',
      '   are executed automatically.',
      '',
      '   *Quick Commands:*',
      '',
      '   /portfolio  —  Your money at a glance',
      '   /trades     —  Recent trade results',
      '   /watchlist   —  What we are watching',
      '   /next       —  Trades ready for market open',
      '',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      `                    ${timeET()} ET`,
    ].join('\n'));
  });

  // ── /portfolio ──
  bot.onText(/\/portfolio/, async (msg) => {
    if (!alpaca.isConfigured()) return send(msg.chat.id, 'Connect Alpaca first on the web app.');
    try {
      const acc = await alpaca.getAccount();
      const positions = await alpaca.getPositions();
      const totalPL = positions.reduce((s, p) => s + p.unrealizedPL, 0);

      let posLines = '';
      if (positions.length > 0) {
        posLines = '\n' + positions.map(p => {
          const icon = p.unrealizedPL >= 0 ? '  \u2705' : '  \u274C';
          return `${icon}  *${p.symbol}*  ${money(p.currentPrice)}  ${pct(p.unrealizedPLPct)}  ${money(p.unrealizedPL)}`;
        }).join('\n') + '\n';
      }

      send(msg.chat.id, [
        '         ━━━━━━━━━━━━━━━━━━━━━━',
        '                *PORTFOLIO*',
        '         ━━━━━━━━━━━━━━━━━━━━━━',
        '',
        `   Balance         *${money(acc.equity)}*`,
        `   Available       *${money(acc.buyingPower)}*`,
        `   Today           *${pct(acc.dayPLPct)}*  (${money(acc.dayPL)})`,
        '',
        positions.length > 0 ? `   *Open Positions (${positions.length})*` : '   No open positions',
        posLines,
        positions.length > 0 ? `   Total P/L     *${money(totalPL)}*` : '',
        '',
        '         ━━━━━━━━━━━━━━━━━━━━━━',
      ].filter(Boolean).join('\n'));
    } catch (err) {
      console.error('[Telegram] /portfolio error:', err.message);
      send(msg.chat.id, `Something went wrong: ${err.message}`);
    }
  });

  // ── /trades ──
  bot.onText(/\/trades/, (msg) => {
    const log = getAutoTradeLog();
    if (log.length === 0) return send(msg.chat.id, 'No trades yet. The bot will notify you when it makes a move.');

    const recent = log.slice(0, 8);
    let wins = 0, losses = 0, totalPnl = 0;

    const lines = recent.map(t => {
      if (t.pnl != null) {
        if (t.pnl >= 0) wins++; else losses++;
        totalPnl += t.pnl;
      }
      const icon = t.pnl == null ? '\u23F3' : t.pnl >= 0 ? '\u2705' : '\u274C';
      const result = t.pnl != null ? `${money(t.pnl)}` : 'open';
      return `   ${icon}  *${t.symbol}*  ${money(t.price || 0)}  \u2192  ${result}`;
    });

    const record = wins + losses > 0 ? `   Record: *${wins}W ${losses}L*  |  Total: *${money(totalPnl)}*` : '';

    send(msg.chat.id, [
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '              *RECENT TRADES*',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '',
      ...lines,
      '',
      record,
      '',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
    ].filter(Boolean).join('\n'));
  });

  // ── /watchlist ──
  bot.onText(/\/watchlist/, (msg) => {
    const gems = (scanCacheRef.gems || []).sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 5);
    const pennies = (scanCacheRef.pennies || []).sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 5);
    const lastScan = scanCacheRef.lastScanTime;

    if (gems.length === 0 && pennies.length === 0) {
      return send(msg.chat.id, 'No data yet. Scanning happens every 5 min during market hours.');
    }

    const formatStock = (s) => {
      const dot = s.consensus === 'Strong Buy' ? '\uD83D\uDFE2' : s.consensus === 'Buy' ? '\uD83D\uDD35' : '\u26AA';
      return `   ${dot}  *${s.symbol}*  ${money(s.price)}  ${pct(s.changePct)}`;
    };

    const sections = [];

    if (gems.length > 0) {
      sections.push('   *Top Gems*');
      sections.push(...gems.map(formatStock));
      sections.push('');
    }

    if (pennies.length > 0) {
      sections.push('   *Top Penny Stocks*');
      sections.push(...pennies.map(formatStock));
      sections.push('');
    }

    send(msg.chat.id, [
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '               *WATCHLIST*',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '',
      `   \uD83D\uDFE2 = Strong Buy   \uD83D\uDD35 = Buy   \u26AA = Watch`,
      '',
      ...sections,
      `   Last scan: ${lastScan ? new Date(lastScan).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET' : 'waiting...'}`,
      '         ━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'));
  });

  // ── /next ──
  bot.onText(/\/next/, (msg) => {
    const config = getAutoTradeConfig();
    const all = scanCacheRef.allAnalyzed || [];

    if (all.length === 0) {
      return send(msg.chat.id, 'No scan data yet. Check back during market hours.');
    }

    // Apply same filters as auto-trader
    const candidates = all.filter(s => {
      if (!s.consensus || s.consensus === 'No Trade' || s.consensus === 'Speculative') return false;
      if (config.onlyStrongBuy && s.consensus !== 'Strong Buy') return false;
      if (s.gemScore < config.minGemScore) return false;
      if (s.avgConviction < config.minConviction) return false;
      if (config.maxStockPrice && s.price > config.maxStockPrice) return false;
      if (config.requireOrderFlow) {
        const hasFlow = (s.signals || []).some(sig =>
          ['insider_buying', 'bullish_options', 'unusual_options_volume', 'institutions_accumulating'].includes(sig)
        );
        if (!hasFlow) return false;
      }
      return true;
    }).sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 8);

    if (candidates.length === 0) {
      return send(msg.chat.id, [
        '         ━━━━━━━━━━━━━━━━━━━━━━',
        '              *NEXT TRADES*',
        '         ━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '   Nothing passes all filters right now.',
        '   The bot is scanning every 5 min.',
        '   You will be notified when it finds',
        '   a strong opportunity.',
        '',
        '         ━━━━━━━━━━━━━━━━━━━━━━',
      ].join('\n'));
    }

    const lines = candidates.map(s => {
      const amt = s.consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount;
      return `   \uD83D\uDFE2  *${s.symbol}*  ${money(s.price)}  \u2192  ${money(amt)}`;
    });

    const total = candidates.reduce((s, c) => s + (c.consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount), 0);

    send(msg.chat.id, [
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '              *NEXT TRADES*',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '   Ready to execute at market open:',
      '',
      ...lines,
      '',
      `   Total: *${money(total)}* / ${money(config.maxBudget)}`,
      '',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'));
  });
}

// ════════════════════════════════════════
// NOTIFICATIONS — Clean & Instant
// ════════════════════════════════════════

export async function notifyNewTrade(trade) {
  if (!bot || !chatId) return;

  const target = trade.price ? money(trade.price * (1 + (trade.targetPct || 10) / 100)) : '?';
  const stop = trade.price ? money(trade.price * (1 - (trade.stopPct || 5) / 100)) : '?';

  const text = [
    '         ━━━━━━━━━━━━━━━━━━━━━━',
    '            \uD83D\uDE80  *BOUGHT*',
    '         ━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `   *${trade.symbol}*  @  ${money(trade.price)}`,
    `   Amount:  ${money(trade.amount)}`,
    '',
    `   Target:   ${target}  (+${trade.targetPct || 10}%)`,
    `   Stop:      ${stop}  (-${trade.stopPct || 5}%)`,
    '',
    '         ━━━━━━━━━━━━━━━━━━━━━━',
    `                    ${timeET()} ET`,
  ].join('\n');

  try { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); }
  catch (err) { console.error('[Telegram] Send failed:', err.message); }
}

export async function notifyTradeExit(trade) {
  if (!bot || !chatId) return;

  const won = (trade.pnl || 0) >= 0;
  const icon = won ? '\u2705' : '\u274C';
  const label = won ? 'SOLD  \u2014  PROFIT' : 'SOLD  \u2014  LOSS';

  // Hold duration
  const hours = Math.round((new Date() - new Date(trade.timestamp)) / 3600000);
  const held = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;

  const pnlPctVal = trade.price ? (((trade.exitPrice || 0) - trade.price) / trade.price * 100) : 0;

  const text = [
    '         ━━━━━━━━━━━━━━━━━━━━━━',
    `            ${icon}  *${label}*`,
    '         ━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `   *${trade.symbol}*  ${money(trade.price)}  \u2192  ${money(trade.exitPrice)}`,
    `   Result:  *${money(trade.pnl)}*  (${pct(pnlPctVal)})`,
    `   Held:  ${held}`,
    '',
    '         ━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  try { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }); }
  catch (err) { console.error('[Telegram] Send failed:', err.message); }
}

export async function notifyError(message) {
  if (!bot || !chatId) return;
  try { await bot.sendMessage(chatId, `\u26A0\uFE0F ${message}`, { parse_mode: 'Markdown' }); } catch {}
}

export async function sendTestMessage() {
  if (!bot || !chatId) return { success: false, error: 'Bot not connected' };
  try {
    await bot.sendMessage(chatId, [
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '              *STOCK ORACLE*',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '   \u2705  Notifications are working.',
      '',
      '         ━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'), { parse_mode: 'Markdown' });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
}

export function stopBot() { if (bot) { bot.stopPolling(); bot = null; } }
