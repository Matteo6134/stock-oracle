/**
 * Stock Oracle — Telegram Bot
 * Clean. Colorful. No noise.
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
let scanCacheRef = { gems: [], pennies: [], allAnalyzed: [], movers: [], lastScanTime: null, lastMoversTime: null };

export function setScanCache(cache) { scanCacheRef = cache; }

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {};
}
function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function $(n) { return `$${(n || 0).toFixed(2)}`; }
function p(n) { return `${(n || 0) >= 0 ? '+' : ''}${(n || 0).toFixed(1)}%`; }
function send(id, text) {
  if (!bot) return;
  bot.sendMessage(id, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
}

export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('[Telegram] No token'); return null; }
  try {
    bot = new TelegramBot(token, { polling: true });
    const cfg = loadConfig();
    if (cfg.chatId) chatId = cfg.chatId;
    console.log(`[Telegram] Bot online${chatId ? ` (chat: ${chatId})` : ''}`);
    registerCommands();
    return bot;
  } catch (err) { console.error('[Telegram]', err.message); return null; }
}

export function isConnected() { return !!(bot && chatId); }
export function getBotInfo() { return { connected: isConnected(), chatId, hasToken: !!process.env.TELEGRAM_BOT_TOKEN }; }

function registerCommands() {

  // /start
  bot.onText(/\/start/, (msg) => {
    chatId = msg.chat.id;
    saveConfig({ chatId });
    send(chatId, [
      '\uD83D\uDD2E *Stock Oracle*',
      '',
      '/portfolio \u2014 balance & positions',
      '/trades \u2014 results',
      '/next \u2014 before the bell',
      '/watchlist \u2014 top picks',
    ].join('\n'));
  });

  // /portfolio
  bot.onText(/\/portfolio/, async (msg) => {
    if (!alpaca.isConfigured()) return send(msg.chat.id, '\u26A0\uFE0F Connect Alpaca on the web app first.');
    try {
      const acc = await alpaca.getAccount();
      const positions = await alpaca.getPositions();

      const lines = [
        `\uD83D\uDCB0 *${$(acc.equity)}*  equity`,
        `\uD83D\uDCB5 ${$(acc.buyingPower)}  available`,
        `${acc.dayPL >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ${p(acc.dayPLPct)}  today  (${$(acc.dayPL)})`,
      ];

      if (positions.length > 0) {
        lines.push('');
        positions.forEach(pos => {
          const icon = pos.unrealizedPL >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
          lines.push(`${icon} *${pos.symbol}*  ${$(pos.currentPrice)}  ${p(pos.unrealizedPLPct)}  ${$(pos.unrealizedPL)}`);
        });
        const total = positions.reduce((s, pos) => s + pos.unrealizedPL, 0);
        lines.push(`\n\uD83D\uDCCA Total P/L: *${$(total)}*`);
      } else {
        lines.push('\nNo open positions');
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      console.error('[Telegram] /portfolio:', err.message);
      send(msg.chat.id, `\u26A0\uFE0F ${err.message}`);
    }
  });

  // /trades
  bot.onText(/\/trades/, (msg) => {
    const log = getAutoTradeLog();
    if (log.length === 0) return send(msg.chat.id, 'No trades yet.');

    const recent = log.slice(0, 8);
    let wins = 0, losses = 0, totalPnl = 0;

    const lines = recent.map(t => {
      if (t.pnl != null) { t.pnl >= 0 ? wins++ : losses++; totalPnl += t.pnl; }
      const icon = t.pnl == null ? '\u23F3' : t.pnl >= 0 ? '\u2705' : '\u274C';
      const result = t.pnl != null ? $(t.pnl) : 'open';
      return `${icon} *${t.symbol}*  ${$(t.price || 0)}  \u2192  ${result}`;
    });

    if (wins + losses > 0) {
      lines.push(`\n\uD83C\uDFC6 *${wins}W ${losses}L*  |  ${$(totalPnl)}`);
    }

    send(msg.chat.id, lines.join('\n'));
  });

  // /watchlist
  bot.onText(/\/watchlist/, (msg) => {
    const gems = scanCacheRef.gems || [];
    const pennies = scanCacheRef.pennies || [];
    const movers = scanCacheRef.movers || [];

    if (gems.length === 0 && pennies.length === 0 && movers.length === 0) {
      return send(msg.chat.id, 'Scanning... check back in a few minutes.');
    }

    const lines = [];

    if (movers.length > 0) {
      lines.push('\uD83D\uDD25 *Pre-Market*');
      movers.slice(0, 5).forEach(m => {
        const icon = (m.gapPct || 0) >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
        lines.push(`${icon} *${m.symbol}*  ${p(m.gapPct)}  vol ${(m.volumeRatio || 0).toFixed(1)}x`);
      });
      lines.push('');
    }

    if (gems.length > 0) {
      const top = [...gems].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 5);
      lines.push('\uD83D\uDC8E *Gems*');
      top.forEach(g => {
        const icon = g.consensus === 'Strong Buy' ? '\uD83D\uDFE2' : g.consensus === 'Buy' ? '\uD83D\uDD35' : '\u26AA';
        lines.push(`${icon} *${g.symbol}*  ${$(g.price)}  ${p(g.changePct)}`);
      });
      lines.push('');
    }

    if (pennies.length > 0) {
      const top = [...pennies].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 5);
      lines.push('\uD83E\uDE99 *Pennies*');
      top.forEach(pp => {
        const icon = pp.consensus === 'Strong Buy' ? '\uD83D\uDFE2' : pp.consensus === 'Buy' ? '\uD83D\uDD35' : '\u26AA';
        lines.push(`${icon} *${pp.symbol}*  ${$(pp.price)}  ${p(pp.changePct)}`);
      });
    }

    send(msg.chat.id, lines.join('\n'));
  });

  // /next — what happens at market open
  bot.onText(/\/next/, (msg) => {
    const config = getAutoTradeConfig();
    const all = scanCacheRef.allAnalyzed || [];
    const movers = scanCacheRef.movers || [];

    if (all.length === 0 && movers.length === 0) {
      return send(msg.chat.id, 'No data yet. Scanning starts 4 AM ET.');
    }

    const lines = [];

    // Auto-buys
    const autoBuys = all.filter(s => {
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
    }).sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 5);

    if (autoBuys.length > 0) {
      const label = config.enabled ? '\uD83D\uDFE2 *Buying at open*' : '\uD83D\uDFE1 *Would buy (auto off)*';
      lines.push(label);
      autoBuys.forEach(s => {
        const amt = s.consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount;
        lines.push(`   *${s.symbol}*  ${$(s.price)}  \u2192  ${$(amt)}`);
      });
      if (config.enabled) {
        const total = autoBuys.reduce((sum, s) => sum + (s.consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount), 0);
        lines.push(`   Total: *${$(total)}*`);
      }
      lines.push('');
    }

    // Hot premarket
    const hot = [...movers].filter(m => Math.abs(m.gapPct || 0) > 5).sort((a, b) => Math.abs(b.gapPct || 0) - Math.abs(a.gapPct || 0)).slice(0, 5);
    if (hot.length > 0) {
      lines.push('\uD83D\uDD25 *Hot pre-market*');
      hot.forEach(m => {
        const icon = (m.gapPct || 0) >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
        lines.push(`${icon} *${m.symbol}*  ${p(m.gapPct)}`);
      });
      lines.push('');
    }

    // Watching closely
    const watching = all.filter(s => s.consensus === 'Buy' || (s.consensus === 'Speculative' && (s.gemScore || 0) >= 50))
      .sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 3);
    if (watching.length > 0) {
      lines.push('\uD83D\uDD35 *Watching*');
      watching.forEach(s => {
        lines.push(`   *${s.symbol}*  ${$(s.price)}  ${p(s.changePct)}`);
      });
    }

    if (lines.length === 0) {
      lines.push('Nothing strong enough yet.');
      lines.push('Scanning every 5 min...');
    }

    send(msg.chat.id, lines.join('\n'));
  });
}

// ── Notifications ──

export async function notifyNewTrade(trade) {
  if (!bot || !chatId) return;
  const target = trade.price ? $(trade.price * (1 + (trade.targetPct || 10) / 100)) : '?';
  const stop = trade.price ? $(trade.price * (1 - (trade.stopPct || 5) / 100)) : '?';

  try {
    await bot.sendMessage(chatId, [
      `\uD83D\uDE80 *BOUGHT ${trade.symbol}*`,
      '',
      `\uD83D\uDCB0 ${$(trade.price)}  \u00D7  ${$(trade.amount)}`,
      `\uD83C\uDFAF ${target}  (+${trade.targetPct || 10}%)`,
      `\uD83D\uDED1 ${stop}  (-${trade.stopPct || 5}%)`,
    ].join('\n'), { parse_mode: 'Markdown' });
  } catch (err) { console.error('[Telegram]', err.message); }
}

export async function notifyTradeExit(trade) {
  if (!bot || !chatId) return;
  const won = (trade.pnl || 0) >= 0;
  const hours = Math.round((new Date() - new Date(trade.timestamp)) / 3600000);
  const held = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  const pnlPct = trade.price ? (((trade.exitPrice || 0) - trade.price) / trade.price * 100) : 0;

  try {
    await bot.sendMessage(chatId, [
      `${won ? '\u2705' : '\u274C'} *SOLD ${trade.symbol}*`,
      '',
      `${$(trade.price)} \u2192 ${$(trade.exitPrice)}`,
      `${won ? '\uD83D\uDFE2' : '\uD83D\uDD34'} *${$(trade.pnl)}*  (${p(pnlPct)})  \u00B7  ${held}`,
    ].join('\n'), { parse_mode: 'Markdown' });
  } catch (err) { console.error('[Telegram]', err.message); }
}

export async function notifyError(message) {
  if (!bot || !chatId) return;
  try { await bot.sendMessage(chatId, `\u26A0\uFE0F ${message}`, { parse_mode: 'Markdown' }); } catch {}
}

export async function sendTestMessage() {
  if (!bot || !chatId) return { success: false, error: 'Not connected' };
  try {
    await bot.sendMessage(chatId, '\u2705 *Stock Oracle* \u2014 notifications active', { parse_mode: 'Markdown' });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
}

export function stopBot() { if (bot) { bot.stopPolling(); bot = null; } }
