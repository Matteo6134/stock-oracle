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

// ── Alert dedup: don't spam the same stock every 5 minutes ──
// symbol → { ts: timestamp, gemScore: number }
const alertedStocks = new Map();
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours — re-alert if stock stays hot
const ALERT_SCORE_JUMP = 20; // also re-alert if gem score jumps by this much

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
    bot = new TelegramBot(token, { polling: { params: { timeout: 10 } } });

    // Catch polling errors so they don't crash the server
    bot.on('polling_error', (err) => {
      console.error('[Telegram] Polling error:', err.message);
      // If 409 conflict, stop polling — another instance is running
      if (err.message && err.message.includes('409')) {
        console.error('[Telegram] Another bot instance detected — stopping polling');
        bot.stopPolling();
      }
    });

    const cfg = loadConfig();
    if (cfg.chatId) chatId = cfg.chatId;
    console.log(`[Telegram] Bot online${chatId ? ` (chat: ${chatId})` : ''}`);

    // Set persistent command menu so user sees all commands when tapping "/"
    bot.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'portfolio', description: 'Balance & open positions' },
      { command: 'next', description: 'Pre-market picks (buy before open)' },
      { command: 'gems', description: 'Top quality stocks' },
      { command: 'pennies', description: 'Best penny stocks under $5' },
      { command: 'watchlist', description: 'Your saved watchlist' },
      { command: 'trades', description: 'Recent trade history' },
      { command: 'scan', description: 'Full market scan results' },
      { command: 'ask', description: 'Ask Claude anything about markets' },
      { command: 'briefing', description: 'Hourly market analysis' },
      { command: 'brain', description: 'Claude AI accuracy & status' },
      { command: 'poly', description: 'Polymarket portfolio & picks' },
      { command: 'bet', description: 'Force Polymarket scan now' },
      { command: 'goal', description: 'Progress toward $400K goal' },
    ]).catch(err => console.error('[Telegram] setMyCommands error:', err.message));

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
      '/next \u2014 before the bell picks',
      '/gems \u2014 top quality stocks',
      '/pennies \u2014 best penny stocks <$5',
      '/watchlist \u2014 your saved stocks',
      '/scan \u2014 everything right now',
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

  // /gems — top quality gem stocks from latest scan
  bot.onText(/\/gems/, (msg) => {
    const gems = scanCacheRef.gems || [];
    if (gems.length === 0) {
      return send(msg.chat.id, '\uD83D\uDC8E No gem data yet. Check back during market hours (8 AM\u20136 PM ET).');
    }
    const top = [...gems].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 8);
    const lines = ['\uD83D\uDC8E *Top Gems*', ''];
    top.forEach(g => {
      const icon = g.consensus === 'Strong Buy' ? '\uD83D\uDFE2' : g.consensus === 'Buy' ? '\uD83D\uDD35' : '\u26AA';
      const info = getTargetInfo(g);
      lines.push(`${icon} *${g.symbol}*  ${$(g.price)}  ${p(g.changePct)}  Score ${g.gemScore || 0}`);
      if (info) lines.push(`   \uD83C\uDFAF ${info}`);
      if (g.consensus) lines.push(`   ${g.consensus} \u00B7 ${g.buyCount || 0}/5 agents`);
    });
    if (scanCacheRef.lastScanTime) {
      const t = new Date(scanCacheRef.lastScanTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
      lines.push(`\n\u23F1 Updated ${t} ET`);
    }
    send(msg.chat.id, lines.join('\n'));
  });

  // /pennies — top penny stocks under $5
  bot.onText(/\/pennies/, (msg) => {
    const pennies = scanCacheRef.pennies || [];
    if (pennies.length === 0) {
      return send(msg.chat.id, '\uD83E\uDE99 No penny data yet. Check back during market hours (8 AM\u20136 PM ET).');
    }
    const top = [...pennies].sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0)).slice(0, 8);
    const lines = ['\uD83E\uDE99 *Top Pennies* (under $5)', ''];
    top.forEach(pp => {
      const icon = pp.consensus === 'Strong Buy' ? '\uD83D\uDFE2' : pp.consensus === 'Buy' ? '\uD83D\uDD35' : '\u26AA';
      const info = getTargetInfo(pp);
      lines.push(`${icon} *${pp.symbol}*  ${$(pp.price)}  ${p(pp.changePct)}  Score ${pp.gemScore || 0}`);
      if (info) lines.push(`   \uD83C\uDFAF ${info}`);
      if (pp.consensus) lines.push(`   ${pp.consensus} \u00B7 ${pp.buyCount || 0}/5 agents`);
    });
    if (scanCacheRef.lastScanTime) {
      const t = new Date(scanCacheRef.lastScanTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
      lines.push(`\n\u23F1 Updated ${t} ET`);
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

  // ════════════════════════════════════════════════
  // CLAUDE AI COMMANDS
  // ════════════════════════════════════════════════

  // /ask <question> — ask Claude anything about the market or a stock
  bot.onText(/\/ask (.+)/, async (msg, match) => {
    const question = match[1].trim();
    if (!question) return send(msg.chat.id, 'Usage: /ask <your question>');

    send(msg.chat.id, '\uD83E\uDDE0 Thinking...');

    try {
      // Build portfolio context for Claude
      let portfolioCtx = '';
      try {
        const alpaca = await import('./alpaca.js');
        if (alpaca.isConfigured()) {
          const acc = await alpaca.getAccount();
          const positions = await alpaca.getPositions();
          portfolioCtx = `Portfolio: $${acc.equity} equity, ${positions.length} positions. `;
          if (positions.length > 0) {
            portfolioCtx += 'Holdings: ' + positions.map(p =>
              `${p.symbol} (${p.unrealizedPLPercent >= 0 ? '+' : ''}${p.unrealizedPLPercent}%)`
            ).join(', ') + '. ';
          }
        }
      } catch {}

      // Add scan context
      const gems = scanCacheRef.gems?.slice(0, 5) || [];
      if (gems.length > 0) {
        portfolioCtx += 'Top gems: ' + gems.map(g => `${g.symbol}(score ${g.gemScore})`).join(', ') + '. ';
      }

      const { askClaude } = await import('./claudeBrain.js');
      const answer = await askClaude(question, portfolioCtx);
      send(msg.chat.id, `\uD83E\uDDE0 *Claude:*\n\n${answer}`);
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /briefing — latest hourly market analysis
  bot.onText(/\/briefing/, async (msg) => {
    try {
      const { getMarketContext, getDailySpend } = await import('./claudeBrain.js');
      const ctx = getMarketContext();
      const spend = getDailySpend();

      if (!ctx) {
        return send(msg.chat.id, '\uD83E\uDDE0 No market briefing yet. First briefing runs at :05 during market hours.');
      }

      const regimeIcon = ctx.regime === 'RISK_ON' ? '\uD83D\uDFE2' :
                         ctx.regime === 'RISK_OFF' ? '\uD83D\uDD34' : '\uD83D\uDFE1';

      const lines = [
        `\uD83E\uDDE0 *Market Briefing*`,
        '',
        `${regimeIcon} *${ctx.regime}*`,
        ctx.summary,
        '',
        ctx.hotSectors?.length > 0 ? `\uD83D\uDD25 Hot: ${ctx.hotSectors.join(', ')}` : '',
        ctx.coldSectors?.length > 0 ? `\u2744\uFE0F Cold: ${ctx.coldSectors.join(', ')}` : '',
        '',
        `\uD83D\uDCA1 ${ctx.advice}`,
        `\uD83D\uDCB0 Position size: ${Math.round((ctx.positionSizeMultiplier || 1) * 100)}%`,
        '',
        `\u23F1 ${new Date(ctx.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
        `AI budget: ${spend.spentCents.toFixed(1)}\u00A2 / ${spend.budgetCents}\u00A2`,
      ].filter(Boolean);

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /brain — Claude's accuracy stats + current state
  bot.onText(/\/brain/, async (msg) => {
    try {
      const { isClaudeConfigured, getDailySpend, getMarketContext } = await import('./claudeBrain.js');
      const { getClaudeAccuracy } = await import('./claudeTracker.js');

      if (!isClaudeConfigured()) {
        return send(msg.chat.id, '\u26A0\uFE0F Claude AI not configured. Add ANTHROPIC_API_KEY to .env.');
      }

      const acc = getClaudeAccuracy();
      const spend = getDailySpend();
      const ctx = getMarketContext();

      const lines = [
        '\uD83E\uDDE0 *Claude Brain Status*',
        '',
        `\uD83D\uDFE2 AI Active \u00B7 Budget: ${spend.spentCents.toFixed(1)}\u00A2/${spend.budgetCents}\u00A2 today`,
        ctx ? `\uD83C\uDF0D Market: ${ctx.regime}` : '\uD83C\uDF0D No briefing yet',
        '',
        '*Accuracy*',
        `Total calls: ${acc.totalCalls} \u00B7 Settled: ${acc.totalSettled}`,
        acc.totalSettled > 0 ? `Win rate: *${acc.winRate}%* \u00B7 Avg return: ${acc.avgReturn >= 0 ? '+' : ''}${acc.avgReturn}%` : 'No settled trades yet',
        acc.highConfCount > 0 ? `High-conf (\u22657): ${acc.highConfWinRate}% WR (${acc.highConfCount} calls)` : '',
        acc.totalSettled > 0 ? `Avg confidence: wins ${acc.avgConfWin} vs losses ${acc.avgConfLoss}` : '',
        acc.bestCall ? `\uD83C\uDFC6 Best: ${acc.bestCall.symbol} +${acc.bestCall.pct}% (conf ${acc.bestCall.confidence})` : '',
        acc.worstCall ? `\uD83D\uDCA5 Worst: ${acc.worstCall.symbol} ${acc.worstCall.pct}% (conf ${acc.worstCall.confidence})` : '',
      ].filter(Boolean);

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // ════════════════════════════════════════════════
  // POLYMARKET COMMANDS
  // ════════════════════════════════════════════════

  // /poly — portfolio + goal tracker
  bot.onText(/\/poly/, async (msg) => {
    try {
      const { getPortfolio } = await import('./polySimulator.js');
      const p = getPortfolio();

      const goalBar = '\u2588'.repeat(Math.min(20, Math.round(p.goalPct / 5))) + '\u2591'.repeat(Math.max(0, 20 - Math.round(p.goalPct / 5)));

      const lines = [
        '\uD83C\uDFAF *Polymarket Oracle*',
        '',
        `\uD83D\uDCB0 Portfolio: *$${p.totalValue.toLocaleString()}*`,
        `${p.pnl >= 0 ? '\uD83D\uDFE2' : '\uD83D\uDD34'} P&L: ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toLocaleString()} (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%)`,
        `\uD83D\uDCCA ${p.tradeCount} bets \u00B7 ${p.winRate}% WR \u00B7 ${p.multiplier}x`,
        '',
        `\uD83C\uDFC1 *Goal: $${(p.goal / 1000).toFixed(0)}K*`,
        `[${goalBar}] ${p.goalPct.toFixed(1)}%`,
        '',
        p.openPositions.length > 0 ? '*Open Positions:*' : 'No open positions',
      ];

      p.openPositions.slice(0, 5).forEach(pos => {
        const unrealPnl = (pos.currentPrice - pos.entryPrice) * pos.shares;
        lines.push(`${pos.outcome === 'Yes' ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ${pos.question.slice(0, 35)}...`);
        lines.push(`   ${pos.outcome} at ${Math.round(pos.entryPrice * 100)}\u00A2 \u2192 ${Math.round(pos.currentPrice * 100)}\u00A2 ($${pos.amount})`);
      });

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /bet — force Claude to scan Polymarket with ALL strategies
  bot.onText(/\/bet/, async (msg) => {
    send(msg.chat.id, '\uD83E\uDDE0 *Scanning Polymarket — 6 strategies active...*\n\n\uD83D\uDD0D Edge Detection\n\uD83D\uDD04 Arbitrage\n\uD83C\uDFB0 Longshot Sell\n\uD83D\uDEE1 Safe Bets\n\uD83D\uDCF0 News Speed\n\uD83D\uDCCA Category Accuracy');
    try {
      const { getTopMarkets } = await import('./polymarket.js');
      const { findBestBets, getStrategyStatus } = await import('./polyBrain.js');

      const markets = await getTopMarkets(30);
      const picks = await findBestBets(markets);

      if (picks.length === 0) {
        return send(msg.chat.id, '\u26AA No edge found across any strategy. Markets are fairly priced. Check back later.');
      }

      // Strategy summary
      const stratCounts = {};
      for (const p of picks) {
        const s = p.strategy || 'edge_detection';
        stratCounts[s] = (stratCounts[s] || 0) + 1;
      }
      const stratLabels = {
        edge_detection: '\uD83D\uDD0D Edge',
        arbitrage: '\uD83D\uDD04 Arb',
        longshot_sell: '\uD83C\uDFB0 Longshot',
        safe_bet: '\uD83D\uDEE1 Safe',
        cross_platform_arb: '\uD83C\uDF10 Cross-Plat',
        cross_platform_edge: '\uD83C\uDF10 Cross-Edge',
        conditional_chain: '\uD83D\uDD17 Chain',
        whale_follow: '\uD83D\uDC33 Whale',
      };
      const stratLine = Object.entries(stratCounts).map(([k, v]) => `${stratLabels[k] || k}: ${v}`).join(' \u00B7 ');
      send(msg.chat.id, `\uD83C\uDFAF Found *${picks.length}* opportunities\n${stratLine}`);
      await new Promise(r => setTimeout(r, 300));

      for (const pick of picks.slice(0, 5)) {
        const stratIcon = {
          edge_detection: '\uD83D\uDD0D',
          arbitrage: '\uD83D\uDD04',
          longshot_sell: '\uD83C\uDFB0',
          safe_bet: '\uD83D\uDEE1',
          cross_platform_arb: '\uD83C\uDF10',
          cross_platform_edge: '\uD83C\uDF10',
          conditional_chain: '\uD83D\uDD17',
          whale_follow: '\uD83D\uDC33',
        }[pick.strategy] || '\uD83C\uDFAF';

        const confBar = '\u2588'.repeat(Math.min(pick.confidence, 10)) + '\u2591'.repeat(Math.max(0, 10 - pick.confidence));

        const lines = [
          `${stratIcon} *${pick.action === 'BET_YES' ? 'BET YES' : 'BET NO'}* \u2014 _${pick.strategy.replace(/_/g, ' ')}_`,
          '',
          `"${(pick.question || '').slice(0, 80)}"`,
          '',
        ];

        if (pick.strategy === 'safe_bet') {
          lines.push(
            `\uD83D\uDEE1 Return: *+${pick.returnPct}%* in ${pick.daysLeft} days`,
            `\uD83D\uDCC8 Annualized: *${pick.annualizedReturn}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
          );
        } else if (pick.strategy === 'arbitrage') {
          lines.push(
            `\uD83D\uDD04 Arbitrage edge: *${pick.edge}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            `\uD83D\uDCDD ${pick.thesis}`,
          );
        } else {
          lines.push(
            `\uD83D\uDCB0 Market: ${Math.round((pick.marketYesPrice || 0) * 100)}\u00A2 Yes / ${Math.round((pick.marketNoPrice || 0) * 100)}\u00A2 No`,
            `\uD83E\uDDE0 Claude: ${Math.round((pick.realProbability || 0) * 100)}% real`,
            `\uD83D\uDCC8 Edge: *${pick.edge > 0 ? '+' : ''}${pick.edge}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            '',
            `\uD83D\uDCDD ${pick.thesis}`,
          );
        }

        lines.push('', `\uD83D\uDCB5 Size: ${pick.suggestedSizePct}% of bankroll`);
        if (pick.isBestBet) lines.push('\n\u2B50 *BEST BET*');

        await send(msg.chat.id, lines.join('\n'));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /goal — progress toward $400K
  bot.onText(/\/goal/, async (msg) => {
    try {
      const { getPortfolio } = await import('./polySimulator.js');
      const p = getPortfolio();

      const needed = p.goal - p.totalValue;
      const multiplierNeeded = needed / p.totalValue;
      const betsNeeded = Math.ceil(Math.log(p.goal / p.totalValue) / Math.log(1.15)); // assuming 15% avg win

      const lines = [
        '\uD83C\uDFC1 *$400K Goal Tracker*',
        '',
        `\uD83D\uDCB0 Current: *$${p.totalValue.toLocaleString()}*`,
        `\uD83C\uDFAF Need: *$${Math.round(needed).toLocaleString()}* more`,
        `\uD83D\uDE80 Multiplier needed: ${multiplierNeeded.toFixed(0)}x`,
        `\uD83C\uDFB2 ~${betsNeeded} winning bets at 15% avg`,
        '',
        `\uD83D\uDCCA Win rate: ${p.winRate}% (${p.wins}W/${p.losses}L)`,
        `\uD83D\uDCC8 Current multiplier: ${p.multiplier}x from $1,400`,
      ];

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
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

/**
 * Proactive buy alerts — called after every scan cycle.
 * Sends a Telegram message for each new strong setup the user hasn't been alerted about yet.
 * Deduplicated: same stock won't alert again for 4 hours unless gem score jumps 20+ pts.
 *
 * @param {Array} stocks - analyzed stocks with verdicts, consensus, gemScore
 */
export async function notifyBuyAlerts(stocks) {
  if (!bot || !chatId) return;
  if (!stocks || stocks.length === 0) return;

  const now = Date.now();

  // Clean stale entries (older than cooldown)
  for (const [sym, entry] of alertedStocks) {
    if (now - entry.ts > ALERT_COOLDOWN_MS) alertedStocks.delete(sym);
  }

  // Find stocks that qualify for alert
  const toAlert = stocks.filter(s => {
    if (!s.symbol || !s.price) return false;
    // Must have at least Buy consensus and decent score
    if (!s.consensus || s.consensus === 'No Trade' || s.consensus === 'Speculative') return false;
    if ((s.gemScore || 0) < 55) return false;
    if ((s.buyCount || 0) < 2) return false;

    const prev = alertedStocks.get(s.symbol);
    if (!prev) return true; // Never alerted
    // Re-alert if score jumped significantly
    if ((s.gemScore || 0) >= (prev.gemScore || 0) + ALERT_SCORE_JUMP) return true;
    return false; // Still in cooldown
  });

  if (toAlert.length === 0) return;

  // Sort by gem score — best first
  toAlert.sort((a, b) => (b.gemScore || 0) - (a.gemScore || 0));

  // Send one message per stock (up to 5 at a time to avoid spam burst)
  for (const s of toAlert.slice(0, 5)) {
    try {
      const isStrong = s.consensus === 'Strong Buy';
      const claudeConf = s.claude?.confidence || 0;
      const isOnFire = isStrong && claudeConf >= 8;
      const icon = isOnFire ? '\uD83D\uDCA5' : isStrong ? '\uD83D\uDD25' : '\uD83D\uDC8E';
      const header = isOnFire
        ? '\uD83D\uDCA5\uD83D\uDCA5 *BUY NOW* \uD83D\uDCA5\uD83D\uDCA5'
        : isStrong ? '\uD83D\uDEA8 *STRONG BUY ALERT*' : '\uD83D\uDC8E *BUY ALERT*';

      const buyVerdicts = (s.verdicts || []).filter(v => v.action === 'BUY');
      const avgTarget = buyVerdicts.length > 0
        ? buyVerdicts.reduce((sum, v) => sum + (parseFloat(v.targetGain) || 10), 0) / buyVerdicts.length
        : 10;
      const avgStop = buyVerdicts.length > 0
        ? buyVerdicts.reduce((sum, v) => {
            return sum + (v.stopLoss && s.price ? Math.round(((s.price - v.stopLoss) / s.price) * 100) : 5);
          }, 0) / buyVerdicts.length
        : 5;

      const tpPrice = s.price ? $(s.price * (1 + avgTarget / 100)) : '?';
      const slPrice = s.price ? $(s.price * (1 - avgStop / 100)) : '?';
      const changeLine = (s.changePct || 0) >= 0
        ? `\uD83D\uDFE2 +${(s.changePct || 0).toFixed(1)}% today`
        : `\uD83D\uDD34 ${(s.changePct || 0).toFixed(1)}% today`;

      // Top 3 signals in human-readable form
      const sigLabels = {
        unusual_volume: 'Volume surge',
        multi_day_accumulation: 'Multi-day accumulation',
        smart_money: 'Smart money buying',
        early_momentum: 'Early momentum',
        momentum_acceleration: 'Momentum accelerating',
        short_squeeze_loading: 'Short squeeze loading',
        bb_squeeze: 'BB squeeze',
        near_52w_high: '52-week high',
        low_float_volume: 'Low float + volume',
        insider_buying: 'Insider buying',
        bullish_options: 'Bullish options flow',
        institutions_accumulating: 'Institutions buying',
        unusual_options_volume: 'Unusual options',
        earnings_tomorrow: 'Earnings tomorrow',
      };
      const topSignals = (s.signals || [])
        .slice(0, 3)
        .map(sig => sigLabels[sig] || sig)
        .join(' \u00B7 ');

      // Historical backtest context line (from strategy calibrator)
      let histLine = '';
      if (s.calibration) {
        const cal = s.calibration;
        const pfStr = cal.profitFactor ? ` \u00B7 PF ${cal.profitFactor}` : '';
        const upgradeTag = cal.upgraded ? ' \u2b06\uFE0F backtest-upgraded' : '';
        histLine = `\uD83E\uDDEA ${cal.winRate}% historical WR \u00B7 ${cal.cagr >= 0 ? '+' : ''}${cal.cagr}% CAGR${pfStr}${upgradeTag}`;
      }

      // Claude AI thesis line (if Claude analyzed this stock)
      let claudeLine = '';
      if (s.claude) {
        const cl = s.claude;
        const confDots = '\u25CF'.repeat(Math.min(cl.confidence, 10));
        const overrideNote = s.claudeOverride === 'upgraded' ? ' \u2b06\uFE0F AI-upgraded' :
                             s.claudeOverride === 'rejected' ? ' \u274C AI-rejected' : '';
        claudeLine = `\uD83E\uDDE0 *Claude:* "${cl.thesis}"
${confDots} ${cl.confidence}/10 \u00B7 Risk: ${cl.riskLevel}${overrideNote}`;
      }

      const lines = [
        header,
        '',
        `${icon} *${s.symbol}*  ${$(s.price)}  ${changeLine}`,
        `\uD83C\uDFAF Target: +${avgTarget.toFixed(0)}% \u2192 ${tpPrice}`,
        `\uD83D\uDED1 Stop: -${avgStop.toFixed(0)}% \u2192 ${slPrice}`,
        `\uD83D\uDCCA ${s.buyCount || 0}/5 agents \u00B7 Score ${s.gemScore || 0} \u00B7 ${s.consensus}`,
        histLine,
        topSignals ? `\uD83D\uDD0D ${topSignals}` : '',
        claudeLine,
        '',
        s.source === 'penny' ? '\uD83E\uDE99 Penny stock \u2014 small position, high risk' : '\uD83D\uDC8E Quality setup',
      ].filter(Boolean);

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });

      // Mark as alerted
      alertedStocks.set(s.symbol, { ts: now, gemScore: s.gemScore || 0 });

      // Small delay between messages to avoid Telegram rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.error('[Telegram] Buy alert error:', err.message);
    }
  }
}

export function stopBot() { if (bot) { bot.stopPolling(); bot = null; } }
