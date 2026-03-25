/**
 * Stock Oracle — Telegram Bot
 * 5 commands only. Clean. Simple. No noise.
 *
 * /scan            — explosion gems (what to buy)
 * /bet             — polymarket picks
 * /portfolio_stock — stock auto-trade stats
 * /portfolio_poly  — polymarket portfolio
 * /clear           — wipe entire chat
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as alpaca from './alpaca.js';
import { getAutoTradeLog } from './autoTrader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'telegramConfig.json');

let bot = null;
let chatId = null;
let scanCacheRef = { gems: [], pennies: [], allAnalyzed: [], movers: [], lastScanTime: null };

// Alert dedup
const alertedStocks = new Map();
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const ALERT_SCORE_JUMP = 20;

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
  bot.sendMessage(id, text, { parse_mode: 'Markdown', disable_web_page_preview: true })
    .catch(() => {
      const plain = text.replace(/\*/g, '').replace(/_/g, '');
      bot.sendMessage(id, plain, { disable_web_page_preview: true }).catch(() => {});
    });
}

// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════

export function initTelegramBot() {
  if (process.env.VERCEL) return null;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('[Telegram] No token'); return null; }

  try {
    bot = new TelegramBot(token, { polling: { params: { timeout: 10 } } });

    bot.on('polling_error', (err) => {
      console.error('[Telegram] Polling error:', err.message);
      if (err.message?.includes('409')) { bot.stopPolling(); }
    });

    // Load chatId
    if (process.env.TELEGRAM_CHAT_ID) {
      chatId = parseInt(process.env.TELEGRAM_CHAT_ID, 10);
    } else {
      const cfg = loadConfig();
      if (cfg.chatId) chatId = cfg.chatId;
    }
    console.log(`[Telegram] Bot online${chatId ? ` (chat: ${chatId})` : ' — send /start'}`);

    // Set menu — 5 commands only
    bot.setMyCommands([
      { command: 'scan', description: '\uD83D\uDD25 Explosion gems — stocks about to move' },
      { command: 'bet', description: '\uD83C\uDFAF Polymarket picks' },
      { command: 'portfolio_stock', description: '\uD83D\uDCB0 Stock auto-trade results' },
      { command: 'portfolio_poly', description: '\uD83C\uDFB2 Polymarket portfolio' },
      { command: 'clear', description: '\uD83E\uDDF9 Clear entire chat' },
    ]).catch(() => {});

    registerCommands();
    return bot;
  } catch (err) { console.error('[Telegram]', err.message); return null; }
}

export function isConnected() { return !!(bot && chatId); }
export function getBotInfo() { return { connected: isConnected(), chatId, hasToken: !!process.env.TELEGRAM_BOT_TOKEN }; }

// ════════════════════════════════════════════════════════
// COMMANDS
// ════════════════════════════════════════════════════════

