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

    // Load chatId — prefer env var (survives Railway redeploys) then file fallback
    if (process.env.TELEGRAM_CHAT_ID) {
      chatId = parseInt(process.env.TELEGRAM_CHAT_ID, 10);
      console.log(`[Telegram] ChatId from env: ${chatId}`);
    } else {
      const cfg = loadConfig();
      if (cfg.chatId) chatId = cfg.chatId;
    }
    console.log(`[Telegram] Bot online${chatId ? ` (chat: ${chatId})` : ' — send /start to register'}`);

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
      { command: 'market', description: 'Full market intelligence dashboard' },
      { command: 'poly', description: 'Polymarket portfolio & picks' },
      { command: 'bet', description: 'See Claude Polymarket analysis' },
      { command: 'goal', description: 'Progress toward $400K goal' },
      { command: 'phase', description: 'Growth phase & strategy limits' },
      { command: 'momentum', description: 'Markets with big price moves' },
      { command: 'clear', description: 'Clear chat history' },
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
    console.log(`[Telegram] ⚠️ ChatId registered: ${chatId} — add TELEGRAM_CHAT_ID=${chatId} to Railway env vars for persistence`);
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

      // Add Polymarket category accuracy
      try {
        const { getCategoryAccuracy } = await import('./polySimulator.js');
        const cats = getCategoryAccuracy();
        const catEntries = Object.entries(cats).filter(([, s]) => s.total >= 1);
        if (catEntries.length > 0) {
          lines.push('', '*Poly Category Accuracy:*');
          const sorted = catEntries.sort((a, b) => b[1].winRate - a[1].winRate);
          for (const [cat, s] of sorted.slice(0, 6)) {
            const icon = s.winRate >= 60 ? '\uD83D\uDFE2' : s.winRate >= 40 ? '\uD83D\uDFE1' : '\uD83D\uDD34';
            lines.push(`  ${icon} ${cat}: ${s.winRate}% (${s.wins}/${s.total})`);
          }
        }
      } catch {}

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
        const potentialWin = pos.outcome === 'Yes'
          ? Math.round((pos.amount / pos.entryPrice) - pos.amount)
          : Math.round((pos.amount / (1 - pos.entryPrice)) - pos.amount);
        const dlStr = pos.daysLeft ? ` \u00B7 ~${Math.round(pos.daysLeft)}d` : '';
        lines.push(`${pos.outcome === 'Yes' ? '\uD83D\uDFE2' : '\uD83D\uDD34'} ${(pos.question || '').slice(0, 40)}`);
        lines.push(`   $${pos.amount} at ${Math.round(pos.entryPrice * 100)}\u00A2 \u2192 Win +$${potentialWin}${dlStr}`);
      });

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /bet — see what Claude's brain is thinking (read-only — cron places real bets)
  bot.onText(/\/bet/, async (msg) => {
    send(msg.chat.id, '\uD83E\uDDE0 *Claude is scanning...*\nThis shows what I see. I place bets *autonomously* every 15 min \u2014 only when the math is right.');
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
        resolution_snipe: '\uD83C\uDFAF Snipe',
        momentum: '\uD83D\uDCC8 Momentum',
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
          resolution_snipe: '\uD83C\uDFAF',
          momentum: '\uD83D\uDCC8',
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
            `\uD83D\uDEE1 Return: *+${pick.returnPct || 0}%* in ${pick.daysLeft || '?'} days`,
            `\uD83D\uDCC8 Annualized: *${pick.annualizedReturn || 0}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
          );
        } else if (pick.strategy === 'arbitrage' || pick.strategy === 'cross_platform_arb') {
          lines.push(
            `\uD83D\uDD04 Arb edge: *+${pick.edge || 0}%* risk-free`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            `\uD83D\uDCDD ${pick.thesis || ''}`,
          );
        } else if (pick.strategy === 'whale_follow') {
          lines.push(
            `\uD83D\uDC33 Volume spike: *$${(pick.volumeDelta || 0).toLocaleString()}*`,
            `\uD83D\uDCC8 Price move: *${pick.priceDelta || 0}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            `\uD83D\uDCDD ${pick.thesis || ''}`,
          );
        } else if (pick.strategy === 'conditional_chain') {
          lines.push(
            `\uD83D\uDD17 Chain from: ${(pick.anchor || '').slice(0, 50)}`,
            `\uD83D\uDCC8 Edge: *+${pick.edge || 0}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            `\uD83D\uDCDD ${pick.thesis || ''}`,
          );
        } else if (pick.strategy === 'resolution_snipe') {
          lines.push(
            `\uD83C\uDFAF Return: *+${pick.returnPct || 0}%* in ${pick.daysLeft || '?'} days`,
            `\uD83D\uDCC8 Annualized: *${pick.annualizedReturn || 0}%*`,
            `\uD83D\uDCB0 Price: ${Math.round((pick.marketYesPrice || 0.5) * 100)}\u00A2`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            `\uD83E\uDDE0 Near-certain outcome not fully priced in`,
          );
        } else if (pick.strategy === 'momentum') {
          const arrow = pick.direction === 'up' ? '\u2B06\uFE0F' : '\u2B07\uFE0F';
          lines.push(
            `${arrow} Direction: *${pick.direction?.toUpperCase()}* (${pick.momentumStrength || 'moderate'})`,
            `1h: ${(pick.momentum1h || 0) > 0 ? '+' : ''}${(pick.momentum1h || 0).toFixed(1)}% \u00B7 4h: ${(pick.momentum4h || 0) > 0 ? '+' : ''}${(pick.momentum4h || 0).toFixed(1)}% \u00B7 24h: ${(pick.momentum24h || 0) > 0 ? '+' : ''}${(pick.momentum24h || 0).toFixed(1)}%`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
            `\uD83E\uDDE0 ${pick.thesis || ''}`,
          );
        } else {
          // Edge detection, longshot, cross_platform_edge
          const yesP = (pick.marketYesPrice != null && !isNaN(pick.marketYesPrice)) ? Math.round(pick.marketYesPrice * 100) : '?';
          const noP = (pick.marketNoPrice != null && !isNaN(pick.marketNoPrice)) ? Math.round(pick.marketNoPrice * 100) : '?';
          const realP = (pick.realProbability != null && !isNaN(pick.realProbability)) ? Math.round(pick.realProbability * 100) : '?';
          lines.push(
            `\uD83D\uDCB0 Market: ${yesP}\u00A2 Yes / ${noP}\u00A2 No`,
            `\uD83E\uDDE0 Claude: ${realP}% real`,
            `\uD83D\uDCC8 Edge: *${(pick.edge || 0) > 0 ? '+' : ''}${pick.edge || 0}%*`,
            `[${confBar}] Confidence: ${pick.confidence}/10`,
          );
          // Show ensemble info if available
          if (pick.ensemble) {
            const agr = pick.ensemble.agreement === 'STRONG' ? '\u2705' : pick.ensemble.agreement === 'MODERATE' ? '\uD83D\uDFE1' : '\uD83D\uDD34';
            lines.push(`${agr} Ensemble: Claude ${Math.round(pick.ensemble.claude.prob * 100)}% / Gemini ${Math.round(pick.ensemble.gemini.prob * 100)}% (${pick.ensemble.agreement})`);
          }
          lines.push('', `\uD83D\uDCDD ${pick.thesis || ''}`);
        }

        lines.push('', `\uD83D\uDCB5 Size: ${pick.suggestedSizePct || 5}% of bankroll`);

        // Clear verdict: would the brain actually bet on this?
        const thresholds = {
          safe_bet: { minConf: 6, minEdge: 2 },
          arbitrage: { minConf: 5, minEdge: 3 },
          cross_platform_arb: { minConf: 5, minEdge: 3 },
          cross_platform_edge: { minConf: 6, minEdge: 5 },
          conditional_chain: { minConf: 7, minEdge: 8 },
          whale_follow: { minConf: 6, minEdge: 2 },
          longshot_sell: { minConf: 7, minEdge: 10 },
          edge_detection: { minConf: 6, minEdge: 8 },
        };
        const t = thresholds[pick.strategy] || thresholds.edge_detection;
        const wouldBet = pick.confidence >= t.minConf && Math.abs(pick.edge || 0) >= t.minEdge;

        if (wouldBet) {
          lines.push('\n\u2705 *WOULD BET* \u2014 passes quality gate');
        } else {
          const reasons = [];
          if (pick.confidence < t.minConf) reasons.push(`conf ${pick.confidence} < ${t.minConf}`);
          if (Math.abs(pick.edge || 0) < t.minEdge) reasons.push(`edge ${Math.abs(pick.edge||0)}% < ${t.minEdge}%`);
          lines.push(`\n\u274C *WOULD NOT BET* \u2014 ${reasons.join(', ')}`);
        }
        if (pick.isBestBet) lines.push('\u2B50 *BEST OPPORTUNITY*');

        await send(msg.chat.id, lines.join('\n'));
        await new Promise(r => setTimeout(r, 500));
      }

      // Show current portfolio status
      try {
        const { getPortfolio } = await import('./polySimulator.js');
        const p = getPortfolio();
        send(msg.chat.id, `\n\uD83D\uDCBC Portfolio: *$${p.totalValue.toFixed(2)}* \u00B7 ${p.openPositions.length} open \u00B7 ${p.winRate}% WR\n\u23F0 Auto-bets run every 15 min. I only bet when edge + confidence are strong enough.`);
      } catch {}

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

  // /phase — current growth phase and strategy limits
  bot.onText(/\/phase/, async (msg) => {
    try {
      const { getPortfolio, getGrowthPhase, getCategoryAccuracy } = await import('./polySimulator.js');
      const p = getPortfolio();
      const phase = p.growthPhase;

      const phaseIcons = { foundation: '\uD83C\uDFD7\uFE0F', growth: '\uD83C\uDF31', acceleration: '\uD83D\uDE80', moonshot: '\uD83C\uDF19' };
      const icon = phaseIcons[phase.name] || '\uD83D\uDCCA';
      const progressBar = '\u2588'.repeat(Math.round(phase.progress / 5)) + '\u2591'.repeat(20 - Math.round(phase.progress / 5));

      const lines = [
        `${icon} *Growth Phase: ${phase.name.toUpperCase()}*`,
        '',
        `\uD83D\uDCB0 Balance: *$${p.totalValue.toLocaleString()}*`,
        `[${progressBar}] ${phase.progress}%`,
        `Next phase at: $${phase.maxBalance.toLocaleString()}`,
        '',
        `\uD83C\uDFAF Max bet: ${phase.maxBetPct}% of balance`,
        `\uD83E\uDDE0 Min confidence: ${phase.minConfidence}/10`,
        `\uD83D\uDCCB Strategies: ${phase.strategies.join(', ')}`,
      ];

      // Category accuracy
      const cats = p.categoryAccuracy || {};
      const catEntries = Object.entries(cats).filter(([, s]) => s.total >= 1);
      if (catEntries.length > 0) {
        lines.push('', '*Category Win Rates:*');
        const sorted = catEntries.sort((a, b) => b[1].winRate - a[1].winRate);
        for (const [cat, s] of sorted) {
          const mult = s.winRate >= 70 ? '2.0x' : s.winRate >= 60 ? '1.5x' : s.winRate >= 50 ? '1.0x' : s.winRate >= 30 ? '0.5x' : '0x';
          const wrIcon = s.winRate >= 60 ? '\uD83D\uDFE2' : s.winRate >= 40 ? '\uD83D\uDFE1' : '\uD83D\uDD34';
          lines.push(`  ${wrIcon} ${cat}: ${s.winRate}% (${s.wins}/${s.total}) \u00B7 ${mult} \u00B7 P&L: ${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl}`);
        }
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /momentum — show markets with biggest price moves
  bot.onText(/\/momentum/, async (msg) => {
    try {
      const { getMomentumSignals } = await import('./polyMomentum.js');
      const data = getMomentumSignals();

      if (data.signals.length === 0) {
        return send(msg.chat.id, `\uD83D\uDCC8 *Momentum Tracker*\n\nTracking ${data.trackedMarkets} markets.\nNo significant moves detected yet \u2014 need a few scan cycles to build history.`);
      }

      const lines = [
        `\uD83D\uDCC8 *Momentum Tracker*`,
        `Tracking ${data.trackedMarkets} markets\n`,
      ];

      for (const sig of data.signals.slice(0, 8)) {
        const arrow1h = sig.m1h > 0 ? '\u2B06\uFE0F' : sig.m1h < 0 ? '\u2B07\uFE0F' : '\u2796';
        const arrow4h = sig.m4h > 0 ? '\u2B06\uFE0F' : sig.m4h < 0 ? '\u2B07\uFE0F' : '\u2796';
        const arrow24h = sig.m24h > 0 ? '\u2B06\uFE0F' : sig.m24h < 0 ? '\u2B07\uFE0F' : '\u2796';
        lines.push(`${arrow1h} 1h: ${sig.m1h > 0 ? '+' : ''}${sig.m1h.toFixed(1)}% \u00B7 ${arrow4h} 4h: ${sig.m4h > 0 ? '+' : ''}${sig.m4h.toFixed(1)}% \u00B7 ${arrow24h} 24h: ${sig.m24h > 0 ? '+' : ''}${sig.m24h.toFixed(1)}%`);
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /market — full market intelligence dashboard
  bot.onText(/\/market/, async (msg) => {
    send(msg.chat.id, '\uD83D\uDCCA *Scanning market intelligence...*');
    try {
      const { getMarketRegime, getSectorRotation, getHighShortInterest, getCorrelationPairs } = await import('./stockIntel.js');

      const [regime, sectors, shorts, pairs] = await Promise.all([
        getMarketRegime(),
        getSectorRotation(),
        getHighShortInterest(),
        getCorrelationPairs(),
      ]);

      // Regime
      const regimeIcon = { CALM: '\uD83D\uDFE2', NORMAL: '\uD83D\uDFE1', ELEVATED: '\uD83D\uDFE0', HIGH_FEAR: '\uD83D\uDD34', PANIC: '\u26A0\uFE0F' }[regime.regime] || '\u26AA';
      const lines = [
        `${regimeIcon} *Market: ${regime.regime}* (VIX ${regime.vix})`,
        regime.advice,
        `SPY: ${regime.spy?.change > 0 ? '+' : ''}${regime.spy?.change}%`,
        '',
      ];

      // Sectors
      if (sectors?.sectors?.length > 0) {
        lines.push('\uD83D\uDD25 *Hot Sectors:*');
        sectors.sectors.slice(0, 3).forEach(s =>
          lines.push(`  \uD83D\uDFE2 ${s.sector}: +${s.changePct}%`)
        );
        lines.push('\u2744\uFE0F *Cold Sectors:*');
        sectors.sectors.slice(-2).forEach(s =>
          lines.push(`  \uD83D\uDD34 ${s.sector}: ${s.changePct}%`)
        );
        lines.push(`Rotation: *${sectors.rotation}*`, '');
      }

      // Short squeeze alerts
      const squeezeAlerts = (shorts || []).filter(s => s.signal === 'SQUEEZE_ALERT');
      if (squeezeAlerts.length > 0) {
        lines.push('\uD83D\uDCA5 *Squeeze Alerts:*');
        squeezeAlerts.slice(0, 3).forEach(s =>
          lines.push(`  ${s.symbol}: ${s.shortPctFloat}% short, ${s.changePct > 0 ? '+' : ''}${s.changePct}%, vol ${s.volumeRatio}x`)
        );
        lines.push('');
      }

      // Correlation pair divergences
      if (pairs?.length > 0) {
        lines.push('\uD83D\uDD04 *Pair Divergences:*');
        pairs.slice(0, 3).forEach(p =>
          lines.push(`  ${p.leader} +${p.leaderChange}% vs ${p.laggard} ${p.laggardChange}% \u2192 Buy ${p.target}`)
        );
      }

      send(msg.chat.id, lines.join('\n'));
    } catch (err) {
      send(msg.chat.id, `Error: ${err.message}`);
    }
  });

  // /clear — delete recent bot messages to clean up chat
  bot.onText(/\/clear/, async (msg) => {
    try {
      // Send confirmation then delete it + the command message
      const conf = await bot.sendMessage(msg.chat.id, '\uD83E\uDDF9 Clearing chat...');
      // Delete the /clear command itself
      await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      // Delete the "Clearing..." message
      await bot.deleteMessage(msg.chat.id, conf.message_id).catch(() => {});
      // Send a fresh start message
      await bot.sendMessage(msg.chat.id, [
        '\uD83E\uDD16 *Stock Oracle* \u2014 Ready',
        '',
        '\uD83D\uDCCA /portfolio \u00B7 /gems \u00B7 /pennies',
        '\uD83E\uDDE0 /ask \u00B7 /briefing \u00B7 /brain',
        '\uD83C\uDFAF /poly \u00B7 /bet \u00B7 /goal \u00B7 /phase',
        '\uD83D\uDCC8 /next \u00B7 /scan \u00B7 /market',
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      send(msg.chat.id, `\u2705 Fresh start! Use the menu for commands.`);
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
