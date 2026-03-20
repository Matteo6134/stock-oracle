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
import { getWatchlist } from './watchlist.js';
import * as yahoo from './yahooFinance.js';

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
function getTargetInfo(stock) {
  const buyVerdicts = (stock.verdicts || []).filter(v => v.action === 'BUY');
  if (buyVerdicts.length === 0 || !stock.price) return null;
  const avgTarget = buyVerdicts.reduce((s, v) => s + (parseFloat(v.targetGain) || 0), 0) / buyVerdicts.length;
  const avgStopPct = buyVerdicts.reduce((s, v) => {
    return s + (v.stopLoss ? Math.round(((stock.price - v.stopLoss) / stock.price) * 100) : 5);
  }, 0) / buyVerdicts.length;
  const tp = $(stock.price * (1 + avgTarget / 100));
  const sl = $(stock.price * (1 - avgStopPct / 100));
  return `+${avgTarget.toFixed(0)}% \u2192 ${tp}  SL ${sl}`;
}

function send(id, text) {
  if (!bot) return;
  bot.sendMessage(id, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
}

export function initTelegramBot() {
  if (process.env.VERCEL) { console.log('[Telegram] Skipped on Vercel'); return null; }
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
      '/watchlist \u2014 your saved stocks',
      '/scan \u2014 best picks right now',
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

  // /watchlist — YOUR saved watchlist from the web app
  bot.onText(/\/watchlist/, async (msg) => {
    const symbols = getWatchlist();

    if (symbols.length === 0) {
      return send(msg.chat.id, 'Your watchlist is empty. Add stocks from the web app.');
    }

    try {
      const quotes = await yahoo.getQuoteBatch(symbols);
      const lines = ['\uD83D\uDCCC *Your Watchlist*', ''];

      symbols.forEach(sym => {
        const q = quotes.find(qq => qq.symbol === sym);
        if (q && q.regularMarketPrice) {
          const change = q.regularMarketChangePercent || 0;
          const icon = change >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
          lines.push(`${icon} *${sym}*  ${$(q.regularMarketPrice)}  ${p(change)}`);
        } else {
          lines.push(`\u26AA *${sym}*`);
        }
      });

      send(msg.chat.id, lines.join('\n'));
    } catch {
      // Fallback without prices
      const lines = ['\uD83D\uDCCC *Your Watchlist*', ''];
      symbols.forEach(sym => lines.push(`\u26AA *${sym}*`));
      send(msg.chat.id, lines.join('\n'));
    }
  });

  // /scan — best picks from latest scan (gems + pennies + movers)
  bot.onText(/\/scan/, (msg) => {
    const gems = scanCacheRef.gems || [];
    const pennies = scanCacheRef.pennies || [];
    const movers = scanCacheRef.movers || [];

    if (gems.length === 0 && pennies.length === 0 && movers.length === 0) {
      return send(msg.chat.id, 'No scan data yet. Check back during market hours.');
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
        const info = getTargetInfo(g);
        lines.push(`${icon} *${g.symbol}*  ${$(g.price)}  ${p(g.changePct)}`);
        if (info) lines.push(`   \uD83C\uDFAF ${info}`);
      });
      lines.push('');
    }

    if (pennies.length > 0) {
      const top = [...pennies].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 5);
      lines.push('\uD83E\uDE99 *Pennies*');
      top.forEach(pp => {
        const icon = pp.consensus === 'Strong Buy' ? '\uD83D\uDFE2' : pp.consensus === 'Buy' ? '\uD83D\uDD35' : '\u26AA';
        const info = getTargetInfo(pp);
        lines.push(`${icon} *${pp.symbol}*  ${$(pp.price)}  ${p(pp.changePct)}`);
        if (info) lines.push(`   \uD83C\uDFAF ${info}`);
      });
    }

    send(msg.chat.id, lines.join('\n'));
  });

  // /next — what the bot will buy on Alpaca at market open
  // So you can place the same orders early if you want
  bot.onText(/\/next/, async (msg) => {
    const config = getAutoTradeConfig();
    const all = scanCacheRef.allAnalyzed || [];
    const movers = scanCacheRef.movers || [];

    if (all.length === 0 && movers.length === 0) {
      return send(msg.chat.id, 'No data yet. Scanning starts 4 AM ET.');
    }

    // Already held symbols — bot won't buy duplicates
    let heldSymbols = new Set();
    try {
      if (alpaca.isConfigured()) {
        const positions = await alpaca.getPositions();
        heldSymbols = new Set(positions.map(pp => pp.symbol));
      }
    } catch {}

    const lines = [];

    // 1. Auto-buys — exactly what the bot will execute at 9:30
    const autoBuys = all.filter(s => {
      if (heldSymbols.has(s.symbol)) return false;
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

    if (autoBuys.length > 0) {
      lines.push(config.enabled
        ? '\uD83D\uDFE2 *Auto-buying at 9:30 AM*'
        : '\uD83D\uDFE1 *Would buy (auto-trade is off)*');
      lines.push('');

      let totalAmt = 0;
      autoBuys.forEach(s => {
        const amt = s.consensus === 'Strong Buy' ? config.strongBuyAmount : config.buyAmount;
        totalAmt += amt;
        const buyVerdicts = (s.verdicts || []).filter(v => v.action === 'BUY');
        const avgTarget = buyVerdicts.length > 0
          ? buyVerdicts.reduce((sum, v) => sum + (parseFloat(v.targetGain) || 0), 0) / buyVerdicts.length
          : config.takeProfitPct || 10;
        const avgStop = buyVerdicts.length > 0
          ? buyVerdicts.reduce((sum, v) => {
              const stopPctVal = v.stopLoss && s.price ? Math.round(((s.price - v.stopLoss) / s.price) * 100) : 5;
              return sum + stopPctVal;
            }, 0) / buyVerdicts.length
          : config.defaultStopPct || 5;
        const tpPrice = s.price ? $(s.price * (1 + avgTarget / 100)) : '?';
        const slPrice = s.price ? $(s.price * (1 - avgStop / 100)) : '?';

        lines.push(`\uD83D\uDFE2 *${s.symbol}*  LONG  ${$(s.price)}`);
        lines.push(`   ${$(amt)}  \uD83C\uDFAF +${avgTarget.toFixed(0)}% ${tpPrice}  \uD83D\uDED1 -${avgStop.toFixed(0)}% ${slPrice}`);
      });
      lines.push(`\n\uD83D\uDCB0 *${$(totalAmt)}* / ${$(config.maxBudget)}`);
      lines.push('');
    }

    // 2. Hot pre-market movers — might explode at open
    const hot = [...movers]
      .filter(m => Math.abs(m.gapPct || 0) > 5 && !heldSymbols.has(m.symbol))
      .sort((a, b) => Math.abs(b.gapPct || 0) - Math.abs(a.gapPct || 0))
      .slice(0, 5);
    if (hot.length > 0) {
      lines.push('\uD83D\uDD25 *Moving pre-market*');
      hot.forEach(m => {
        const icon = (m.gapPct || 0) >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
        lines.push(`${icon} *${m.symbol}*  ${p(m.gapPct)}  vol ${(m.volumeRatio || 0).toFixed(1)}x`);
      });
      lines.push('');
    }

    // 3. Close to triggering — one more signal and they buy
    const almostReady = all.filter(s => {
      if (heldSymbols.has(s.symbol)) return false;
      if (autoBuys.find(a => a.symbol === s.symbol)) return false;
      return s.consensus === 'Buy' && s.gemScore >= 50;
    }).sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 4);

    if (almostReady.length > 0) {
      lines.push('\uD83D\uDD35 *Almost triggering*');
      almostReady.forEach(s => {
        const info = getTargetInfo(s);
        lines.push(`   *${s.symbol}*  ${$(s.price)}  ${p(s.changePct)}`);
        if (info) lines.push(`   \uD83C\uDFAF ${info}`);
      });
    }

    if (lines.length === 0) {
      lines.push('Nothing strong enough yet.');
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