function registerCommands() {

  // /start — register + welcome
  bot.onText(/\/start/, (msg) => {
    chatId = msg.chat.id;
    saveConfig({ chatId });
    console.log(`[Telegram] ChatId registered: ${chatId}`);
    send(chatId, [
      '\uD83D\uDD2E *Stock Oracle*',
      '',
      '\uD83D\uDD25 /scan \u2014 Explosion gems',
      '\uD83C\uDFAF /bet \u2014 Polymarket picks',
      '\uD83D\uDCB0 /portfolio\\_stock \u2014 Stock results',
      '\uD83C\uDFB2 /portfolio\\_poly \u2014 Poly portfolio',
      '\uD83E\uDDF9 /clear \u2014 Clear chat',
      '',
      'I scan every 5 min and alert you automatically.',
    ].join('\n'));
  });

  // ────────────────────────────────────────────────
  // /scan — EXPLOSION GEMS (the core feature)
  // ────────────────────────────────────────────────
  bot.onText(/\/scan/, (msg) => {
    const all = scanCacheRef.allAnalyzed || [];
    if (all.length === 0) {
      send(msg.chat.id, '\uD83D\uDD0D *Scanning...* No gems yet. Wait for next 5-min scan.');
      return;
    }

    // Filter to strong setups with explosion predictions
    const gems = all
      .filter(s => s.gemScore >= 50 && s.consensus && s.consensus !== 'No Trade')
      .sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0))
      .slice(0, 8);

    if (gems.length === 0) {
      send(msg.chat.id, '\uD83D\uDD0D *No explosion setups right now.* Market quiet. I will alert you when something pops.');
      return;
    }

    const lines = ['\uD83D\uDD25 *EXPLOSION GEMS*', ''];

    for (const g of gems) {
      const change = (g.changePct || 0) >= 0 ? `\uD83D\uDFE2+${(g.changePct || 0).toFixed(1)}%` : `\uD83D\uDD34${(g.changePct || 0).toFixed(1)}%`;
      const expl = g.explosion;

      let explStr = '';
      if (expl && expl.expectedGainPct >= 10) {
        const urgIcon = expl.urgency === 'IMMINENT' ? '\u26A1' : expl.urgency === 'SOON' ? '\u23F0' : '\uD83D\uDD04';
        explStr = `\n   ${urgIcon} *+${expl.expectedGainPct}% in ${expl.daysToMove}d* (${expl.probability}%) \u2192 $${expl.targetPrice}`;
      }

      const sigLabels = {
        unusual_volume: 'Vol surge', multi_day_accumulation: 'Accumulation',
        smart_money: 'Smart money', short_squeeze_loading: 'Squeeze',
        bb_squeeze: 'BB squeeze', momentum_acceleration: 'Momentum',
        insider_buying: 'Insider buy', low_float_volume: 'Low float',
        near_52w_high: '52w high', earnings_tomorrow: 'Earnings',
      };
      const sigs = (g.signals || []).slice(0, 3).map(s => sigLabels[s] || s).join(' \u00B7 ');

      lines.push(`*${g.symbol}*  ${$(g.price)}  ${change}`);
      lines.push(`   Score ${g.gemScore} \u00B7 ${g.consensus} \u00B7 ${g.buyCount || 0}/5 agents`);
      if (explStr) lines.push(explStr);
      if (sigs) lines.push(`   \uD83D\uDD0D ${sigs}`);
      if (expl?.factors?.[0]) lines.push(`   \uD83E\uDDE0 ${expl.factors[0]}`);
      lines.push('');
    }

    const t = scanCacheRef.lastScanTime
      ? new Date(scanCacheRef.lastScanTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
      : '?';
    lines.push(`\u23F0 Last scan: ${t} ET`);

    send(msg.chat.id, lines.join('\n'));
  });

  // ────────────────────────────────────────────────
  // /bet — POLYMARKET PICKS
  // ────────────────────────────────────────────────
  bot.onText(/\/bet/, async (msg) => {
    send(msg.chat.id, '\uD83E\uDDE0 *Scanning Polymarket...*');

    try {
      const { getTopMarkets } = await import('./polymarket.js');
      const { findBestBets } = await import('./polyBrain.js');
      const markets = await getTopMarkets(25);

      if (markets.length === 0) {
        send(msg.chat.id, 'No markets available right now.');
        return;
      }

      const picks = await findBestBets(markets);
      const valid = picks.filter(p => !isNaN(p.confidence) && !isNaN(p.edge) && Math.abs(p.edge) >= 3);

      if (valid.length === 0) {
        send(msg.chat.id, '\uD83E\uDDE0 *No edge found.* Market prices look fair right now.');
        return;
      }

      const lines = ['\uD83C\uDFAF *POLYMARKET PICKS*', ''];

      for (const pick of valid.slice(0, 5)) {
        const q = (pick.question || '?').slice(0, 60);
        const side = pick.action === 'BET_YES' ? '\uD83D\uDFE2 YES' : '\uD83D\uDD34 NO';
        const mktPrice = pick.action === 'BET_YES'
          ? Math.round((pick.marketYesPrice || 0.5) * 100) : Math.round((pick.marketNoPrice || 0.5) * 100);
        const aiProb = Math.round((pick.realProbability || 0.5) * 100);

        lines.push(`${side} *${q}*`);
        lines.push(`   Market: ${mktPrice}c \u00B7 AI: ${aiProb}% \u00B7 Edge: ${Math.abs(pick.edge).toFixed(0)}%`);
        lines.push(`   Conf: ${pick.confidence}/10 \u00B7 ${pick.strategy || 'edge'}`);
        if (pick.thesis) lines.push(`   ${pick.thesis.slice(0, 80)}`);
        lines.push('');
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /portfolio_stock — STOCK AUTO-TRADE RESULTS
  // ────────────────────────────────────────────────
  bot.onText(/\/portfolio_stock/, async (msg) => {
    try {
      // Get Alpaca positions
      let posLines = [];
      try {
        const positions = await alpaca.getPositions();
        const account = await alpaca.getAccount();
        if (account) {
          const equity = parseFloat(account.equity || 0);
          const cash = parseFloat(account.cash || 0);
          const pnl = parseFloat(account.portfolio_value || 0) - 100000; // Alpaca paper starts at $100K
          posLines.push(`\uD83D\uDCB0 *Stock Portfolio*`);
          posLines.push(`Equity: ${$(equity)} \u00B7 Cash: ${$(cash)}`);
          posLines.push('');
        }
        if (positions?.length > 0) {
          posLines.push(`*${positions.length} Open Positions:*`);
          for (const pos of positions.slice(0, 10)) {
            const pnl = parseFloat(pos.unrealized_pl || 0);
            const pnlPct = parseFloat(pos.unrealized_plpc || 0) * 100;
            const icon = pnl >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
            posLines.push(`${icon} *${pos.symbol}*  ${$(parseFloat(pos.current_price))}  ${p(pnlPct)}  (${$(pnl)})`);
          }
        } else {
          posLines.push('No open positions.');
        }
      } catch (e) {
        posLines.push('Alpaca not connected.');
      }

      // Trade history
      const log = getAutoTradeLog();
      const recent = (log.trades || []).slice(-10);
      if (recent.length > 0) {
        const wins = recent.filter(t => (t.pnl || 0) > 0).length;
        const total = recent.length;
        posLines.push('');
        posLines.push(`*Recent Trades:* ${wins}/${total} wins (${Math.round(wins / total * 100)}%)`);
        for (const t of recent.slice(-5).reverse()) {
          const icon = (t.pnl || 0) >= 0 ? '\u2705' : '\u274C';
          posLines.push(`${icon} ${t.symbol}  ${$(t.pnl || 0)}  ${t.reason || ''}`);
        }
      }

      send(msg.chat.id, posLines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /portfolio_poly — POLYMARKET PORTFOLIO
  // ────────────────────────────────────────────────
  bot.onText(/\/portfolio_poly/, async (msg) => {
    try {
      const { getPortfolio } = await import('./polySimulator.js');
      const portfolio = getPortfolio();

      const pnlIcon = portfolio.pnl >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
      const goalPct = ((portfolio.totalValue / 400000) * 100).toFixed(2);

      const lines = [
        '\uD83C\uDFB2 *Polymarket Portfolio*',
        '',
        `\uD83D\uDCB0 Balance: *${$(portfolio.balance)}*`,
        `\uD83D\uDCCA Value: *${$(portfolio.totalValue)}*`,
        `${pnlIcon} P&L: *${$(portfolio.pnl)}* (${p(portfolio.pnlPct)})`,
        `\uD83C\uDFAF Goal: ${goalPct}% of $400K`,
        `\uD83D\uDCC8 Win rate: ${portfolio.winRate}% (${portfolio.wins}W / ${portfolio.losses}L)`,
        '',
      ];

      if (portfolio.openPositions?.length > 0) {
        lines.push(`*${portfolio.openPositions.length} Open Bets:*`);
        for (const pos of portfolio.openPositions.slice(0, 8)) {
          const q = (pos.question || '?').slice(0, 50);
          const side = pos.outcome === 'Yes' ? '\uD83D\uDFE2' : '\uD83D\uDD34';
          lines.push(`${side} ${q}`);
          lines.push(`   ${$(pos.amount)} at ${Math.round(pos.entryPrice * 100)}c \u00B7 Conf ${pos.claudeConfidence}/10`);
        }
      } else {
        lines.push('No open bets. Auto-betting runs every 15 min.');
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /clear — DELETE ENTIRE CHAT
  // ────────────────────────────────────────────────
  bot.onText(/\/clear/, async (msg) => {
    const cid = msg.chat.id;
    try {
      // Delete as many recent messages as possible (Telegram allows deleting messages < 48h old)
      const msgId = msg.message_id;
      let deleted = 0;
      for (let i = msgId; i > Math.max(1, msgId - 200); i--) {
        try {
          await bot.deleteMessage(cid, i);
          deleted++;
        } catch { /* message already deleted or too old */ }
      }
      // Send fresh welcome
      await bot.sendMessage(cid, [
        '\uD83D\uDD2E *Stock Oracle* \u2014 Ready',
        '',
        '\uD83D\uDD25 /scan \u00B7 \uD83C\uDFAF /bet',
        '\uD83D\uDCB0 /portfolio\\_stock \u00B7 \uD83C\uDFB2 /portfolio\\_poly',
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      send(cid, '\u2705 Chat cleared. Use the menu for commands.');
    }
  });
}

// ════════════════════════════════════════════════════════
// NOTIFICATIONS (sent automatically by cron/auto-trader)
// ════════════════════════════════════════════════════════

export async function notifyNewTrade(trade) {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, [
      `\uD83D\uDE80 *BOUGHT ${trade.symbol}*`,
      '',
      `\uD83D\uDCB0 ${$(trade.price)}  \u00D7  ${$(trade.amount)}`,
      `\uD83C\uDFAF +${trade.targetPct || 10}%  \uD83D\uDED1 -${trade.stopPct || 5}%`,
    ].join('\n'), { parse_mode: 'Markdown' });
  } catch (err) { console.error('[Telegram]', err.message); }
}

export async function notifyTradeExit(trade) {
  if (!bot || !chatId) return;
  const won = (trade.pnl || 0) >= 0;
  const pnlPct = trade.price ? (((trade.exitPrice || 0) - trade.price) / trade.price * 100) : 0;

  try {
    await bot.sendMessage(chatId, [
      `${won ? '\u2705' : '\u274C'} *SOLD ${trade.symbol}*`,
      `${$(trade.price)} \u2192 ${$(trade.exitPrice)}  *${$(trade.pnl)}* (${p(pnlPct)})`,
    ].join('\n'), { parse_mode: 'Markdown' });
  } catch (err) { console.error('[Telegram]', err.message); }
}

export async function notifyError(message) {
  if (!bot || !chatId) return;
  try { await bot.sendMessage(chatId, `\u26A0\uFE0F ${message}`); } catch {}
}

export async function sendTestMessage() {
  if (!bot || !chatId) return { success: false, error: 'Not connected' };
  try {
    await bot.sendMessage(chatId, '\u2705 *Stock Oracle* online', { parse_mode: 'Markdown' });
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
}

// ════════════════════════════════════════════════════════
// PROACTIVE BUY ALERTS (sent automatically every 5 min)
// ════════════════════════════════════════════════════════

const sigLabels = {
  unusual_volume: 'Vol surge', multi_day_accumulation: 'Accumulation',
  smart_money: 'Smart money', short_squeeze_loading: 'Squeeze',
  bb_squeeze: 'BB squeeze', momentum_acceleration: 'Momentum',
  insider_buying: 'Insider buy', low_float_volume: 'Low float',
  near_52w_high: '52w high', earnings_tomorrow: 'Earnings',
  institutions_accumulating: 'Institutions', bullish_options: 'Options flow',
};

export async function notifyBuyAlerts(stocks) {
  if (!bot || !chatId) return;
  if (!stocks?.length) return;

  const now = Date.now();

  // Clean stale
  for (const [sym, entry] of alertedStocks) {
    if (now - entry.ts > ALERT_COOLDOWN_MS) alertedStocks.delete(sym);
  }

  // Filter to alertable stocks
  const toAlert = stocks.filter(s => {
    if (!s.symbol || !s.price) return false;
    if (!s.consensus || s.consensus === 'No Trade' || s.consensus === 'Speculative') return false;
    if ((s.gemScore || 0) < 55) return false;
    if ((s.buyCount || 0) < 2) return false;
    const prev = alertedStocks.get(s.symbol);
    if (!prev) return true;
    if ((s.gemScore || 0) >= (prev.gemScore || 0) + ALERT_SCORE_JUMP) return true;
    return false;
  });

  if (toAlert.length === 0) return;
  toAlert.sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0));

  for (const s of toAlert.slice(0, 5)) {
    try {
      const isStrong = s.consensus === 'Strong Buy';
      const header = isStrong ? '\uD83D\uDCA5 *BUY NOW*' : '\uD83D\uDD25 *BUY ALERT*';
      const change = (s.changePct || 0) >= 0
        ? `\uD83D\uDFE2+${(s.changePct || 0).toFixed(1)}%`
        : `\uD83D\uDD34${(s.changePct || 0).toFixed(1)}%`;

      const expl = s.explosion;
      let explLine = '';
      if (expl?.expectedGainPct >= 10) {
        const urgIcon = expl.urgency === 'IMMINENT' ? '\u26A1' : expl.urgency === 'SOON' ? '\u23F0' : '\uD83D\uDD04';
        explLine = `${urgIcon} *+${expl.expectedGainPct}% in ${expl.daysToMove}d* (${expl.probability}%) \u2192 $${expl.targetPrice}`;
      }

      const sigs = (s.signals || []).slice(0, 3).map(sig => sigLabels[sig] || sig).join(' \u00B7 ');

      const buyVerdicts = (s.verdicts || []).filter(v => v.action === 'BUY');
      const avgTarget = buyVerdicts.length > 0
        ? buyVerdicts.reduce((sum, v) => sum + (parseFloat(v.targetGain) || 10), 0) / buyVerdicts.length : 10;

      const lines = [
        header,
        '',
        `*${s.symbol}*  ${$(s.price)}  ${change}`,
        explLine,
        `\uD83C\uDFAF +${avgTarget.toFixed(0)}%  \u00B7  Score ${s.gemScore}  \u00B7  ${s.buyCount}/5 agents`,
        sigs ? `\uD83D\uDD0D ${sigs}` : '',
        expl?.factors?.[0] ? `\uD83E\uDDE0 ${expl.factors[0]}` : '',
      ].filter(Boolean);

      const msg = lines.join('\n');
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(chatId, msg.replace(/\*/g, ''), { disable_web_page_preview: true }).catch(() => {})
      );

      alertedStocks.set(s.symbol, { ts: now, gemScore: s.gemScore || 0 });
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error('[Telegram] Alert error:', err.message);
    }
  }
}

export function stopBot() { if (bot) { bot.stopPolling(); bot = null; } }
