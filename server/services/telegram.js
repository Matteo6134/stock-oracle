/**
 * Stock Oracle — Telegram Bot
 * 5 commands only. Clean. Simple. No noise.
 *
 * /scan            — explosion gems (what to buy)
 * /portfolio       — stock auto-trade stats
 * /clear           — wipe entire chat
 * /status          — system health & market overview
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as alpaca from './alpaca.js';
import { getAutoTradeLog } from './autoTrader.js';
import { getEarlyWarnings, getNewAlerts } from './earlyWarning.js';
import { getFundamentalsSnapshot } from './yahooFinance.js';
import { getAnalog } from './analogStats.js';
import { scanPremarketMovers, getShortSqueezeSetups, getBreakoutSetups, STOCK_UNIVERSE } from './premarketScanner.js';
import { getDynamicSymbols, getDynamicDiscoveryStats } from './dynamicDiscovery.js';
import { runDailyPicker } from './dailyPicker.js';
import { researchTicker } from './tickerResearch.js';
import { getExplosionStats, getPredictionStats } from './db.js';
import { getAttribution } from './attributionWeights.js';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'telegramConfig.json');

let bot = null;
// Multi-user: Set of chat IDs that subscribed via /start
const subscribers = new Set();
let scanCacheRef = { gems: [], pennies: [], allAnalyzed: [], movers: [], lastScanTime: null };
let onDemandScanFn = null;

function addSubscriber(id) {
  if (!id) return;
  const wasNew = !subscribers.has(id);
  subscribers.add(id);
  if (wasNew) {
    saveConfig({ subscribers: [...subscribers] });
    console.log(`[Telegram] New subscriber: ${id} (total: ${subscribers.size})`);
  }
}

function removeSubscriber(id) {
  if (!id) return;
  const existed = subscribers.delete(id);
  if (existed) {
    saveConfig({ subscribers: [...subscribers] });
    console.log(`[Telegram] Subscriber removed: ${id} (total: ${subscribers.size})`);
  }
}

// Broadcast a message to every subscriber. Auto-removes users who blocked the bot.
async function broadcast(text, opts = {}) {
  if (!bot || subscribers.size === 0) return 0;
  let sent = 0;
  const payload = { parse_mode: 'Markdown', disable_web_page_preview: true, ...opts };
  for (const id of [...subscribers]) {
    try {
      await bot.sendMessage(id, text, payload);
      sent++;
    } catch (err) {
      const errCode = err?.response?.body?.error_code;
      const errDesc = (err?.response?.body?.description || '').toLowerCase();
      // Only remove subscriber if they blocked the bot or chat truly doesn't exist
      // Do NOT remove on generic 400 errors (bad markdown, message too long, etc.)
      if (errCode === 403 || (errCode === 400 && (errDesc.includes('chat not found') || errDesc.includes('bot was blocked')))) {
        removeSubscriber(id);
      } else {
        // Fallback: strip markdown on formatting errors
        try {
          const plain = text.replace(/\*/g, '').replace(/_/g, '');
          await bot.sendMessage(id, plain, { disable_web_page_preview: true });
          sent++;
        } catch { /* give up on this user for this msg */ }
      }
    }
    // small gap to avoid rate limits (Telegram allows ~30 msgs/sec globally)
    await new Promise(r => setTimeout(r, 40));
  }
  return sent;
}

// Alert dedup
const alertedStocks = new Map();
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const ALERT_SCORE_JUMP = 20;

export function setScanCache(cache) { scanCacheRef = cache; }
export function setOnDemandScan(fn) { onDemandScanFn = fn; }

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
function tickerLink(sym) {
  return `[${sym}](https://finance.yahoo.com/quote/${sym})`;
}

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

    // Load subscribers from config + env (supports both legacy chatId and new subscribers array)
    const cfg = loadConfig();
    if (Array.isArray(cfg.subscribers)) {
      for (const id of cfg.subscribers) subscribers.add(parseInt(id, 10));
    }
    if (cfg.chatId) subscribers.add(parseInt(cfg.chatId, 10)); // legacy migration
    if (process.env.TELEGRAM_CHAT_ID) {
      subscribers.add(parseInt(process.env.TELEGRAM_CHAT_ID, 10));
    }
    // Persist any migrated values so we don't lose them
    if (subscribers.size > 0) saveConfig({ subscribers: [...subscribers] });
    console.log(`[Telegram] Bot online (${subscribers.size} subscriber${subscribers.size === 1 ? '' : 's'})${subscribers.size === 0 ? ' — send /start to subscribe' : ''}`);

    // Set menu — intentionally minimal: the bot pushes predictions on its own;
    // the menu only needs the two read commands (legacy commands still work
    // if typed, they're just not advertised).
    bot.setMyCommands([
      { command: 'recap',     description: '🔮 All current predictions in one message' },
      { command: 'portfolio', description: '💼 Open positions & P/L' },
      { command: 'stop',      description: '🛑 Unsubscribe' },
    ]).catch(() => {});

    registerCommands();
    return bot;
  } catch (err) { console.error('[Telegram]', err.message); return null; }
}

export function isConnected() { return !!(bot && subscribers.size > 0); }
export function getBotInfo() {
  return {
    connected: isConnected(),
    subscriberCount: subscribers.size,
    subscribers: [...subscribers],
    hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
  };
}

// ════════════════════════════════════════════════════════
// COMMANDS
// ════════════════════════════════════════════════════════

function registerCommands() {

  // /start — subscribe + welcome
  bot.onText(/\/start/, (msg) => {
    const cid = msg.chat.id;
    addSubscriber(cid);
    send(cid, [
      '\uD83D\uDD2E *Stock Oracle v3*',
      '',
      'I scan the market every 5 minutes. When I predict a stock is about to jump, I message you automatically with the target price, the timeframe, and the reasons behind it.',
      '',
      '\uD83D\uDD2E /recap \u2014 all current predictions in one message',
      '\uD83D\uDCBC /portfolio \u2014 open positions & P/L',
      '',
      '_Send /stop to unsubscribe._',
    ].join('\n'));
  });

  // ────────────────────────────────────────────────
  // /recap — every current prediction in one message
  // ────────────────────────────────────────────────
  bot.onText(/\/recap/, async (msg) => {
    const cid = msg.chat.id;
    const all = scanCacheRef.allAnalyzed || [];
    const picks = all
      .filter(s => s.consensus === 'Buy' || s.consensus === 'Strong Buy')
      .sort((a, b) =>
        (b.claude?.confidence || 0) - (a.claude?.confidence || 0) ||
        (b.gemScore || 0) - (a.gemScore || 0))
      .slice(0, 6);

    if (picks.length === 0) {
      send(cid, '🔮 *Recap*\n\nNo active predictions right now — nothing passes the quality gates at the moment. I scan every 5 minutes during market hours and will alert you when something does.');
      return;
    }

    const blocks = picks.map(s => {
      const e = s.explosion || {};
      const gainPct = Math.round(s.claude?.targetPct || Math.min(e.expectedGainPct || 10, 20));
      const target = s.price ? Math.round(s.price * (1 + gainPct / 100) * 100) / 100 : '?';
      const why = (s.signals || []).slice(0, 4).map(x => sigLabels[x] || x.replace(/_/g, ' ')).join(', ');
      const conf = s.claude ? ` · AI ${s.claude.confidence}/10` : '';
      const tag = s.consensus === 'Strong Buy' ? '🟢' : '🟡';
      return `${tag} *${s.symbol}* $${s.price} → $${target} (+${gainPct}%) in ~${e.daysToMove || 5}d${conf}\n_${why}_`;
    });

    const ts = scanCacheRef.lastScanTime
      ? new Date(scanCacheRef.lastScanTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
      : 'n/a';
    send(cid, [`🔮 *Predictions recap* _(scan ${ts})_`, '', blocks.join('\n\n')].join('\n'));
  });

  // ────────────────────────────────────────────────
  // /stop — unsubscribe from alerts
  // ────────────────────────────────────────────────
  bot.onText(/\/stop/, (msg) => {
    const cid = msg.chat.id;
    removeSubscriber(cid);
    send(cid, '\uD83D\uDD15 Unsubscribed. Send /start to resubscribe anytime.');
  });

  // ────────────────────────────────────────────────
  // /scan — EXPLOSION GEMS (the core feature)
  // ────────────────────────────────────────────────
  bot.onText(/\/scan/, async (msg) => {
    const cid = msg.chat.id;

    // Check if cache is empty or stale (>5 min old)
    const cacheAge = scanCacheRef.lastScanTime
      ? Date.now() - new Date(scanCacheRef.lastScanTime).getTime()
      : Infinity;
    const isStale = cacheAge > 5 * 60 * 1000;
    const isEmpty = (scanCacheRef.allAnalyzed || []).length === 0;

    if ((isEmpty || isStale) && onDemandScanFn) {
      send(cid, '\uD83D\uDD0D *Scanning now...* Running fresh analysis, give me ~30s.');
      try {
        await onDemandScanFn();
      } catch (err) {
        console.error('[Telegram] On-demand scan error:', err.message);
      }
    }

    const all = scanCacheRef.allAnalyzed || [];
    if (all.length === 0) {
      send(cid, '\uD83D\uDD0D *No data yet.* Scan is running, try again in ~30s.');
      return;
    }

    // Filter to strong setups with explosion predictions
    const gems = all
      .filter(s => s.gemScore >= 50 && s.consensus && s.consensus !== 'No Trade')
      .sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0))
      .slice(0, 10);

    if (gems.length === 0) {
      send(cid, '\uD83D\uDD0D *No explosion setups right now.* Market quiet. I will alert you when something pops.');
      return;
    }

    const lines = ['\uD83D\uDD25 *EXPLOSION GEMS*', ''];

    // Group gems by consensus
    const groups = {
      'Strong Buy': [],
      'Buy': [],
      'Speculative Buy': [],
      'Cautious Buy': [],
      'Other': []
    };

    for (const g of gems) {
      if (groups[g.consensus]) {
        groups[g.consensus].push(g);
      } else {
        const key = g.consensus.includes('Strong Buy') ? 'Strong Buy' :
                    g.consensus.includes('Speculative') ? 'Speculative Buy' :
                    g.consensus.includes('Cautious') ? 'Cautious Buy' :
                    g.consensus.includes('Buy') ? 'Buy' : 'Other';
        if (!groups[key]) groups[key] = [];
        groups[key].push(g);
      }
    }

    // Render each group
    const order = ['Strong Buy', 'Buy', 'Speculative Buy', 'Cautious Buy', 'Other'];
    for (const category of order) {
      if (!groups[category] || groups[category].length === 0) continue;

      lines.push(`\u2500\u2500\u2500 *${category.toUpperCase()}* \u2500\u2500\u2500`);
      
      for (const g of groups[category]) {
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

        const fire = g.gemScore >= 90 ? ' \uD83D\uDD25' : '';
        lines.push(`*${g.symbol}*  ${$(g.price)}  ${change}`);
        lines.push(`   Score ${g.gemScore}${fire} \u00B7 ${g.buyCount || 0}/5 agents`);
        if (explStr) lines.push(explStr);
        if (sigs) lines.push(`   \uD83D\uDD0D ${sigs}`);
        if (expl?.factors?.[0]) lines.push(`   \uD83E\uDDE0 ${expl.factors[0]}`);
        lines.push('');
      }
    }

    const t = scanCacheRef.lastScanTime
      ? new Date(scanCacheRef.lastScanTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
      : '?';
    const freshLabel = !isStale ? '' : ' \u2728';
    lines.push(`\u23F0 Last scan: ${t} ET${freshLabel}`);

    send(cid, lines.join('\n'));
  });

  // ────────────────────────────────────────────────
  // /warn — EARLY WARNINGS (Revolut stocks only)
  // ────────────────────────────────────────────────
  bot.onText(/\/warn/, (msg) => {
    try {
      const warnings = getEarlyWarnings({ revolutOnly: true, minScore: 40 });

      if (warnings.length === 0) {
        send(msg.chat.id, '\u26A0\uFE0F *No early warnings yet.*\nNo Revolut stocks building up. I scan every 5 min and will alert you when something starts loading.');
        return;
      }

      const lines = ['\u26A0\uFE0F *EARLY WARNINGS* (Revolut)', ''];

      const groups = { IMMINENT: [], LOADING: [], BUILDING: [], COOLING: [] };
      // Sort so highest score in each tier is at top
      const sortedWarnings = warnings.sort((a,b) => b.currentScore - a.currentScore).slice(0, 15);
      
      for (const w of sortedWarnings) {
        if (groups[w.stage]) groups[w.stage].push(w);
      }

      const stageIcons = { IMMINENT: '\uD83D\uDD34', LOADING: '\uD83D\uDFE0', BUILDING: '\uD83D\uDFE1', COOLING: '\u26AA' };
      const order = ['IMMINENT', 'LOADING', 'BUILDING', 'COOLING'];

      for (const stage of order) {
        if (groups[stage].length === 0) continue;

        lines.push(`\u2500\u2500\u2500 *${stageIcons[stage]} ${stage}* \u2500\u2500\u2500`);

        for (const w of groups[stage]) {
          const trajectory = w.scoreTrajectory === 'rising' ? '\u2B06\uFE0F' :
                             w.scoreTrajectory === 'falling' ? '\u2B07\uFE0F' : '\u27A1\uFE0F';

          lines.push(`*${w.symbol}* ${$(w.currentPrice)}`);
          lines.push(`   Score ${w.currentScore} ${trajectory} \u00B7 Day ${w.consecutiveDays} \u00B7 ${w.consensus || 'Scanning'}`);

          if (w.estimatedMove?.expectedGain >= 10) {
            lines.push(`   \uD83C\uDFAF *+${w.estimatedMove.expectedGain}% in ${w.estimatedMove.daysToMove}d* (${w.estimatedMove.probability}%)`);
          }

          const sigSummary = (w.currentSignals || []).slice(0, 3).map(s => {
            const labels = {
              multi_day_accumulation: 'Accumulation', stealth_accumulation: 'Stealth',
              volume_acceleration: 'Vol ramp', smart_money: 'Smart $',
              bb_squeeze: 'BB squeeze', short_squeeze_loading: 'Squeeze loading',
              insider_buying: 'Insider', price_compression: 'Coiled spring',
            };
            return labels[s] || s;
          }).join(' \u00B7 ');
          if (sigSummary) lines.push(`   \uD83D\uDD0D ${sigSummary}`);
          lines.push('');
        }
      }

      lines.push('_Stocks tracked across multiple days._');
      lines.push('_IMMINENT = expect move in 1-3 days_');

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /portfolio — UNIFIED PORTFOLIO (stocks)
  // ────────────────────────────────────────────────
  bot.onText(/\/portfolio/, async (msg) => {
    try {
      const lines = [];

      // ── Stocks ──
      lines.push('\uD83D\uDCBC *PORTFOLIO*', '');
      try {
        const [positions, account, openOrders] = await Promise.all([
          alpaca.getPositions(),
          alpaca.getAccount(),
          alpaca.getOrders('open')
        ]);

        if (account) {
          const equity = parseFloat(account.equity || 0);
          const cash = parseFloat(account.cash || 0);
          lines.push(`\uD83D\uDCB0 Equity *${$(equity)}* \u00B7 Cash *${$(cash)}*`);
        }

        if (account) {
          const _dpl = Number(account.dayPL || 0), _dplp = Number(account.dayPLPct || 0);
          lines.push(`Day P&L ${_dpl >= 0 ? '+' : ''}$${_dpl.toFixed(2)} (${p(_dplp)}) - Buying Power ${$(account.buyingPower)}`);
        }

        if (openOrders && openOrders.length > 0) {
          lines.push('');
          lines.push(`\u23F3 *Open Orders (${openOrders.length}):*`);
          for (const ord of openOrders.slice(0, 5)) {
            const size = ord.qty ? `${ord.qty} sh` : `$${ord.notional}`;
            const price = ord.limitPrice ? ` @ $${ord.limitPrice}` : '';
            lines.push(`   \u2022 ${ord.side.toUpperCase()} ${ord.symbol} \u00B7 ${size} ${ord.type.toUpperCase()}${price}`);
          }
        }

        if (positions?.length > 0) {
          lines.push('');
          lines.push(`\uD83D\uDCC8 *Positions (${positions.length}):*`);
          const _tlog = getAutoTradeLog();
          const _stopBySym = {};
          for (const _o of (openOrders || [])) { if (_o.type === 'stop' && _o.stopPrice) _stopBySym[_o.symbol] = _o.stopPrice; }
          for (const pos of positions) {
            const _e = _tlog.find(t => t.symbol === pos.symbol && t.side === 'buy' && t.exitPrice == null);
            const pnl = pos.unrealizedPL || 0;
            const pnlPct = pos.unrealizedPLPct || 0;
            const icon = pnl >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
            const _t = _e?.targetPct, _pk = _e?.maxGainSeen;
            let _st;
            if (pos.side === 'short') _st = 'SHORT';
            else if (pnlPct < 0) _st = 'HOLD';
            else if (_t != null && pnlPct >= _t) _st = 'TAKING-PROFIT';
            else if (_pk != null && _pk >= 10 && pnlPct < _pk - 3) _st = 'MOON-TRAIL';
            else if (_pk != null && _pk >= 7 && pnlPct < _pk - 2) _st = 'PROFIT-LOCK';
            else _st = 'HOLDING';
            const _qty = Number.isInteger(Number(pos.qty)) ? pos.qty : Number(pos.qty).toFixed(2);
            let _ln = `${icon} ${_st} *${pos.symbol}*  ${_qty} sh @ ${$(pos.avgEntryPrice)} -> ${$(pos.currentPrice)}  ${p(pnlPct)} (${$(pnl)})  MV ${$(pos.marketValue)}`;
            const _sp = _stopBySym[pos.symbol];
            if (_sp) _ln += `  stop ${$(_sp)}`;
            if (_e?.gemScore) _ln += `  gem ${Math.round(_e.gemScore)}`;
            lines.push(_ln);
          }
          lines.push('');
          lines.push('_Bot is LONG-ONLY - never sells at a loss. Red = HOLD (waiting for recovery); broker stop guards against crashes. No SHORT positions._');
        } else {
          lines.push('');
          lines.push('_No open stock positions._');
        }
      } catch (err) {
        lines.push('_Alpaca not connected_');
      }

      // ── Recent trades ──
      const log = getAutoTradeLog();
      const closedTrades = log.filter(t => t.exitPrice != null);
      const recent = closedTrades.slice(0, 5);
      if (recent.length > 0) {
        const wins = closedTrades.filter(t => (t.pnl || 0) > 0).length;
        const total = closedTrades.length;
        lines.push('');
        lines.push(`*Closed trades:* ${wins}W/${total - wins}L (${Math.round(wins / total * 100)}%)`);
        for (const t of recent) {
          const icon = (t.pnl || 0) >= 0 ? '\u2705' : '\u274C';
          lines.push(`${icon} ${t.symbol}  ${$(t.pnl || 0)}`);
        }
      }

      // Split into chunks (Telegram caps a single message at 4096 chars)
      const chunks = [];
      let _buf = [], _len = 0;
      for (const _l of lines) {
        if (_len + _l.length + 1 > 3800 && _buf.length) { chunks.push(_buf.join('\n')); _buf = []; _len = 0; }
        _buf.push(_l); _len += _l.length + 1;
      }
      if (_buf.length) chunks.push(_buf.join('\n'));
      // Send sequentially with a small gap so chunks arrive in order (send() is fire-and-forget)
      for (let i = 0; i < chunks.length; i++) {
        send(msg.chat.id, chunks[i]);
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 250));
      }
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /edge — is the bot's signal edge real? (backtest attribution)
  // ────────────────────────────────────────────────
  bot.onText(/\/edge/, async (msg) => {
    try {
      const esc = (s) => String(s).replace(/([_*\[\]`])/g, '\\$1');
      const sign = (n) => `${(n || 0) >= 0 ? '+' : ''}${(n || 0).toFixed(1)}%`;
      const lines = ['📊 *EDGE — does the bot actually work?*', ''];

      const attr = getAttribution();
      if (attr?.overall) {
        const o = attr.overall;
        lines.push(`_From ${attr.n_resolved} resolved predictions (Supabase):_`);
        lines.push(`Hit ${Math.round((o.hit_rate_50pct_target || 0) * 100)}% · Win ${Math.round((o.win_rate_strict || 0) * 100)}% · Avg ${sign(o.avg_return_pct)} · PF ${(o.profit_factor ?? 0).toFixed(2)}`);

        const sigs = (attr.per_signal || []).filter(s => s.count >= 5);
        const fmtSig = (s) => `  ${esc(s.signal)} — ${Math.round(s.hit_rate * 100)}% hit · ${sign(s.avg_return_pct)} · n${s.count}`;
        const best = [...sigs].sort((a, b) => b.hit_rate - a.hit_rate).slice(0, 5);
        const worst = [...sigs].sort((a, b) => a.hit_rate - b.hit_rate).slice(0, 5);
        if (best.length) { lines.push('', '✅ *Best signals:*'); best.forEach(s => lines.push(fmtSig(s))); }
        if (worst.length) { lines.push('', '❌ *Worst signals:*'); worst.forEach(s => lines.push(fmtSig(s))); }

        const combos = (attr.top_combos || []).filter(c => c.count >= 5 && Array.isArray(c.pair)).slice(0, 5);
        if (combos.length) {
          lines.push('', '🔥 *Killer combos:*');
          combos.forEach(c => lines.push(`  ${esc(c.pair[0])} + ${esc(c.pair[1])} — ${Math.round(c.hit_rate * 100)}% · n${c.count}`));
        }

        const b = attr.by_gem_score_bucket || {};
        const order = ['50-59', '60-69', '70-79', '80+'];
        const buckets = order.filter(k => b[k]?.n);
        if (buckets.length) {
          lines.push('', '📈 *Gem score → actual return:*');
          buckets.forEach(k => lines.push(`  ${k}: ${sign(b[k].avg_return_pct)} (${Math.round((b[k].positive_rate || 0) * 100)}% win, n${b[k].n})`));
        }
      } else {
        lines.push('_No attribution data yet. It refreshes automatically on Sundays 3 AM ET._');
      }

      // Reality check: price-only replay vs random monkey
      try {
        const replayPath = path.join(__dirname, '..', '..', 'python', 'backtest', 'replay_results', 'replay_report.json');
        if (fs.existsSync(replayPath)) {
          const rep = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
          const strat = rep.strategies || {};
          if (Object.keys(strat).length) {
            lines.push('', '🐒 *Price-only replay vs monkey:*');
            for (const [name, s] of Object.entries(strat)) {
              lines.push(`  ${esc(name)}: ${Math.round(s.total_return_pct)}% · ${s.monkey_percentile}th pct`);
            }
            const spy = rep.spy_benchmark?.total_return_pct;
            if (spy != null) lines.push(`  SPY buy&hold: +${Math.round(spy)}%`);
            lines.push('_The bot trades signals, not raw price — price-only strategies lose here._');
          }
        }
      } catch { /* skip replay section */ }

      // Supabase: explosion model + AI call accuracy
      try {
        const [ex, pr] = await Promise.all([getExplosionStats(), getPredictionStats()]);
        if (ex?.totalSettled || pr?.totalSettled) lines.push('');
        if (ex?.totalSettled) lines.push(`🔮 Explosion model: ${ex.winRate}% win (${ex.totalSettled} settled · ${ex.bigWinRate}% big wins)`);
        if (pr?.totalSettled) lines.push(`🧠 AI calls: ${pr.winRate}% win (${pr.totalSettled}) · avg ${sign(pr.avgReturn)}`);
      } catch { /* skip */ }

      lines.push('', '_Refreshes Sundays 3 AM ET. /stats for daily-pick P&L._');
      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /trades — EXECUTED AUTO-TRADES (only actual buys on Alpaca)
  // ────────────────────────────────────────────────
  bot.onText(/\/trades/, async (msg) => {
    try {
      const log = getAutoTradeLog();
      if (log.length === 0) {
        send(msg.chat.id, '\uD83D\uDCB9 *AUTO-TRADES*\n\n_No trades executed yet._');
        return;
      }

      const lines = ['\uD83D\uDCB9 *AUTO-TRADES*', ''];

      // Stats
      const closed = log.filter(t => t.exitPrice != null);
      const open = log.filter(t => t.exitPrice == null);
      const wins = closed.filter(t => (t.pnl || 0) > 0).length;
      const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

      if (closed.length > 0) {
        lines.push(`\uD83C\uDFAF *Win rate:* ${wins}/${closed.length} (${Math.round(wins / closed.length * 100)}%)`);
        lines.push(`\uD83D\uDCB0 *Total P/L:* ${$(totalPnl)}`);
        lines.push('');
      }

      // Open positions (bought, not yet exited)
      if (open.length > 0) {
        lines.push(`\uD83D\uDFE2 *Open (${open.length}):*`);
        for (const t of open) {
          const date = new Date(t.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          lines.push(`   *${t.symbol}* \u2014 ${$(t.amount)} @ ${$(t.price)} \u00B7 ${date}`);
          lines.push(`   ${t.consensus} \u00B7 Score ${t.gemScore} \u00B7 SL -${t.stopPct}% \u00B7 TP +${t.targetPct}%`);
        }
        lines.push('');
      }

      // Closed trades (most recent first, limit 10)
      if (closed.length > 0) {
        lines.push(`\u2705 *Closed (${closed.length}):*`);
        for (const t of closed.slice(0, 10)) {
          const won = (t.pnl || 0) >= 0;
          const icon = won ? '\uD83D\uDFE2' : '\uD83D\uDD34';
          const date = new Date(t.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          const reason = t.exitReason ? ` \u2014 ${t.exitReason.split('(')[0].trim()}` : '';
          lines.push(`   ${icon} *${t.symbol}*  ${$(t.pnl || 0)}${reason}`);
          lines.push(`      In ${$(t.price)} \u2192 Out ${$(t.exitPrice)} \u00B7 ${date}`);
        }
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /status — SYSTEM HEALTH & MARKET OVERVIEW
  // ────────────────────────────────────────────────
  bot.onText(/\/status/, (msg) => {
    try {
      const gems = scanCacheRef.gems || [];
      const stats = scanCacheRef.scanStats;
      const warnings = getEarlyWarnings({ revolutOnly: true, minScore: 40 });
      const imminent = warnings.filter(w => w.stage === 'IMMINENT').length;
      
      const now = new Date();
      const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const marketOpen = et.getDay() >= 1 && et.getDay() <= 5 && (et.getHours() >= 9 && et.getMinutes() >= 30) && et.getHours() < 16;
      let marketStatus = marketOpen ? '\uD83D\uDFE2 Open' : '\uD83D\uDD34 Closed';

      const lines = [
        '\uD83D\uDCCA *SYSTEM STATUS*',
        `${marketStatus} \u00B7 ${et.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
        '',
        '\u2500\u2500\u2500 *Top Gems* \u2500\u2500\u2500',
      ];

      if (gems.length > 0) {
        gems.slice(0, 3).forEach((g, i) => {
          const medal = i === 0 ? '\uD83E\uDD47' : i === 1 ? '\uD83E\uDD48' : '\uD83E\uDD49';
          const high = (g.gemScore || g.score) >= 90 ? ' \uD83D\uDD25' : '';
          lines.push(`${medal} *${g.symbol}* \u2014 Score: ${g.gemScore || g.score}${high}`);
          lines.push(`   ${g.consensus || 'Analyzing...'}`);
        });
      } else {
        lines.push('_No gems in cache. Run /scan to refresh._');
      }

      lines.push('');
      lines.push('\u2500\u2500\u2500 *Scanner Stats* \u2500\u2500\u2500');
      if (stats) {
        lines.push(`\uD83D\uDD0D ${stats.totalScanned} Scanned \u00B7 \uD83D\uDCA5 ${stats.setupsFound} Setups`);
        lines.push(`\uD83D\uDC8E ${stats.gemsFound} Gems \u00B7 \uD83D\uDCAA ${stats.highConviction || 0} High Conviction`);
      } else {
        lines.push(`\uD83D\uDCC8 ${gems.length} gems currently tracked`);
      }

      lines.push('');
      lines.push('\u2500\u2500\u2500 *Early Warnings* \u2500\u2500\u2500');
      lines.push(`\u26A0\uFE0F ${imminent} IMMINENT \u00B7 ${warnings.length} tracked`);
      
      const topWarn = warnings.find(w => w.stage === 'IMMINENT');
      if (topWarn) lines.push(`\u26A1 *Top:* ${topWarn.symbol} (Score ${topWarn.currentScore})`);

      lines.push('');
      const uptime = Math.round(process.uptime() / 3600);
      const mem = process.memoryUsage();
      const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      lines.push(`\u2699\uFE0F Uptime: ${uptime}h \u00B7 RAM: ${heapMB}MB \u00B7 @StockOracleBot`);

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Status Error: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /mega — MASSIVE ON-DEMAND SCAN (all scanners)
  // ────────────────────────────────────────────────
  bot.onText(/\/mega/, async (msg) => {
    const cid = msg.chat.id;
    send(cid, '\uD83D\uDEF0 *MEGA SCAN running...* premarket + squeeze + breakout + gems + discovery — ~10s.');
    try {
      const t0 = Date.now();
      const [movers, dynSyms] = await Promise.all([
        scanPremarketMovers().catch(() => []),
        getDynamicSymbols({ force: true }).catch(() => []),
      ]);
      const moverSyms = movers.map(m => m.symbol).filter(Boolean);
      const squeezeUniverse = [...new Set([
        ...moverSyms,
        ...dynSyms,
        ...STOCK_UNIVERSE.SMALL_MID_CAPS,
        ...STOCK_UNIVERSE.MEME_VOLATILE,
        ...STOCK_UNIVERSE.REVOLUT_POPULAR,
      ])];
      const breakoutUniverse = [...new Set([
        ...moverSyms.slice(0, 20),
        ...dynSyms.slice(0, 30),
        'AAPL','MSFT','NVDA','TSLA','AMD','META','AMZN','GOOGL','PLTR','SOFI','COIN','NET','CRWD','SNOW','LCID','RIVN',
      ])];
      const [squeezes, breakouts] = await Promise.all([
        getShortSqueezeSetups(squeezeUniverse).catch(() => []),
        getBreakoutSetups(breakoutUniverse).catch(() => []),
      ]);
      if (onDemandScanFn) { try { await onDemandScanFn(); } catch { /* best effort */ } }
      const gems = (scanCacheRef.allAnalyzed || [])
        .filter(s => (s.gemScore || 0) >= 50 && s.consensus && s.consensus !== 'No Trade')
        .sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0))
        .slice(0, 5);
      const discoStats = getDynamicDiscoveryStats();
      const tookS = ((Date.now() - t0) / 1000).toFixed(1);

      const lines = [`\uD83D\uDEF0 *MEGA SCAN* \u2014 ${tookS}s`, ''];

      lines.push('\u2500\u2500\u2500 *SHORT SQUEEZE (top 5)* \u2500\u2500\u2500');
      if (squeezes.length) {
        squeezes.slice(0, 5).forEach(s => {
          const si = s.shortPercentOfFloat != null ? `${s.shortPercentOfFloat.toFixed(1)}%` : '?';
          const dtc = s.shortRatio != null ? s.shortRatio.toFixed(1) : '?';
          const prob = s.probability != null ? `${s.probability}%` : '?';
          const tgt = s.targets?.moderate != null ? ` \u2192 ${$(s.targets.moderate)} (+${s.targets.moderateGain}%)` : '';
          lines.push(`${tickerLink(s.symbol)} ${$(s.price)}  SI:${si}  DTC:${dtc}  p:${prob}${tgt}`);
        });
      } else lines.push('_none_');
      lines.push('');

      lines.push('\u2500\u2500\u2500 *BREAKOUT COILED (top 5)* \u2500\u2500\u2500');
      if (breakouts.length) {
        breakouts.slice(0, 5).forEach(b => {
          lines.push(`${tickerLink(b.symbol)} ${$(b.price)}  BBW:${b.bbWidth}  VC:${b.volumeContraction}`);
        });
      } else lines.push('_none_');
      lines.push('');

      lines.push('\u2500\u2500\u2500 *PREMARKET MOVERS (top 5)* \u2500\u2500\u2500');
      if (movers.length) {
        movers.slice(0, 5).forEach(m => {
          const g = (m.gapPct || 0).toFixed(1);
          lines.push(`${tickerLink(m.symbol)} gap:${g}%  vol:${m.volumeRatio || '?'}x`);
        });
      } else lines.push('_none_');
      lines.push('');

      lines.push('\u2500\u2500\u2500 *GEMS (top 5)* \u2500\u2500\u2500');
      if (gems.length) {
        gems.forEach(g => {
          const ch = (g.changePct || 0) >= 0 ? `+${(g.changePct || 0).toFixed(1)}%` : `${(g.changePct || 0).toFixed(1)}%`;
          lines.push(`${tickerLink(g.symbol)} ${$(g.price)} ${ch}  score:${g.gemScore} \u00B7 ${g.consensus}`);
        });
      } else lines.push('_scanning..._');
      lines.push('');

      lines.push(`\uD83D\uDEF0 *DISCOVERY*: ${dynSyms.length} tickers live (age ${Math.round((discoStats.ageMs || 0) / 1000)}s)`);
      lines.push(`_sample:_ ${dynSyms.slice(0, 12).join(', ')}`);

      send(cid, lines.join('\n'));
    } catch (err) {
      console.error('[Telegram] /mega error:', err.message);
      send(cid, `\u26A0\uFE0F Mega scan failed: ${err.message}`);
    }
  });

  // ────────────────────────────────────────────────
  // /clear — DELETE ENTIRE CHAT
  // ────────────────────────────────────────────────
  bot.onText(/\/clear/, async (msg) => {
    const cid = msg.chat.id;
    try {
      const msgId = msg.message_id;
      for (let i = msgId; i > Math.max(1, msgId - 200); i--) {
        try {
          await bot.deleteMessage(cid, i);
        } catch { /* message already deleted or too old */ }
      }
      await bot.sendMessage(cid, [
        '\uD83D\uDFE2 *Stock Oracle* \u2014 Ready',
        '',
        '/today \u00B7 /tomorrow \u00B7 /pnl \u00B7 /history',
        '/stats \u00B7 /portfolio \u00B7 /status \u00B7 /help',
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      send(cid, '\u2705 Chat cleared. Use the menu for commands.');
    }
  });

  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  // DAILY-PICKER COMMANDS (the actual workflow)
  // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

  function todayDateIso() {
    return new Date().toISOString().slice(0, 10);
  }
  function nextWeekday() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  function outcomeIcon(o) {
    if (o === 'win') return '\u2705';
    if (o === 'partial') return '\uD83D\uDFE1';
    if (o === 'loss') return '\u274C';
    if (o === 'pending') return '\u23F3';
    return '\u2753';
  }

  // /today \u2014 picks for today's session
  bot.onText(/\/today/, async (msg) => {
    const cid = msg.chat.id;
    if (!sb) return send(cid, '_Supabase not configured._');
    try {
      const { data, error } = await sb.from('daily_picks')
        .select('*')
        .eq('pick_date', todayDateIso())
        .order('rank', { ascending: true });
      if (error) throw error;
      const lines = [`\uD83C\uDFAF *Today's Picks* \u2014 ${todayDateIso()}`, ''];
      if (!data || data.length === 0) {
        lines.push('_No picks for today yet._');
        lines.push('Picker fires daily at *16:05 ET* (22:05 Italy).');
        lines.push('Use /tomorrow to preview now.');
        return send(cid, lines.join('\n'));
      }
      let totalDeployed = 0;
      for (const p of data) {
        const status = p.outcome === 'pending' ? '\u23F3 orders submitted'
                     : p.outcome === 'win'     ? `\u2705 +${(p.realized_pct||0).toFixed(2)}%`
                     : p.outcome === 'partial' ? `\uD83D\uDFE1 +${(p.realized_pct||0).toFixed(2)}%`
                     : p.outcome === 'loss'    ? `\u274C ${(p.realized_pct||0).toFixed(2)}%`
                     :                            '\uD83D\uDD52 not yet placed';
        const allocated = p.dollar_allocated ? ` \u00B7 $${Math.round(p.dollar_allocated).toLocaleString()}` : '';
        lines.push(`*${p.rank}. ${tickerLink(p.symbol)}*  ${$(p.entry_price)}${allocated}`);
        lines.push(`   Score ${p.composite_score} \u00B7 ${status}`);
        if (p.realized_pnl != null) lines.push(`   P/L: ${$(p.realized_pnl)}`);
        if (p.dollar_allocated) totalDeployed += Number(p.dollar_allocated);
        lines.push('');
      }
      if (totalDeployed > 0) lines.push(`_Total deployed: $${Math.round(totalDeployed).toLocaleString()}_`);
      lines.push('*Plan:* Buy at market open, sell at market close.');
      send(cid, lines.join('\n'));
    } catch (err) { send(cid, `Error: ${err.message}`); }
  });

  // /tomorrow \u2014 preview without submitting orders
  bot.onText(/\/tomorrow/, async (msg) => {
    const cid = msg.chat.id;
    try {
      send(cid, '\uD83D\uDD2E _Running picker preview..._');
      const result = await runDailyPicker({ autoTrade: false });
      if (!result.picks?.length) {
        return send(cid, '\uD83D\uDCED No qualifying picks right now.\nGem cache may be warming up \u2014 try again after a /5min scan.');
      }
      const lines = [`\uD83D\uDD2E *Tomorrow's Preview* \u2014 ${nextWeekday()}`, ''];
      result.picks.forEach((p, i) => {
        lines.push(`*${i + 1}. ${tickerLink(p.symbol)}*  ${$(p.entryPrice)}`);
        lines.push(`   Score ${p.compositeScore} \u00B7 Gem ${p.gemScore} \u00B7 Exp ${p.explosionProb ?? '\u2014'}%`);
        if (p.expectedReturnPct) lines.push(`   Target: +${p.expectedReturnPct.toFixed(1)}%`);
        if (p.signals?.length) lines.push(`   _${p.signals.slice(0, 3).join(', ')}_`);
        lines.push('');
      });
      lines.push('_Preview only \u2014 orders fire automatically at 16:05 ET._');
      send(cid, lines.join('\n'));
    } catch (err) { send(cid, `Error: ${err.message}`); }
  });

  // /pnl \u2014 P&L today / 7d / all-time
  bot.onText(/\/pnl/, async (msg) => {
    const cid = msg.chat.id;
    if (!sb) return send(cid, '_Supabase not configured._');
    try {
      const today = todayDateIso();
      const sevenAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
      const { data: all } = await sb.from('daily_picks').select('*')
        .not('realized_pnl', 'is', null)
        .order('pick_date', { ascending: false });
      const settled = all || [];
      function summarize(rows) {
        if (!rows.length) return null;
        const pnl = rows.reduce((s, r) => s + (Number(r.realized_pnl) || 0), 0);
        const wins = rows.filter(r => (r.realized_pct || 0) > 0).length;
        const avg = rows.reduce((s, r) => s + (Number(r.realized_pct) || 0), 0) / rows.length;
        return { n: rows.length, pnl, wins, winPct: wins / rows.length * 100, avgPct: avg };
      }
      const todayRows = settled.filter(r => r.pick_date === today);
      const weekRows = settled.filter(r => r.pick_date >= sevenAgo);
      let acctEquity = null;
      try { const a = await alpaca.getAccount(); acctEquity = parseFloat(a?.equity || 0); } catch {}
      const lines = ['\uD83D\uDCB0 *P&L Summary*', ''];
      if (acctEquity) lines.push(`*Account equity:* ${$(acctEquity)}`);
      lines.push('');
      const renderBlock = (label, s) => {
        if (!s) { lines.push(`*${label}:* _no settled picks yet_`); return; }
        const icon = s.pnl >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34';
        lines.push(`*${label}:* ${icon} ${$(s.pnl)} \u00B7 ${s.wins}/${s.n} wins (${s.winPct.toFixed(0)}%)`);
        lines.push(`   avg ${s.avgPct >= 0 ? '+' : ''}${s.avgPct.toFixed(2)}%/trade`);
      };
      renderBlock('Today', summarize(todayRows));
      renderBlock('Last 7d', summarize(weekRows));
      renderBlock('All-time', summarize(settled));
      if (settled.length === 0) {
        lines.push('');
        lines.push('_First pick fires today at 22:05 Italy. P&L starts tomorrow._');
      }
      send(cid, lines.join('\n'));
    } catch (err) { send(cid, `Error: ${err.message}`); }
  });

  // /history \u2014 last 10 picks
  bot.onText(/\/history/, async (msg) => {
    const cid = msg.chat.id;
    if (!sb) return send(cid, '_Supabase not configured._');
    try {
      const { data } = await sb.from('daily_picks').select('*')
        .order('pick_date', { ascending: false })
        .order('rank', { ascending: true })
        .limit(20);
      const rows = data || [];
      const lines = ['\uD83D\uDCDC *Last Picks*', ''];
      if (!rows.length) { lines.push('_No picks yet._'); return send(cid, lines.join('\n')); }
      for (const r of rows.slice(0, 10)) {
        const icon = outcomeIcon(r.outcome);
        const ret = r.realized_pct != null ? ` ${(r.realized_pct >= 0 ? '+' : '')}${r.realized_pct.toFixed(2)}%`
                  : r.expected_return_pct != null ? ` _exp +${r.expected_return_pct.toFixed(1)}%_`
                  : '';
        const pnl = r.realized_pnl != null ? ` \u00B7 ${$(r.realized_pnl)}` : '';
        lines.push(`${icon} *${r.pick_date}* ${tickerLink(r.symbol)}${ret}${pnl}`);
      }
      send(cid, lines.join('\n'));
    } catch (err) { send(cid, `Error: ${err.message}`); }
  });

  // /stats \u2014 win rate + total performance
  bot.onText(/\/stats/, async (msg) => {
    const cid = msg.chat.id;
    if (!sb) return send(cid, '_Supabase not configured._');
    try {
      const { data } = await sb.from('daily_picks').select('outcome,realized_pct,realized_pnl,pick_date')
        .not('realized_pnl', 'is', null);
      const settled = data || [];
      const lines = ['\uD83D\uDCCA *Performance Stats*', ''];
      if (!settled.length) {
        lines.push('_No settled picks yet._');
        lines.push('_First settlement: tomorrow ~22:30 Italy._');
        return send(cid, lines.join('\n'));
      }
      const wins = settled.filter(s => s.outcome === 'win').length;
      const partials = settled.filter(s => s.outcome === 'partial').length;
      const losses = settled.filter(s => s.outcome === 'loss').length;
      const pnl = settled.reduce((s, r) => s + (Number(r.realized_pnl) || 0), 0);
      const avg = settled.reduce((s, r) => s + (Number(r.realized_pct) || 0), 0) / settled.length;
      const best = Math.max(...settled.map(s => s.realized_pct || 0));
      const worst = Math.min(...settled.map(s => s.realized_pct || 0));
      const winPct = (wins + partials) / settled.length * 100;
      lines.push(`*Settled picks:* ${settled.length}`);
      lines.push(`*Outcomes:* \u2705 ${wins}w \u00B7 \uD83D\uDFE1 ${partials}p \u00B7 \u274C ${losses}L`);
      lines.push(`*Win rate:* ${winPct.toFixed(1)}% (incl. partial)`);
      lines.push(`*Avg return:* ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%/trade`);
      lines.push(`*Total P&L:* ${pnl >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ${$(pnl)}`);
      lines.push(`*Best / Worst:* +${best.toFixed(1)}% / ${worst.toFixed(1)}%`);
      lines.push('');
      if (settled.length < 20) {
        lines.push(`_${20 - settled.length} more picks needed before monkey baseline runs._`);
      } else {
        lines.push('_Run \\`python python/monkey/monkey_baseline.py\\` for monkey-percentile readout._');
      }
      send(cid, lines.join('\n'));
    } catch (err) { send(cid, `Error: ${err.message}`); }
  });

  // /help \u2014 categorized command reference
  bot.onText(/\/help/, (msg) => {
    const cid = msg.chat.id;
    const lines = [
      '\uD83D\uDD2E *Stock Oracle \u2014 Daily Picker*',
      '',
      'Bot picks 1\u20133 stocks each evening, buys at next open, sells at close.',
      '',
      '*Daily Workflow*',
      '/today      \u2014 picks for today\'s session + status',
      '/tomorrow   \u2014 preview what would be picked right now',
      '/pnl        \u2014 realized P&L (today / 7d / all-time)',
      '/history    \u2014 last 10 picks with outcomes',
      '/stats      \u2014 win rate + total performance',
      '',
      '*Analysis*',
      '/edge       - is the bot edge real? signals vs monkey',
      '',
      '*Account*',
      '/portfolio  \u2014 open positions on Alpaca',
      '/status     \u2014 bot health + market hours',
      '',
      '*Admin*',
      '/clear      \u2014 delete chat history',
      '/stop       \u2014 unsubscribe',
      '',
      '_Picker runs daily 16:05 ET (22:05 Italy)._',
      '_Resolver settles fills at 16:30 ET (22:30 Italy)._',
      '',
      '*Tip:* type a ticker (e.g. `NVDA`, `AAPL`) for full research dossier.',
    ];
    send(cid, lines.join('\n'));
  });

  // ════════════════════════════════════════════════
  // TICKER RESEARCH — type a symbol to get a dossier
  // ════════════════════════════════════════════════
  // Matches plain text that looks like a single ticker (1-6 uppercase letters,
  // optional dash). Excludes slash commands and conversational text.
  bot.on('message', async (msg) => {
    const text = (msg?.text || '').trim();
    if (!text || text.startsWith('/')) return;
    const upper = text.toUpperCase();
    if (!/^[A-Z][A-Z\-]{0,5}$/.test(upper)) return;
    const cid = msg.chat.id;
    try {
      send(cid, `🔎 _Researching *${upper}*..._`);
      const dossier = await researchTicker(upper);
      send(cid, formatDossier(dossier));
    } catch (err) {
      send(cid, `⚠️ Research failed for ${upper}: ${err.message}`);
    }
  });
}

/**
 * Render a TickerDossier into a clean MarkdownV1 Telegram message.
 * @param {Object} d  TickerDossier from researchTicker()
 * @returns {string}
 */
function formatDossier(d) {
  const L = [];
  const sym = d.symbol;
  const v = d.verdict || {};

  // Header — verdict-first so user sees the bottom line immediately
  const verdictIcon = v.recommendation === 'BUY' ? (v.conviction === 'HIGH' ? '🟢🟢' : '🟢')
                    : v.recommendation === 'WATCH' ? '🟡'
                    : v.conviction === 'HIGH' ? '🔴🔴' : '🔴';
  L.push(`${verdictIcon} *${sym}* — ${v.recommendation} (${v.conviction})  ·  Score *${v.score}/100*`);
  L.push('');

  // 🔮 Outlook — the actual answer: where could it go, and what does history say
  const pseudoSignals = [...(d.internal?.signals || [])];
  if (d.price?.avgVolume > 0 && d.price.volume / d.price.avgVolume >= 3) pseudoSignals.push('unusual_volume');
  if (d.price?.week52High && d.price.last >= d.price.week52High * 0.95) pseudoSignals.push('near_52w_high');
  const dossierAnalog = pseudoSignals.length
    ? getAnalog({ signals: pseudoSignals }, scanCacheRef.regime?.regime)
    : null;

  if (d.aiThesis?.action === 'BUY' && d.price?.last) {
    const gain = Math.min(Math.round(d.aiThesis.targetPct || 10), 25);
    const target = Math.round(d.price.last * (1 + gain / 100) * 100) / 100;
    L.push(`🔮 *If it moves:* $${d.price.last} → $${target} (+${gain}%), AI confidence ${d.aiThesis.confidence}/10`);
  }
  if (dossierAnalog) {
    L.push(`📊 *History (since 1998):* ${Math.round(dossierAnalog.hitRate * 100)}% of ${dossierAnalog.n.toLocaleString('en-US')} setups like today's hit +10% in 5d · avg ${dossierAnalog.avgFwd5 > 0 ? '+' : ''}${dossierAnalog.avgFwd5}%/5d`);
  }
  if (d.aiThesis?.action === 'BUY' || dossierAnalog) L.push('');

  // Price (local var `pr` to avoid shadowing the `p()` percent formatter)
  if (d.price) {
    const pr = d.price;
    const arrow = pr.changePct >= 0 ? '↑' : '↓';
    L.push(`💵 *${$(pr.last)}*  ${arrow} ${p(pr.changePct)}  · Vol ${shortNum(pr.volume)} (${(pr.volume/Math.max(pr.avgVolume,1)).toFixed(1)}× avg)`);
    if (pr.marketCap) L.push(`   Cap ${shortNum(pr.marketCap)} · Float ${shortNum(pr.floatShares)}${pr.shortPct ? ` · SI ${pr.shortPct.toFixed(1)}%` : ''}`);
    if (pr.week52High) {
      const fromHigh = ((pr.last / pr.week52High - 1) * 100).toFixed(1);
      L.push(`   52w: ${$(pr.week52Low)} – ${$(pr.week52High)}  (${fromHigh}% from high)`);
    }
    if (d.fundamentals?.sector) L.push(`   ${d.fundamentals.sector}${d.fundamentals.industry ? ' · ' + d.fundamentals.industry : ''}`);
    L.push('');
  }

  // Verdict reasoning
  if (v.reasons?.length) {
    L.push('*Why bullish:*');
    v.reasons.slice(0, 6).forEach(r => L.push(`  ✅ ${r}`));
    L.push('');
  }
  if (v.bears?.length) {
    L.push('*Concerns:*');
    v.bears.slice(0, 4).forEach(r => L.push(`  ⚠️ ${r}`));
    L.push('');
  }

  // Smart money panel
  const smart = [];
  if (d.insider?.buyCount30d > 0) smart.push(`👤 Insider ${d.insider.buyCount30d}× buys/30d (${d.insider.distinctInsiders} distinct)`);
  if (d.congress?.buyCount > 0) smart.push(`🏛 Congress ${d.congress.buyCount} buys (${d.congress.senatorBuys} senators)`);
  if (d.options?.unusualActivity) smart.push(`📣 Unusual options: P/C ${d.options.putCallRatio.toFixed(2)}`);
  if (d.institutions?.netChangePct > 0) smart.push(`🏦 Inst. +${d.institutions.netChangePct.toFixed(1)}%`);
  if (smart.length) {
    L.push('*Smart money:*');
    smart.forEach(s => L.push(`  ${s}`));
    L.push('');
  }

  // Analyst block
  if (d.analyst) {
    const a = d.analyst;
    L.push(`*Analysts (${a.totalAnalysts}):* ${a.bullPct?.toFixed(0)}% buy · ${a.strongBuy} SB · ${a.buy} B · ${a.hold} H · ${a.sell} S`);
    L.push('');
  }

  // Sentiment block
  const sent = [];
  if (d.reddit) {
    sent.push(`Reddit: ${d.reddit.mentions} mentions (Score: ${d.reddit.sentiment >= 0 ? '+' : ''}${d.reddit.sentiment})`);
    if (d.reddit.topPosts && d.reddit.topPosts.length > 0) {
      d.reddit.topPosts.slice(0, 2).forEach(p => sent.push(`  💬 "${p.replace(/\n/g, ' ').substring(0, 60)}..."`));
    }
  }
  if (d.stocktwits) {
    sent.push(`StockTwits: ${d.stocktwits.bullPct?.toFixed(0)}% bull, ${d.stocktwits.messageCount} msg`);
    if (d.stocktwits.topMessages && d.stocktwits.topMessages.length > 0) {
      d.stocktwits.topMessages.slice(0, 2).forEach(m => sent.push(`  💬 "${m.replace(/\n/g, ' ').substring(0, 60)}..."`));
    }
  }
  if (sent.length) {
    L.push('*Social:*');
    sent.forEach(s => L.push(`  ${s}`));
    L.push('');
  }

  // Earnings
  if (d.earnings) {
    const e = d.earnings;
    if (e.beatStreak > 0 || e.avgSurprise) {
      L.push(`*Earnings:* ${e.beatStreak}-beat streak · avg surprise ${e.avgSurprise >= 0 ? '+' : ''}${e.avgSurprise?.toFixed(1)}%`);
      L.push('');
    }
  }

  // AI thesis
  if (d.aiThesis?.thesis) {
    L.push(`*AI Thesis (${d.aiThesis.action} ${d.aiThesis.confidence}/10):*`);
    L.push(`  _${String(d.aiThesis.thesis).slice(0, 280)}_`);
    if (d.aiThesis.warnings?.length) {
      L.push(`  ⚠️ ${d.aiThesis.warnings.slice(0, 2).join('; ')}`);
    }
    L.push('');
  }

  // 💬 Bottom line — one blunt sentence: is this worth attention or not
  const bottomLine = (() => {
    if (v.recommendation === 'BUY') {
      const why = v.reasons?.[0] ? ` Main reason: ${v.reasons[0]}.` : '';
      const hist = dossierAnalog
        ? (dossierAnalog.avgFwd5 >= 0.3
          ? ' History backs setups like this one.'
          : ' But note: history shows only a small edge for setups like this.')
        : '';
      return `Worth your attention.${why}${hist}`;
    }
    if (v.recommendation === 'WATCH') {
      return 'NOT actionable today — nothing here points to an imminent move. Save your attention; the bot will alert you if a real setup forms.';
    }
    const bear = v.bears?.[0] ? ` ${v.bears[0]}.` : '';
    return `Skip it.${bear}`;
  })();
  L.push(`💬 _Bottom line: ${bottomLine}_`);
  L.push('');
  L.push(`_${tickerLink(sym)}_`);

  return L.join('\n');
}

function shortNum(n) {
  const num = Number(n) || 0;
  if (num >= 1e12) return `$${(num / 1e12).toFixed(1)}T`;
  if (num >= 1e9)  return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6)  return `$${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3)  return `$${(num / 1e3).toFixed(0)}K`;
  return `$${num}`;
}

// ════════════════════════════════════════════════════════
// NOTIFICATIONS (sent automatically by cron/auto-trader)
// ════════════════════════════════════════════════════════

export async function notifyNewTrade(trade) {
  if (!bot || subscribers.size === 0) return;
  await broadcast([
    `\uD83D\uDE80 *BOUGHT ${trade.symbol}*`,
    '',
    `\uD83D\uDCB0 ${$(trade.price)}  \u00D7  ${$(trade.amount)}`,
    `\uD83C\uDFAF +${trade.targetPct || 10}%  \uD83D\uDED1 -${trade.stopPct || 5}%`,
  ].join('\n'));
}

export async function notifyTradeExit(trade) {
  if (!bot || subscribers.size === 0) return;
  const won = (trade.pnl || 0) >= 0;
  const pnlPct = trade.price ? (((trade.exitPrice || 0) - trade.price) / trade.price * 100) : 0;
  await broadcast([
    `${won ? '\u2705' : '\u274C'} *SOLD ${trade.symbol}*`,
    `${$(trade.price)} \u2192 ${$(trade.exitPrice)}  *${$(trade.pnl)}* (${p(pnlPct)})`,
  ].join('\n'));
}

export async function notifyError(message) {
  if (!bot || subscribers.size === 0) return;
  await broadcast(`\u26A0\uFE0F ${message}`);
}

/**
 * Send a markdown message to all Telegram subscribers.
 * @param {string} text MarkdownV2 formatted text
 * @returns {Promise<void>}
 */
export async function sendMessage(text) {
  if (!bot || subscribers.size === 0) return;
  await broadcast(text);
}

export async function sendTestMessage() {
  if (!bot || subscribers.size === 0) return { success: false, error: 'No subscribers' };
  try {
    await broadcast('\u2705 *Stock Oracle* online');
    return { success: true, sentTo: subscribers.size };
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
  // Options flow signals
  call_sweep_large: 'Big call sweep', call_sweep: 'Call sweep',
  deep_itm_calls: 'Deep ITM calls', put_call_extreme_bullish: 'Extreme bull flow',
  put_call_bullish: 'Bull options', options_volume_explosion: 'Options explosion',
  options_volume_spike: 'Options spike', near_expiry_call_rush: 'Near-expiry calls',
  // Congress signals
  congress_cluster: 'Congress cluster', senate_buy: 'Senator buy',
  congress_buy: 'Congress buy',
  // Insider intel signals (Finnhub SEC Form 4)
  insider_cluster: 'Exec cluster buy', insider_heavy_buy: 'Big insider buy',
  insider_buy_recent: 'Recent insider buy',
  // Dark pool signals
  dark_pool_squeeze: 'Dark pool squeeze', dark_pool_pressure: 'Dark pool pressure',
  shorts_covering: 'Shorts covering',
  // Analyst signals
  analyst_upgrade: 'Analyst upgrade', analyst_strong_buy: 'Strong consensus',
  analyst_momentum: 'Analyst momentum',
};

// ════════════════════════════════════════════════════════
// RICH PREDICTION ALERT — "this stock should jump from $X to $Y in N days"
// Sent automatically when a setup passes the Claude gate with confidence ≥7.
// ════════════════════════════════════════════════════════

const predictionAlerted = new Map(); // symbol → ts
const PREDICTION_COOLDOWN = 12 * 60 * 60 * 1000;

// Plain-language interpretation of the analog stats — what the numbers MEAN.
function analogPlainWords(analog) {
  const oneIn = analog.hitRate > 0 ? Math.max(2, Math.round(1 / analog.hitRate)) : null;
  const parts = ['_In plain words:'];
  if (analog.avgFwd5 >= 0.5) {
    parts.push(`setups like this have been genuinely good — on average they gained ${analog.avgFwd5 > 0 ? '+' : ''}${analog.avgFwd5}% within a week.`);
  } else if (analog.avgFwd5 > 0) {
    parts.push(`setups like this drift slightly up on average (+${analog.avgFwd5}% in a week) — a small but real edge.`);
  } else {
    parts.push(`setups like this have NOT made money on average historically — be careful.`);
  }
  if (oneIn) {
    parts.push(`Roughly 1 out of every ${oneIn} jumped the full +10% — ${oneIn <= 7 ? 'good odds for this kind of bet' : 'most do not jump that far, the big win is the exception'}.`);
  }
  if (analog.stable === false) {
    parts.push('Note: this pattern worked better in past years than recently.');
  }
  return parts.join(' ') + '_';
}

function buildPredictionMessage(stock, orderInfo, fund, analog) {
  const claude = stock.claude || {};
  const e = stock.explosion || {};
  const price = stock.price || 0;
  // Prefer Claude's validated target over the raw explosion estimate, which
  // historically overshoots (predicted +29% avg vs ~0% realized pre-overhaul).
  const gainPct = Math.round(claude.targetPct || Math.min(e.expectedGainPct || 10, 20));
  const target = Math.round(price * (1 + gainPct / 100) * 100) / 100;
  const days = e.daysToMove || 5;

  const why = (stock.signals || [])
    .slice(0, 6)
    .map(s => sigLabels[s] || s.replace(/_/g, ' '))
    .join(', ');

  // When 28y of analog history is available, show the REAL probability and
  // drop the heuristic one (historically wildly optimistic).
  const probText = analog
    ? ''
    : (e.probability ? ` · est. probability ${e.probability}%` : '');

  const lines = [
    `🔮 *PREDICTION: ${stock.symbol}*${stock.companyName ? ` — ${stock.companyName}` : ''}`,
    '',
    `💵 Now *$${price}* → target *$${target}* (*+${gainPct}%*) within *~${days} day${days === 1 ? '' : 's'}*${probText}`,
    '',
    `📈 *Buy signals:* ${why}`,
  ];

  if (analog) {
    const setupLabel = analog.key.replace(/\+/g, ' + ').replace(/_/g, ' ');
    lines.push('', [
      `📊 *History (since 1998):* ${Math.round(analog.hitRate * 100)}% of ${analog.n.toLocaleString('en-US')} similar setups (${setupLabel}) hit +10% within 5 days`,
      `· avg move ${analog.avgFwd5 > 0 ? '+' : ''}${analog.avgFwd5}%/5d${analog.regime ? ' in this VIX regime' : ''}${analog.stable === false ? ' · ⚠️ edge weaker since 2023' : ''}`,
    ].join(' '));
    lines.push(`💬 ${analogPlainWords(analog)}`);
  }

  const factors = (e.factors || []).slice(0, 3);
  if (factors.length) lines.push(...factors.map(f => `  • ${f}`));

  const setup = [];
  if (stock.marketCap > 0) setup.push(`Cap $${(stock.marketCap / 1e6).toFixed(0)}M`);
  if (stock.floatShares > 0) setup.push(`Float ${(stock.floatShares / 1e6).toFixed(0)}M`);
  if (stock.volumeRatio > 0) setup.push(`Volume ${stock.volumeRatio}x normal`);
  if (stock.shortInterest > 0) setup.push(`Short int. ${stock.shortInterest}%`);
  if (setup.length) lines.push('', `📊 *Setup:* ${setup.join(' · ')}`);

  // Real company fundamentals (Yahoo financialData) — what the business is doing
  if (fund) {
    const fParts = [];
    if (fund.revenueGrowthPct != null) fParts.push(`Revenue ${fund.revenueGrowthPct > 0 ? '+' : ''}${fund.revenueGrowthPct}% YoY`);
    if (fund.earningsGrowthPct != null) fParts.push(`Earnings ${fund.earningsGrowthPct > 0 ? '+' : ''}${fund.earningsGrowthPct}%`);
    if (fund.profitMarginPct != null) fParts.push(`Margin ${fund.profitMarginPct}%`);
    if (fund.analystTarget) fParts.push(`Analyst target $${fund.analystTarget}${fund.analystRecommendation ? ` (${fund.analystRecommendation}, ${fund.analystCount || '?'} analysts)` : ''}`);
    if (fund.nextEarnings) fParts.push(`Next earnings ${fund.nextEarnings}`);
    if (fund.industry) fParts.push(fund.industry);
    if (fParts.length) lines.push('', `🏛 *Fundamentals:* ${fParts.join(' · ')}`);
  }

  if (claude.thesis) {
    lines.push('', `🤖 *AI view (${claude.confidence}/10):* ${claude.thesis}`);
  }
  if (claude.riskLevel) lines.push(`⚠️ *Risk:* ${claude.riskLevel}`);

  // Order status — a prediction this strong should come with an order
  if (orderInfo?.placed) {
    lines.push('', `✅ *Order placed on Alpaca: $${orderInfo.amount}*`);
  } else if (orderInfo?.reason) {
    lines.push('', `⏸ *No order:* ${orderInfo.reason}`);
  }

  lines.push('', `_${stock.consensus || 'Buy'} · ${stock.buyCount || 0}/5 agents · gem ${stock.gemScore || '?'}_`);
  return lines.join('\n');
}

export async function notifyPrediction(stock, orderInfo = null) {
  if (!bot || subscribers.size === 0) return;
  if (!stock?.symbol || !stock.price) return;

  const now = Date.now();
  const last = predictionAlerted.get(stock.symbol);
  if (last && now - last < PREDICTION_COOLDOWN) return;
  for (const [sym, ts] of predictionAlerted) {
    if (now - ts > PREDICTION_COOLDOWN * 2) predictionAlerted.delete(sym);
  }

  try {
    const fund = await getFundamentalsSnapshot(stock.symbol).catch(() => null);
    const analog = stock.analog ?? getAnalog(stock, stock.vixRegime);
    const sent = await broadcast(buildPredictionMessage(stock, orderInfo, fund, analog));
    if (sent > 0) predictionAlerted.set(stock.symbol, now);
  } catch (err) {
    console.error('[Telegram] Prediction alert error:', err.message);
  }
}

export async function notifyBuyAlerts(stocks) {
  if (!bot || subscribers.size === 0) return;
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
      const sigs = (s.signals || []).slice(0, 4).map(sig => sigLabels[sig] || sig).join(' \u00B7 ');

      // ── Compute exit levels from agent verdicts ──
      const buyVerdicts = (s.verdicts || []).filter(v => v.action === 'BUY');
      const avgTargetPct = buyVerdicts.length > 0
        ? buyVerdicts.reduce((sum, v) => sum + (parseFloat(v.targetGain) || 10), 0) / buyVerdicts.length : 10;

      // Target price: average of agent targets, or explosion target, or computed from %
      const agentTargets = buyVerdicts.map(v => v.targetPrice).filter(p => p > 0);
      const targetPrice = agentTargets.length > 0
        ? agentTargets.reduce((a, b) => a + b, 0) / agentTargets.length
        : expl?.targetPrice || (s.price * (1 + avgTargetPct / 100));

      // Stop loss: average of agent stops (conservative — tightest wins)
      const agentStops = buyVerdicts.map(v => v.stopLoss).filter(p => p > 0);
      const stopPrice = agentStops.length > 0
        ? Math.max(...agentStops)  // use the tightest (highest) stop = most conservative
        : s.price * 0.93;          // fallback: 7% stop

      const stopPct = s.price > 0 ? ((stopPrice - s.price) / s.price * 100) : -7;

      // Timeframe from verdicts
      const timeframes = buyVerdicts.map(v => parseInt(v.timeframe) || 5).filter(t => t > 0);
      const avgDays = timeframes.length > 0
        ? Math.round(timeframes.reduce((a, b) => a + b, 0) / timeframes.length) : (expl?.daysToMove || 5);

      // ── Build message ──
      const lines = [
        header,
        '',
        `${tickerLink(s.symbol)}  ${$(s.price)}  ${change}`,
        `Score ${s.gemScore}  \u00B7  ${s.buyCount}/5 agents  \u00B7  ${s.consensus}`,
        '',
        `\u2500\u2500\u2500 *TRADE PLAN* \u2500\u2500\u2500`,
        `\uD83D\uDFE2 Entry: *${$(s.price)}*`,
        `\uD83C\uDFAF Take profit: *${$(targetPrice)}* (+${avgTargetPct.toFixed(0)}%)`,
        `\uD83D\uDED1 Stop loss: *${$(stopPrice)}* (${stopPct.toFixed(1)}%)`,
        `\u23F0 Timeframe: *${avgDays} day${avgDays > 1 ? 's' : ''}*`,
      ];

      // Add explosion prediction if strong
      if (expl?.expectedGainPct >= 15) {
        const urgIcon = expl.urgency === 'IMMINENT' ? '\u26A1' : expl.urgency === 'SOON' ? '\u23F0' : '\uD83D\uDD04';
        lines.push('');
        lines.push(`${urgIcon} *+${expl.expectedGainPct}%* predicted (${expl.probability}%)`);
      }

      // Signals
      if (sigs) {
        lines.push('');
        lines.push(`\uD83D\uDD0D ${sigs}`);
      }
      if (expl?.factors?.[0]) lines.push(`\uD83E\uDDE0 ${expl.factors[0]}`);

      const msg = lines.join('\n');
      const sent = await broadcast(msg);

      // Only start the 4h cooldown if at least one subscriber actually got the
      // alert — a transient Telegram failure must not mute the stock for 4h.
      if (sent > 0) {
        alertedStocks.set(s.symbol, { ts: now, gemScore: s.gemScore || 0 });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error('[Telegram] Alert error:', err.message);
    }
  }
}

export async function notifyTradeRejected(stock) {
  if (!bot || subscribers.size === 0) return;
  
  const sym = stock.symbol;
  const now = Date.now();
  
  // Clean stale cooldowns
  for (const [s, entry] of alertedStocks) {
    if (now - entry.ts > ALERT_COOLDOWN_MS) alertedStocks.delete(s);
  }
  
  const prev = alertedStocks.get(sym);
  // Don't spam rejection for the same stock over and over within 4 hrs unless score spiked heavily
  if (prev && (stock.gemScore || 0) < (prev.gemScore || 0) + ALERT_SCORE_JUMP) return;
  
  alertedStocks.set(sym, { ts: now, gemScore: stock.gemScore || 0 });

  const text = `\uD83D\uDEAB *TRADE REJECTED* \u2014 *${sym}*\n\n_The scanner spotted this setup (Score: ${Math.round(stock.gemScore || 0)}), but the Auto-Trader blocked the trade._\n\n\u26A0\uFE0F *Reason:* ${stock.reason}\n\n_Careful if trading manually!_`;
  
  await broadcast(text);
}

// ════════════════════════════════════════════════════════
// EARLY WARNING ALERTS (progressive, Revolut only)
// ════════════════════════════════════════════════════════

export async function notifyEarlyWarnings() {
  if (!bot || subscribers.size === 0) return;

  try {
    const newAlerts = getNewAlerts({ revolutOnly: true });
    if (!newAlerts?.length) return;

    // Only LOADING/IMMINENT stages get pushed — day-1 BUILDING alerts were
    // generating ~30 notifications/day of noise with no demonstrated edge.
    const actionable = newAlerts.filter(a => a.stage === 'IMMINENT' || a.stage === 'LOADING');
    if (!actionable.length) return;

    let sentCount = 0;
    for (const alert of actionable.slice(0, 3)) {
      try {
        await broadcast(alert.alertMessage);
        sentCount++;
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error('[Telegram] Early warning alert error:', err.message);
      }
    }

    console.log(`[Telegram] Sent ${sentCount} early warning alerts (${newAlerts.length} candidates)`);
  } catch (err) {
    console.error('[Telegram] notifyEarlyWarnings error:', err.message);
  }
}

// ════════════════════════════════════════════════════════
// PROACTIVE MOVER / SQUEEZE / BREAKOUT ALERTS
// Fires when an urgent setup appears even if it hasn't yet passed
// the full gem pipeline — gives user a few-minute head start.
// ════════════════════════════════════════════════════════

const moverAlertCooldown = new Map();
const MOVER_COOLDOWN_MS = 60 * 60 * 1000;

function shouldAlertMover(symbol) {
  const now = Date.now();
  for (const [sym, ts] of moverAlertCooldown) {
    if (now - ts > MOVER_COOLDOWN_MS) moverAlertCooldown.delete(sym);
  }
  if (moverAlertCooldown.has(symbol)) return false;
  moverAlertCooldown.set(symbol, now);
  return true;
}

export async function notifyMoverAlerts({ movers = [], squeezes = [], breakouts = [] } = {}) {
  if (!bot || subscribers.size === 0) return;

  const urgentSqueezes = squeezes.filter(s =>
    (s.probability || 0) >= 60 ||
    ((s.shortPercentOfFloat || 0) >= 25 && (s.shortRatio || 0) >= 5)
  );
  const urgentGaps = movers.filter(m =>
    Math.abs(m.gapPct || 0) >= 15 && (m.volumeRatio || 0) >= 5
  );
  const urgentBreakouts = breakouts.filter(b =>
    (b.bbWidth || 1) <= 0.08 && (b.volumeContraction || 0) >= 0.9
  );

  const bucket = [
    ...urgentSqueezes.map(s => ({ kind: 'SQUEEZE', data: s })),
    ...urgentGaps.map(m => ({ kind: 'GAP', data: m })),
    ...urgentBreakouts.map(b => ({ kind: 'COIL', data: b })),
  ].filter(item => shouldAlertMover(`${item.kind}:${item.data.symbol}`));

  if (bucket.length === 0) return;

  for (const item of bucket.slice(0, 5)) {
    try {
      const d = item.data;
      let msg;
      const link = tickerLink(d.symbol);
      if (item.kind === 'SQUEEZE') {
        const si = d.shortPercentOfFloat != null ? `${d.shortPercentOfFloat.toFixed(1)}%` : '?';
        const dtc = d.shortRatio != null ? d.shortRatio.toFixed(1) : '?';
        const tgt = d.targets?.moderate != null ? `\n\uD83C\uDFAF target ${$(d.targets.moderate)} (+${d.targets.moderateGain}%)` : '';
        msg = [
          `\u26A1 *SQUEEZE LOADING* \u2014 ${link}`,
          `${$(d.price)}  \u00B7  SI:${si}  \u00B7  DTC:${dtc}`,
          `probability: *${d.probability || '?'}%* \u2014 act fast before it moves${tgt}`,
        ].join('\n');
      } else if (item.kind === 'GAP') {
        const g = (d.gapPct || 0).toFixed(1);
        msg = [
          `\uD83D\uDCA5 *EXPLOSIVE GAP* \u2014 ${link}`,
          `gap: *${g}%*  \u00B7  vol: ${d.volumeRatio || '?'}x normal`,
          `_premarket/intraday breakout — could run fast_`,
        ].join('\n');
      } else {
        msg = [
          `\uD83C\uDFAF *COILED SPRING* \u2014 ${link}`,
          `${$(d.price)}  \u00B7  BBW:${d.bbWidth}  \u00B7  VolContract:${d.volumeContraction}`,
          `_volatility compressed — breakout imminent_`,
        ].join('\n');
      }
      await broadcast(msg);
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error('[Telegram] Mover alert error:', err.message);
    }
  }

  console.log(`[Telegram] Sent ${bucket.length} urgent mover alerts`);
}

export function stopBot() { if (bot) { bot.stopPolling(); bot = null; } }
