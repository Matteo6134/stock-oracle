import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import apiRoutes from './routes/api.js';
import { scanPremarketMovers } from './services/premarketScanner.js';
import { findTomorrowMovers, calculateGemScore } from './services/tomorrowMovers.js';
import { analyzeGem } from './services/tradingDesk.js';
import { saveGemSnapshot } from './services/gemHistory.js';
import * as yahooFinance from './services/yahooFinance.js';
import { scanPennyStocks } from './services/pennyScanner.js';
import { processSignals, checkExitSignals } from './services/autoTrader.js';
import { initTelegramBot, setScanCache, setOnDemandScan, notifyBuyAlerts, notifyNewTrade, notifyEarlyWarnings, notifyTradeRejected, notifyMoverAlerts, notifyAfterHoursMovers, notifyPrediction, sendMessage } from './services/telegram.js';
import { getShortSqueezeSetups, getBreakoutSetups } from './services/premarketScanner.js';
import { updateSignalTracker } from './services/signalTracker.js';
import { filterRevolutStocks } from './services/revolut.js';
import { setShared } from './services/sharedCache.js';
import { runCalibration, getCalibration } from './services/strategyCalibrator.js';
import { analyzeStock, getMarketBriefing, isClaudeConfigured, getMarketContext, askClaude } from './services/claudeBrain.js';
import { logPrediction } from './services/claudeTracker.js';
import { saveExplosionPrediction, resolveExplosionPredictions, resolveDailyPickFills } from './services/db.js';
import * as alpacaService from './services/alpaca.js';
import { getAllIntelligence, getMarketRegime, getSectorRotation } from './services/stockIntel.js';
import { getRedditTrending, getSurgingStocks } from './services/socialSentiment.js';
import { runDailyPicker } from './services/dailyPicker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err?.message || err);
});

// Extend the OHLCV price archive FORWARD so backtests always reach "today".
// Policy: backtests run the full 2016->present window, so the archive must stay current.
function refreshPriceArchive() {
  const pyBin = process.env.PYTHON_BIN || 'C:\\Python312\\python.exe';
  const cwd = path.join(__dirname, '..', 'python', 'backtest');
  const since = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // ~12d overlap
  console.log(`[Archive] Extending price archive forward since ${since}...`);
  let stderr = '';
  let proc;
  try {
    proc = spawn(pyBin, ['build_price_archive.py', '--refresh-since', since], { cwd });
  } catch (err) {
    console.error('[Archive] Could not spawn python:', err.message);
    return;
  }
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => console.error('[Archive] python error:', err.message));
  proc.on('close', (code) => {
    if (code === 0) console.log('[Archive] Price archive extended forward to today.');
    else console.error(`[Archive] build_price_archive exited ${code}: ${stderr.slice(-300)}`);
  });
}

// Nightly rolling backtest: replay every live strategy against the FULL
// 2016→today archive (which the 4 AM job extended by one day), then push a
// Telegram summary. The backtest window grows with the market every night.
function runNightlyReplay() {
  const pyBin = process.env.PYTHON_BIN || 'C:\\Python312\\python.exe';
  const cwd = path.join(__dirname, '..', 'python', 'backtest');
  console.log('[Replay] Nightly rolling backtest starting (full 2016→today window)...');
  let stderr = '';
  let proc;
  try {
    proc = spawn(pyBin, ['historical_replay.py'], { cwd });
  } catch (err) {
    console.error('[Replay] Could not spawn python:', err.message);
    return;
  }
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => console.error('[Replay] python error:', err.message));
  proc.on('close', async (code) => {
    if (code !== 0) {
      console.error(`[Replay] python exited ${code}: ${stderr.slice(-300)}`);
      return;
    }
    try {
      const { readFileSync } = await import('fs');
      const report = JSON.parse(readFileSync(path.join(cwd, 'replay_results', 'replay_report.json'), 'utf8'));
      const spy = report.spy_benchmark?.total_return_pct;
      const monkeyMed = report.monkey_distribution?.median_total_return_pct
        ?? report.monkey_distribution?.p50 ?? null;
      const lines = [
        '🧪 *Nightly backtest* (2016 → ' + (report.window?.end || 'today') + ')',
        '',
        ...Object.values(report.strategies || {}).map(s =>
          `${s.total_return_pct >= 0 ? '🟢' : '🔴'} *${s.strategy}*: ${s.total_return_pct >= 0 ? '+' : ''}${Math.round(s.total_return_pct)}% · win ${Math.round((s.win_rate || 0) * 100)}% · beats ${Math.round(s.monkey_percentile || 0)}% of monkeys · maxDD ${Math.round(s.max_drawdown_pct || 0)}%`),
      ];
      if (spy != null) lines.push('', `📊 SPY same period: +${Math.round(spy)}%${monkeyMed != null ? ` · random-monkey median: ${Math.round(monkeyMed)}%` : ''}`);
      console.log('[Replay] Nightly backtest complete — summary sent to Telegram');
      await sendMessage(lines.join('\n'));
    } catch (err) {
      console.error('[Replay] Report parse/notify failed:', err.message);
    }
  });
}

// Weekly: recompute 28-year setup→outcome analog tables (setup_stats.json,
// macro_stats.json). analogStats.js reloads them automatically on mtime change.
function runSetupStats() {
  const pyBin = process.env.PYTHON_BIN || 'C:\\Python312\\python.exe';
  const cwd = path.join(__dirname, '..', 'python', 'backtest');
  console.log('[SetupStats] Recomputing 1998→today analog tables...');
  let stderr = '';
  let proc;
  try {
    proc = spawn(pyBin, ['setup_stats.py'], { cwd });
  } catch (err) { console.error('[SetupStats] spawn failed:', err.message); return; }
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => console.error('[SetupStats] python error:', err.message));
  proc.on('close', (code) => {
    if (code === 0) console.log('[SetupStats] Analog tables refreshed.');
    else console.error(`[SetupStats] exited ${code}: ${stderr.slice(-300)}`);
  });
}

// Weekly: refresh the rolling 60-day minute-bar archive (Alpaca 1-min data,
// top-150 liquid symbols), then recompute intraday entry-timing stats.
function runMinuteRefresh() {
  const pyBin = process.env.PYTHON_BIN || 'C:\\Python312\\python.exe';
  const cwd = path.join(__dirname, '..', 'python', 'backtest');
  console.log('[Minute] Refreshing minute-bar archive...');
  let proc;
  try {
    proc = spawn(pyBin, ['build_minute_archive.py'], { cwd });
  } catch (err) { console.error('[Minute] spawn failed:', err.message); return; }
  proc.on('error', (err) => console.error('[Minute] python error:', err.message));
  proc.on('close', (code) => {
    if (code !== 0) { console.error(`[Minute] archive build exited ${code}`); return; }
    let statsProc;
    try {
      statsProc = spawn(pyBin, ['intraday_stats.py'], { cwd });
    } catch (err) { console.error('[Minute] stats spawn failed:', err.message); return; }
    statsProc.on('error', (err) => console.error('[Minute] stats error:', err.message));
    statsProc.on('close', (c) => {
      if (c === 0) console.log('[Minute] Intraday entry-timing stats refreshed.');
      else console.error(`[Minute] intraday_stats exited ${c}`);
    });
  });
}

// Weekly: strategy R&D replay — squeeze-family variants vs SPY vs monkeys on
// the full archive. Telegram summary of the leaderboard.
function runWeeklyRnd() {
  const pyBin = process.env.PYTHON_BIN || 'C:\\Python312\\python.exe';
  const cwd = path.join(__dirname, '..', 'python', 'backtest');
  console.log('[RnD] Weekly strategy replay starting...');
  let stderr = '';
  let proc;
  try {
    proc = spawn(pyBin, ['historical_replay_rnd.py'], { cwd });
  } catch (err) { console.error('[RnD] spawn failed:', err.message); return; }
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => console.error('[RnD] python error:', err.message));
  proc.on('close', async (code) => {
    if (code !== 0) { console.error(`[RnD] exited ${code}: ${stderr.slice(-300)}`); return; }
    try {
      const { readFileSync } = await import('fs');
      const report = JSON.parse(readFileSync(path.join(cwd, 'replay_results_rnd', 'replay_report_rnd.json'), 'utf8'));
      const ranked = Object.values(report.strategies || {})
        .sort((a, b) => (b.total_return_pct || 0) - (a.total_return_pct || 0));
      const spy = report.spy_benchmark?.total_return_pct;
      const lines = [
        '🧬 *Weekly strategy R&D* (' + (report.window?.start || '?') + ' → ' + (report.window?.end || '?') + ')',
        '',
        ...ranked.slice(0, 5).map((s, i) =>
          `${i + 1}. *${s.strategy}*: ${s.total_return_pct >= 0 ? '+' : ''}${Math.round(s.total_return_pct)}% · maxDD ${Math.round(s.max_drawdown_pct || 0)}% · beats ${Math.round(s.monkey_percentile || 0)}% of monkeys`),
      ];
      if (spy != null) lines.push('', `📊 SPY same window: +${Math.round(spy)}%`);
      console.log('[RnD] Weekly replay complete — summary sent to Telegram');
      await sendMessage(lines.join('\n'));
    } catch (err) { console.error('[RnD] report parse failed:', err.message); }
  });
}

// Weekly: macro radar — today's market regime vs every similar period since
// 1998 (dot-com, 2008, 2020, 2022 included) + Claude's read on current risks.
async function runMacroRadar() {
  try {
    const { getMacroRadar, recommendedExitTarget, getIntradayTiming } = await import('./services/analogStats.js');
    const radar = getMacroRadar();
    if (!radar?.today) { console.log('[MacroRadar] no macro_stats.json yet'); return; }
    const t = radar.today;
    const b = radar.bucket;
    const regimeLabel = `VIX ${t.vix} (${t.vix_regime}) · trend ${t.trend} · ${t.dd_bucket.replace('_', ' ')}`;
    const lines = [
      `🌍 *Macro Radar* — SPY $${t.spy} · ${regimeLabel}`,
    ];
    if (b) {
      lines.push('', [
        `Since 1998 there were *${b.n_days.toLocaleString('en-US')} days* like today.`,
        `What followed: 1 month later SPY median ${b.fwd21_med > 0 ? '+' : ''}${b.fwd21_med}% (worst 10%: ${b.fwd21_p10}%, best 10%: +${b.fwd21_p90}%);`,
        b.fwd63_med != null ? `3 months later median ${b.fwd63_med > 0 ? '+' : ''}${b.fwd63_med}% (worst 10%: ${b.fwd63_p10}%).` : '',
      ].join(' '));
      // Plain-language read of those numbers
      const mood = b.fwd21_med >= 1 ? 'usually kept drifting UP over the following month'
        : b.fwd21_med >= 0 ? 'usually went more or less sideways over the following month'
        : 'more often than not LOST ground over the following month';
      const tail = b.fwd21_p10 <= -8
        ? `But beware: in the worst cases the market dropped ${b.fwd21_p10}% — days like today CAN precede big falls.`
        : `Big crashes from this exact picture were rare — only 1 day in 10 was followed by a fall worse than ${b.fwd21_p10}%.`;
      lines.push(`💬 _In plain words: after days that looked like today, the market ${mood}. ${tail}_`);
    }
    const exit = recommendedExitTarget();
    if (exit) {
      lines.push('', `🎯 Exit sweep: best historical take-profit is *+${exit.target_pct}%* (avg ${exit.avg_realized_pct > 0 ? '+' : ''}${exit.avg_realized_pct}%/trade incl. held losers)`);
      lines.push(`💬 _In plain words: when our kind of setup works, it tends to run further than +10% — selling too early leaves money on the table; +${exit.target_pct}% was the sweet spot over 28 years._`);
    }
    const timing = getIntradayTiming();
    if (timing?.best) {
      lines.push('', `⏰ Intraday timing (1-min data, ${timing.nSetupDays.toLocaleString('en-US')} setup-days): best entry around *${timing.best.time} ET* (${timing.best.avg_to_close_pct > 0 ? '+' : ''}${timing.best.avg_to_close_pct}% avg to close, win ${Math.round(timing.best.win_rate * 100)}%)`);
      lines.push(`💬 _In plain words: on days we trade, buying around ${timing.best.time} New York time has historically given the best result by the closing bell._`);
    }
    if (isClaudeConfigured()) {
      try {
        const q = `Weekly macro check, 3-4 sentences max: SPY $${t.spy}, ${regimeLabel}. Historical analogs since 1998 show 1-month median ${b?.fwd21_med}%. Markets are debating an AI/space bubble and possible S&P drawdown. What are the 2-3 biggest risks to watch this week, and does history justify panic or patience?`;
        const ans = await askClaude(q, null);
        if (ans) lines.push('', `🤖 *AI view:* ${typeof ans === 'string' ? ans : ans.answer || ''}`);
      } catch { /* stats-only radar is fine */ }
    }
    await sendMessage(lines.join('\n'));
    console.log('[MacroRadar] sent');
  } catch (err) {
    console.error('[MacroRadar] error:', err.message);
  }
}

// Run the Supabase signal-attribution backtest (python), then blend the
// larger-sample fitted weights into the live signalWeights.json.
function runBacktestRefresh() {
  const pyBin = process.env.PYTHON_BIN || 'C:\\Python312\\python.exe';
  const cwd = path.join(__dirname, '..', 'python', 'backtest');
  console.log('[Backtest] Running Supabase signal-attribution refresh...');
  let stderr = '';
  let proc;
  try {
    proc = spawn(pyBin, ['backtest_predictions.py'], { cwd });
  } catch (err) {
    console.error('[Backtest] Could not spawn python:', err.message);
    return;
  }
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => console.error('[Backtest] python error:', err.message));
  proc.on('close', async (code) => {
    if (code !== 0) {
      console.error(`[Backtest] python exited ${code}: ${stderr.slice(-300)}`);
      return;
    }
    try {
      const { mergeAttributionWeights } = await import('./services/attributionWeights.js');
      console.log('[Backtest] Attribution refreshed →', JSON.stringify(mergeAttributionWeights()));
    } catch (err) {
      console.error('[Backtest] Merge error:', err.message);
    }
  });
}

// ── Scan mutex: prevent overlapping cron jobs from piling up ──
let gemScanRunning = false;

// ── Memory monitor: log usage every 5 min, GC hint if high ──
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  if (rssMB > 400) {
    console.warn(`[Memory] HIGH: RSS ${rssMB}MB, Heap ${heapMB}MB — forcing GC`);
    if (global.gc) global.gc();
  } else {
    console.log(`[Memory] RSS ${rssMB}MB, Heap ${heapMB}MB`);
  }
}, 5 * 60 * 1000);

const app = express();
const PORT = process.env.PORT || 4000;

// CORS whitelist — trading endpoints must not accept arbitrary origins
const CORS_ALLOWLIST = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const DEFAULT_ALLOWED = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /\.vercel\.app$/,
  /\.railway\.app$/,
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (CORS_ALLOWLIST.includes(origin)) return cb(null, true);
    if (DEFAULT_ALLOWED.some(re => re.test(origin))) return cb(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());
app.use('/api', apiRoutes);

// ══════════════════════════════════════════
// Background jobs (only on Railway/local, not Vercel)
// ══════════════════════════════════════════
// ── Global scan cache (shared with Telegram bot) ──
const scanCache = {
  gems: [],
  pennies: [],
  allAnalyzed: [],
  movers: [],
  lastScanTime: null,
  lastMoversTime: null,
  scanStats: null,  // { totalScanned, setupsFound, gemsFound, highConviction }
};

// ── Quick scan function for on-demand /scan from Telegram ──
// Runs only the core gem + penny analysis (fast ~15-30s)
// Skips slow enrichment layers (options, congress, dark pool, etc.)
async function runQuickScan({ force = false } = {}) {
  if (gemScanRunning && !force) {
    console.log('[QuickScan] Full scan already running, waiting...');
    for (let i = 0; i < 60 && gemScanRunning; i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
    return;
  }
  gemScanRunning = true;
  try {
    console.log('[QuickScan] On-demand scan triggered via Telegram...');
    const allAnalyzed = [];

    const result = await findTomorrowMovers();
    if (result.stats) scanCache.scanStats = result.stats;
    if (result.gems?.length > 0) {
      // Spread the FULL analyzeGem result — destructuring only 4 fields used to
      // drop needsClaudeReview, so the Claude validation gate never ran.
      const gemsWithVerdicts = result.gems.map(gem => ({ ...gem, ...analyzeGem(gem), source: 'gem' }));
      saveGemSnapshot(gemsWithVerdicts).catch(() => {});
      scanCache.gems = gemsWithVerdicts;
      setShared('gems', gemsWithVerdicts);
      allAnalyzed.push(...gemsWithVerdicts);
      console.log(`[QuickScan] ${gemsWithVerdicts.length} gems found`);
    }

    // Penny stocks
    try {
      const pennyResult = await scanPennyStocks(5);
      if (pennyResult.stocks?.length > 0) {
        const penniesWithVerdicts = pennyResult.stocks.map(stock => ({ ...stock, ...analyzeGem(stock), source: 'penny' }));
        const gemSymbols = new Set(allAnalyzed.map(g => g.symbol));
        const uniquePennies = penniesWithVerdicts.filter(p => !gemSymbols.has(p.symbol));
        scanCache.pennies = uniquePennies;
        allAnalyzed.push(...uniquePennies);
        console.log(`[QuickScan] ${uniquePennies.length} penny setups`);
      }
    } catch (err) {
      console.error('[QuickScan] Penny scan error:', err.message);
    }

    scanCache.allAnalyzed = allAnalyzed;
    scanCache.lastScanTime = new Date().toISOString();
    setShared('allAnalyzed', allAnalyzed);
    console.log(`[QuickScan] Complete: ${allAnalyzed.length} stocks analyzed`);
  } catch (err) {
    console.error('[QuickScan] Error:', err.message);
  } finally {
    gemScanRunning = false;
  }
}

if (!process.env.VERCEL) {
  // ── Gem scan every 5 minutes during market hours ──
  cron.schedule('*/5 * * * *', async () => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const day = et.getDay();
    if (day < 1 || day > 5 || hour < 8 || hour > 18) return;

    if (gemScanRunning) {
      console.log('[Cron] Gem scan already running, skipping');
      return;
    }
    gemScanRunning = true;

    try {
      console.log('[Cron] Running gem + penny scan...');
      const allAnalyzed = [];

      // Scan gems
      const result = await findTomorrowMovers();
      if (result.stats) scanCache.scanStats = result.stats;
      if (result.gems?.length > 0) {
        // Spread the FULL analyzeGem result — destructuring only 4 fields used to
        // drop needsClaudeReview, so the Claude validation gate never ran.
        const gemsWithVerdicts = result.gems.map(gem => ({ ...gem, ...analyzeGem(gem), source: 'gem' }));
        // (snapshot saved after enrichment + rescore below, so the learner
        // sees the final signal set, not the pre-enrichment one)
        scanCache.gems = gemsWithVerdicts;
        setShared('gems', gemsWithVerdicts);
        allAnalyzed.push(...gemsWithVerdicts);
        console.log(`[Cron] Gem scan: ${gemsWithVerdicts.length} gems found`);
      } else {
        // Clear gems from shared cache if none found today (ensures freshness)
        scanCache.gems = [];
        setShared('gems', []);
        console.log('[Cron] Gem scan: No gems found (score >= 60)');
      }

      // Scan penny stocks and run agents on them too
      try {
        const pennyResult = await scanPennyStocks(5);
        if (pennyResult.stocks?.length > 0) {
          const penniesWithVerdicts = pennyResult.stocks.map(stock => ({ ...stock, ...analyzeGem(stock), source: 'penny' }));
          // Add penny stocks that aren't already in gems (avoid duplicates)
          const gemSymbols = new Set(allAnalyzed.map(g => g.symbol));
          const uniquePennies = penniesWithVerdicts.filter(p => !gemSymbols.has(p.symbol));
          scanCache.pennies = uniquePennies;
          allAnalyzed.push(...uniquePennies);
          console.log(`[Cron] Penny scan: ${uniquePennies.length} unique penny setups`);
        }
      } catch (err) {
        console.error('[Cron] Penny scan error:', err.message);
      }

      // ── Stock Intelligence: gather signals from all sources ──
      try {
        const symbols = allAnalyzed.map(s => s.symbol).filter(Boolean);
        const intel = await getAllIntelligence(symbols);
        scanCache.intel = intel;

        // Attach regime data to all stocks (affects position sizing)
        if (intel.regime) {
          scanCache.regime = intel.regime;
          for (const stock of allAnalyzed) {
            stock.vixRegime = intel.regime.regime;
            stock.positionMultiplier = intel.regime.positionMultiplier;
          }
        }

        // Flag stocks with insider buying
        if (intel.insiders?.length > 0) {
          const insiderTickers = new Set(intel.insiders.map(f => f.ticker?.toUpperCase()));
          for (const stock of allAnalyzed) {
            if (insiderTickers.has(stock.symbol)) {
              stock.signals = [...(stock.signals || []), 'insider_buying'];
              stock.insiderBuying = true;
            }
          }
        }

        // Flag squeeze candidates
        if (intel.shortInterest?.length > 0) {
          const squeezeMap = new Map(intel.shortInterest.map(s => [s.symbol, s]));
          for (const stock of allAnalyzed) {
            const si = squeezeMap.get(stock.symbol);
            if (si) {
              stock.shortInterest = si.shortPctFloat;
              stock.squeezePotential = si.squeezePotential;
              if (si.signal === 'SQUEEZE_ALERT') {
                stock.signals = [...(stock.signals || []), 'short_squeeze_loading'];
              }
            }
          }
        }

        // Flag correlation pair opportunities
        if (intel.pairs?.length > 0) {
          for (const pair of intel.pairs) {
            const laggard = allAnalyzed.find(s => s.symbol === pair.target);
            if (laggard) {
              laggard.correlationPair = pair;
              laggard.signals = [...(laggard.signals || []), 'correlation_lag'];
            }
          }
        }

        console.log(`[StockIntel] Regime: ${intel.regime?.regime || '?'}, Sectors: ${intel.sectors?.hottest?.join(',') || '?'}, Insiders: ${intel.insiders?.length || 0}, Short alerts: ${intel.shortInterest?.length || 0}, Pairs: ${intel.pairs?.length || 0}`);
      } catch (err) {
        console.error('[StockIntel] Error:', err.message);
      }

      // ── Options Flow: unusual call sweeps, high-volume calls ──
      // The #1 predictor of big moves — institutions show up in options first
      try {
        const { batchScanOptions } = await import('./services/optionsScanner.js');
        const topSymbols = allAnalyzed.slice(0, 40).map(s => s.symbol);
        const quoteMap = {};
        for (const stock of allAnalyzed) {
          if (stock.symbol) {
            quoteMap[stock.symbol] = {
              regularMarketPrice: stock.price,
              regularMarketVolume: stock.volume,
              averageDailyVolume10Day: stock.avgVolume,
            };
          }
        }
        const optionsMap = await batchScanOptions(topSymbols, quoteMap);
        let optionsHits = 0;
        for (const stock of allAnalyzed) {
          const opt = optionsMap.get(stock.symbol);
          if (!opt || !opt.signals?.length) continue;
          stock.optionsFlow = {
            signals: opt.signals,
            score: opt.score,
            putCallRatio: opt.putCallRatio,
            maxCallSweep: opt.maxCallSweep,
          };
          // Merge options signals into main signals array
          stock.signals = [...(stock.signals || []), ...opt.signals];
          optionsHits++;
        }
        if (optionsHits > 0) {
          console.log(`[OptionsFlow] ${optionsHits} stocks with unusual options activity`);
        }
      } catch (err) {
        console.error('[OptionsFlow] Error:', err.message);
      }

      // ── Congress Trading: political insider buys (Quiver Quant) ──
      // Senators/Reps often trade on privileged info — historically beats market
      try {
        const { getCongressSignals } = await import('./services/congressTracker.js');
        const symbols = allAnalyzed.map(s => s.symbol).filter(Boolean);
        const congressMap = await getCongressSignals(symbols);
        let congressHits = 0;
        for (const stock of allAnalyzed) {
          const cg = congressMap.get(stock.symbol);
          if (!cg) continue;
          stock.congress = {
            buyCount: cg.buyCount,
            senators: cg.senators,
            politicians: cg.politicians,
            signal: cg.signal,
          };
          stock.signals = [...(stock.signals || []), cg.signal];
          congressHits++;
        }
        if (congressHits > 0) {
          console.log(`[Congress] ${congressHits} stocks match recent congressional buys`);
        }
      } catch (err) {
        console.error('[Congress] Error:', err.message);
      }

      // ── Dark Pool / FINRA Short Volume ──
      // High short volume + price holding = shorts trapped = squeeze setup
      try {
        const { batchScanDarkPool, getDarkPoolSignals } = await import('./services/darkPool.js');
        // Only scan top candidates to conserve rate limits
        const topSymbols = allAnalyzed
          .filter(s => (s.gemScore || 0) >= 40)
          .slice(0, 25)
          .map(s => s.symbol);
        const dpMap = await batchScanDarkPool(topSymbols);
        const dpQuoteMap = {};
        for (const stock of allAnalyzed) {
          if (stock.symbol) {
            dpQuoteMap[stock.symbol] = {
              regularMarketChangePercent: stock.changePct,
              changePct: stock.changePct,
            };
          }
        }
        const dpSignals = getDarkPoolSignals(dpMap, dpQuoteMap);
        for (const sig of dpSignals) {
          const stock = allAnalyzed.find(s => s.symbol === sig.symbol);
          if (!stock) continue;
          stock.darkPool = {
            shortRatio: sig.shortRatio,
            shortTrend: sig.shortTrend,
            reason: sig.reason,
          };
          stock.signals = [...(stock.signals || []), sig.signal];
        }
        if (dpSignals.length > 0) {
          console.log(`[DarkPool] ${dpSignals.length} squeeze/pressure signals detected`);
        }
      } catch (err) {
        console.error('[DarkPool] Error:', err.message);
      }

      // ── Insider Intel: Finnhub executive buy clusters (SEC Form 4) ──
      // When multiple executives buy their own company's stock = strongest signal
      try {
        const { getInsiderSignals } = await import('./services/insiderIntel.js');
        const topSymbols = allAnalyzed.slice(0, 25).map(s => s.symbol);
        const insiderMap = await getInsiderSignals(topSymbols);
        for (const stock of allAnalyzed) {
          const ins = insiderMap.get(stock.symbol);
          if (!ins) continue;
          stock.insiderIntel = {
            uniqueInsiders: ins.uniqueInsiders,
            totalValue: ins.totalValue,
            insiderNames: ins.insiderNames,
          };
          stock.signals = [...(stock.signals || []), ...ins.signals];
        }
      } catch (err) {
        console.error('[InsiderIntel] Error:', err.message);
      }

      // ── Analyst Recommendations: Finnhub upgrade/momentum detection ──
      // When analysts shift from Hold → Buy, stocks move 5-10%
      try {
        const { getAnalystSignals } = await import('./services/analystTracker.js');
        const topSymbols = allAnalyzed.slice(0, 25).map(s => s.symbol);
        const analystMap = await getAnalystSignals(topSymbols);
        for (const stock of allAnalyzed) {
          const a = analystMap.get(stock.symbol);
          if (!a) continue;
          stock.analyst = {
            bullPct: a.bullPct,
            totalAnalysts: a.totalAnalysts,
            signals: a.signals,
          };
          stock.signals = [...(stock.signals || []), ...a.signals];
        }
      } catch (err) {
        console.error('[AnalystTracker] Error:', err.message);
      }

      // ── Social Sentiment: ApeWisdom Reddit mentions ──
      try {
        const trending = await getRedditTrending();
        if (trending.length > 0) {
          const trendingMap = new Map(trending.map(t => [t.ticker, t]));
          let socialMatches = 0;
          for (const stock of allAnalyzed) {
            const social = trendingMap.get(stock.symbol);
            if (social) {
              stock.redditMentions = social.mentions;
              stock.redditRank = social.rank;
              stock.redditTrending = social.trending;
              stock.socialSurging = social.mentionsDelta > 50;
              if (social.mentions >= 20) {
                stock.signals = [...(stock.signals || []), 'reddit_trending'];
              }
              if (social.mentionsDelta > 100) {
                stock.signals = [...(stock.signals || []), 'social_surge'];
              }
              socialMatches++;
            }
          }
          // Also check for surging stocks not in our scan — potential opportunities
          const surging = await getSurgingStocks();
          scanCache.socialSurging = surging.slice(0, 10);
          if (socialMatches > 0 || surging.length > 0) {
            console.log(`[Social] ${socialMatches} stocks overlap with Reddit, ${surging.length} surging on social`);
          }
        }
      } catch (err) {
        // Silent — social is bonus data, not critical
      }

      // ── Deduplicate signals: same signal can be emitted by multiple enrichers
      // (e.g. `insider_buying` from both stockIntel and insiderIntel). Duplicates
      // inflate gem score and agent conviction artificially.
      for (const stock of allAnalyzed) {
        if (Array.isArray(stock.signals) && stock.signals.length > 0) {
          stock.signals = [...new Set(stock.signals)];
        }
      }

      // ── Re-score + re-vote with the ENRICHED signal set ──
      // Enrichment (options, congress, insider, analyst, dark pool, social)
      // merges signals AFTER the initial scoring/voting, so the highest-weight
      // signals (congress_cluster 24, call_sweep_large 24, insider_cluster 24,
      // dark_pool_squeeze 20) never influenced gemScore or consensus. Recompute
      // both now that the signal list is final.
      for (const stock of allAnalyzed) {
        if (!Array.isArray(stock.signals) || stock.signals.length === 0) continue;
        stock.gemScore = calculateGemScore(stock.signals, stock.details || {}, null);
        stock.signalCount = stock.signals.length;
        Object.assign(stock, analyzeGem(stock));
      }

      // Snapshot gems for outcome tracking with the final (enriched) signals
      if (scanCache.gems?.length > 0) {
        saveGemSnapshot(scanCache.gems).catch(() => {});
      }

      // Update scan cache
      scanCache.allAnalyzed = allAnalyzed;
      scanCache.lastScanTime = new Date().toISOString();
      setShared('allAnalyzed', allAnalyzed);

      // ── Claude AI Brain: deep analysis on promising stocks ──
      // Claude validates/enriches Buy + Strong Buy setups, can upgrade or reject
      if (isClaudeConfigured() && allAnalyzed.length > 0) {
        const candidates = allAnalyzed.filter(s => s.needsClaudeReview);
        if (candidates.length > 0) {
          console.log(`[Claude] Analyzing ${candidates.length} candidates...`);
          for (const stock of candidates.slice(0, 10)) { // max 10 per cycle
            try {
              const verdict = await analyzeStock(stock);
              if (verdict) {
                stock.claude = verdict;
                logPrediction(stock.symbol, verdict, stock);
                // Claude can reject a trade
                if (verdict.action === 'SKIP') {
                  stock.consensus = 'No Trade';
                  stock.claudeOverride = 'rejected';
                }
                // Claude can upgrade Buy → Strong Buy on high confidence
                if (verdict.action === 'BUY' && verdict.confidence >= 8 && stock.consensus === 'Buy') {
                  stock.consensus = 'Strong Buy';
                  stock.claudeOverride = 'upgraded';
                }
              }
            } catch (err) {
              console.error(`[Claude] ${stock.symbol} error:`, err.message);
            }
          }
        }
      }

      // ── Signal Tracker: track multi-day signal evolution ──
      // This is the key to early detection — stocks that appear for 2-5 consecutive
      // days with rising scores are exponentially more likely to explode
      if (allAnalyzed.length > 0) {
        try {
          const revolutFiltered = filterRevolutStocks(allAnalyzed);
          updateSignalTracker(revolutFiltered);
          console.log(`[SignalTracker] Updated ${revolutFiltered.length} Revolut stocks`);
        } catch (err) {
          console.error('[SignalTracker] Error:', err.message);
        }
      }

      // ── Early Warning Alerts: progressive Telegram notifications ──
      // Sends BUILDING → LOADING → IMMINENT alerts for Revolut stocks
      notifyEarlyWarnings().catch(err =>
        console.error('[Cron] Early warning alert error:', err.message)
      );

      // ── Proactive Telegram buy alerts (independent of auto-trading) ──
      // Fires for every new strong setup so user can buy manually before it moves
      if (allAnalyzed.length > 0) {
        notifyBuyAlerts(allAnalyzed).catch(err =>
          console.error('[Cron] Buy alert error:', err.message)
        );

        // Save explosion predictions to Supabase for tracking accuracy
        const strongGems = allAnalyzed.filter(s =>
          s.explosion?.expectedGainPct >= 15 &&
          (s.consensus === 'Strong Buy' || s.consensus === 'Buy')
        );
        for (const gem of strongGems.slice(0, 10)) {
          saveExplosionPrediction(gem).catch(() => {});
        }
      }

      // Auto-trader: execute trades for strong consensus picks
      if (allAnalyzed.length > 0) {
        console.log(`[AutoTrader] Processing ${allAnalyzed.length} stocks for auto-trading...`);
        const tradeResult = await processSignals(allAnalyzed);
        if (tradeResult.skipped === true) {
          // Early return — auto-trading disabled or market closed
          console.log(`[AutoTrader] Skipped: ${tradeResult.reason}`);
        } else {
          console.log(`[AutoTrader] Results: ${tradeResult.bought?.length || 0} bought, ${tradeResult.skipped?.length || 0} filtered, ${tradeResult.errors?.length || 0} errors`);
          if (Array.isArray(tradeResult.skipped) && tradeResult.skipped.length > 0) {
            console.log(`[AutoTrader] Skip reasons:`, tradeResult.skipped.slice(0, 5).map(s => `${s.symbol}: ${s.reason}`).join(' | '));
            
            // Notify user of highly-scored gems that failed safety checks
            const highConvictionSkips = tradeResult.skipped.filter(s => s.gemScore >= 60 && !s.reason.includes('Already holding') && !s.reason.includes('Insufficient'));
            for (const skip of highConvictionSkips) {
              notifyTradeRejected(skip).catch(() => {});
            }
          }
        }
        if (tradeResult.bought?.length > 0) {
          console.log(`[AutoTrader] Bought: ${tradeResult.bought.map(t => t.symbol).join(', ')}`);
        }

        // ── Rich Telegram predictions — sent AFTER the trade decision so the
        // message can state whether the Alpaca order was actually placed.
        // (12h per-symbol cooldown inside notifyPrediction.)
        const aiPredicted = allAnalyzed.filter(s => s.claude?.action === 'BUY' && s.claude.confidence >= 7);
        // AI-free path: when no AI verdict is available (no credits / no key),
        // predictions still fire on strong MEASURED evidence — Strong Buy
        // consensus + a 1000-sample analog family with >=2.5x the base edge.
        const evidencePredicted = allAnalyzed.filter(s =>
          !s.claude &&
          s.consensus === 'Strong Buy' &&
          s.analog && s.analog.n >= 1000 && s.analog.avgFwd5 >= 0.5
        );
        const predicted = [...aiPredicted, ...evidencePredicted];
        const globalSkip = tradeResult.skipped === true ? tradeResult.reason : null;

        // ── Cash-secured puts: same evidence bar, premium instead of shares.
        // Only runs when the market is open (same global gate as autoTrader).
        if (!globalSkip) {
          try {
            const { findAndSellCsp } = await import('./services/optionsTrader.js');
            const csp = await findAndSellCsp(allAnalyzed);
            if (csp.opened) console.log(`[CSP] Opened ${csp.opened.occSymbol}`);
          } catch (err) {
            console.error('[CSP] error:', err.message);
          }
        }
        for (const stock of predicted) {
          const bought = Array.isArray(tradeResult.bought)
            ? tradeResult.bought.find(b => b.symbol === stock.symbol) : null;
          const filtered = Array.isArray(tradeResult.skipped)
            ? tradeResult.skipped.find(k => k.symbol === stock.symbol) : null;
          notifyPrediction(stock, {
            placed: !!bought,
            amount: bought?.amount,
            reason: bought ? null : (globalSkip || filtered?.reason || 'Already holding or filtered'),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[Cron] Gem scan error:', err.message);
    } finally {
      gemScanRunning = false;
    }
  });

  // ── Resolve explosion predictions daily at 5 PM ET ──
  cron.schedule('0 17 * * 1-5', async () => {
    try {
      console.log('[PredictionResolver] Checking old predictions against actual prices...');
      const result = await resolveExplosionPredictions(yahooFinance.getQuote);
      // NOTE: pinned to America/New_York — was firing at 17:00 local time previously
      // which is mid-trading day in ET. Other crons in this file have the same bug.
      if (result.resolved > 0) {
        console.log(`[PredictionResolver] Resolved ${result.resolved} predictions`);
        for (const r of (result.results || [])) {
          console.log(`  ${r.symbol}: predicted ${r.predicted}, actual ${r.actual} → ${r.hit ? 'HIT' : 'MISS'}`);
        }
      }
    } catch (err) {
      console.error('[PredictionResolver] Error:', err.message);
    }

    // Also resolve gem history outcomes (3d, 5d, 7d returns)
    try {
      const { getGemBacktestData } = await import('./services/gemHistory.js');
      const bt = await getGemBacktestData();
      console.log(`[GemOutcomes] Resolved outcomes for ${bt.totalGems} gems across ${bt.totalDays} days`);
    } catch (err) {
      console.error('[GemOutcomes] Error:', err.message);
    }

    // Run signal learning after outcomes are resolved
    try {
      const { learnFromOutcomes } = await import('./services/signalLearner.js');
      const result = learnFromOutcomes();
      console.log(`[SignalLearner] Updated weights from ${result.totalSamples} samples`);
    } catch (err) {
      console.error('[SignalLearner] Error:', err.message);
    }
    // Blend in the larger Supabase-derived sample — independent of learner success
    try {
      const { mergeAttributionWeights } = await import('./services/attributionWeights.js');
      const m = mergeAttributionWeights();
      if (m.merged) console.log(`[Attribution] Blended ${m.signals} signals (n=${m.samples}); ${m.changes} changed, ${m.suppressed} losers suppressed`);
    } catch (err) {
      console.error('[Attribution] Merge error:', err.message);
    }
  }, { timezone: 'America/New_York' });

  // ── Also resolve gem outcomes at 10 AM ET (catch yesterday's 1d outcomes) ──
  cron.schedule('0 10 * * 1-5', async () => {
    try {
      const { getGemBacktestData } = await import('./services/gemHistory.js');
      await getGemBacktestData();
      console.log('[GemOutcomes] Morning outcome resolution complete');
    } catch (err) {
      console.error('[GemOutcomes] Morning resolution error:', err.message);
    }
  }, { timezone: 'America/New_York' });

  // ── Resolve daily pick fills from Alpaca → Supabase ──
  // Runs at 16:30 ET (after MOC settles) on weekdays. Pulls each pending pick's
  // buy/sell order ids from Supabase, fetches actual fill prices from Alpaca,
  // computes realized P&L, writes to daily_picks + mirrors to stock_trade.
  cron.schedule('30 16 * * 1-5', async () => {
    try {
      console.log('[DailyPickResolver] checking pending fills...');
      const result = await resolveDailyPickFills(alpacaService);
      if (result.resolved > 0) {
        console.log(`[DailyPickResolver] settled ${result.resolved} picks`);
        for (const r of result.results) {
          console.log(`  ${r.symbol} ${r.pickDate}: ${r.fillOpen} -> ${r.fillClose} (${r.pnlPct}%)`);
        }
      }
    } catch (err) {
      console.error('[DailyPickResolver] error:', err.message);
    }
  }, { timezone: 'America/New_York' });

  // ── DAILY PICKER — one stock per day, MOO/MOC via Alpaca ──
  // ── Evening PREVIEW at 16:05 ET (22:05 Italy) — tentative plan, NO orders ──
  // The authoritative buy decision moved to the fresh 07:50 ET morning run (which uses the
  // overnight-refreshed archive + pre-market data). This evening run only sends a heads-up
  // preview so you can eyeball the tentative shortlist the night before.
  cron.schedule('5 16 * * 1-5', async () => {
    try {
      console.log('[DailyPicker] evening preview (no orders)...');
      const result = await runDailyPicker({
        autoTrade: false,
        telegramNotifier: sendMessage,
      });
      console.log(`[DailyPicker] evening preview: ${result.picks.length} tentative picks`);
    } catch (err) {
      console.error('[DailyPicker] evening preview error:', err.message);
    }
  }, { timezone: 'America/New_York' });

  // ── MORNING fresh pick + brief at 07:50 ET (13:50 Italy) — the AUTHORITATIVE buy run ──
  // ~100 min before the 09:30 open and AFTER the 04:00 ET archive refresh: force a fresh gem
  // scan on overnight + pre-market data, then run the picker with autoTrade ON so MOO orders
  // queue for TODAY's open and the buy list reaches Telegram before your ~14:00 Italy window.
  cron.schedule('50 7 * * 1-5', async () => {
    try {
      console.log('[MorningBrief] fresh pre-open scan + pick selection...');
      await runQuickScan({ force: true });   // fresh gems on overnight/pre-market data → shared cache
      const result = await runDailyPicker({
        autoTrade: true,
        telegramNotifier: sendMessage,
      });
      const ok = (result.orderResults || []).filter(r => r.ok).length;
      console.log(`[MorningBrief] ${result.picks.length} picks, ${ok} MOO orders queued for today's open`);
    } catch (err) {
      console.error('[MorningBrief] error:', err.message);
    }
  }, { timezone: 'America/New_York' });

  // ── Auto-trader exit check every 2 minutes during market hours ──
  cron.schedule('*/2 * * * *', async () => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const min = et.getMinutes();
    const day = et.getDay();
    const totalMin = hour * 60 + min;
    if (day < 1 || day > 5 || totalMin < 570 || totalMin >= 960) return;

    try {
      await checkExitSignals();
    } catch (err) {
      console.error('[Cron] Exit signal check error:', err.message);
    }
  });

  // ── Movers scan every 3 minutes pre-market ──
  cron.schedule('*/3 * * * *', async () => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const min = et.getMinutes();
    const day = et.getDay();
    // Pre-market: 4-9:30 AM ET weekdays
    const preMarket = day >= 1 && day <= 5 && ((hour >= 4 && hour < 9) || (hour === 9 && min < 30));
    if (!preMarket) return;

    try {
      const result = await scanPremarketMovers();
      if (result.length > 0) {
        scanCache.movers = result;
        scanCache.lastMoversTime = new Date().toISOString();
      }

      // ── Proactive Telegram alerts on urgent setups (squeeze/gap/coil) ──
      const [squeezes, breakouts] = await Promise.all([
        getShortSqueezeSetups().catch(() => []),
        getBreakoutSetups().catch(() => []),
      ]);
      notifyMoverAlerts({ movers: result || [], squeezes, breakouts }).catch(err =>
        console.error('[Cron] Mover alert error:', err.message)
      );
    } catch (err) {
      console.error('[Cron] Movers scan error:', err.message);
    }
  });

  // ── CSP management: every 15 min during market hours ──
  // Profit-closes decayed puts, detects expiry/assignment. Never closes red.
  cron.schedule('*/15 * * * *', async () => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const day = et.getDay();
    if (day < 1 || day > 5 || hour < 9 || hour >= 16) return;
    try {
      const { manageCsps } = await import('./services/optionsTrader.js');
      await manageCsps();
    } catch (err) {
      console.error('[CSP] manage error:', err.message);
    }
  });

  // ── AFTER-HOURS watch: 16:05-20:00 ET weekdays, every 10 min ──
  // Earnings land 16:00-17:30 ET and gaps form after-hours. Alert-only;
  // the morning scan re-evaluates with full signals before any order.
  cron.schedule('*/10 * * * *', async () => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const day = et.getDay();
    const afterHours = day >= 1 && day <= 5 && hour >= 16 && hour < 20;
    if (!afterHours) return;
    if (hour === 16 && et.getMinutes() < 5) return; // let the close settle

    try {
      const { scanAfterHoursMovers, markAlerted } = await import('./services/afterHoursWatch.js');
      const movers = await scanAfterHoursMovers();
      if (movers.length > 0) {
        console.log(`[AfterHours] ${movers.length} movers: ${movers.slice(0, 5).map(m => `${m.symbol}(${m.ahChangePct}%)`).join(', ')}`);
        const sent = await notifyAfterHoursMovers(movers);
        if (sent > 0) markAlerted(movers.slice(0, 5).map(m => m.symbol));
      }
    } catch (err) {
      console.error('[AfterHours] watch error:', err.message);
    }
  });

  // ── Intraday squeeze/mover scan every 5 min during market hours ──
  cron.schedule('*/5 * * * *', async () => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const min = et.getMinutes();
    const day = et.getDay();
    const marketOpen = day >= 1 && day <= 5 && ((hour === 9 && min >= 30) || (hour >= 10 && hour < 16));
    if (!marketOpen) return;

    try {
      const [movers, squeezes, breakouts] = await Promise.all([
        scanPremarketMovers().catch(() => []),
        getShortSqueezeSetups().catch(() => []),
        getBreakoutSetups().catch(() => []),
      ]);
      await notifyMoverAlerts({ movers, squeezes, breakouts });
    } catch (err) {
      console.error('[Cron] Intraday mover alert error:', err.message);
    }
  });

  console.log('[Cron] Background jobs scheduled:');
  console.log('  - Price stream: every 15s (market hours only, when clients connected)');
  console.log('  - Gem scan: every 5m (8 AM - 6 PM ET weekdays)');
  console.log('  - Movers scan: every 3m (4 - 9:30 AM ET pre-market)');
}

// Manual daily-pick run (local diagnostics/retry) — POST /api/daily-pick/run?autoTrade=true
// Loopback-only: this endpoint can place orders; the server listens on 0.0.0.0.
app.post('/api/daily-pick/run', (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'local only' });
}, async (req, res) => {
  try {
    const autoTrade = req.query.autoTrade === 'true';
    const result = await runDailyPicker({ autoTrade, telegramNotifier: sendMessage });
    res.json({
      ok: true,
      picks: result.picks.map(p => ({ symbol: p.symbol, score: p.compositeScore, entry: p.entryPrice })),
      orders: result.orderResults.map(o => ({ symbol: o.symbol, dollar: o.dollarAmount, ok: o.ok, error: o.error || null })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// (React frontend removed 2026-06 — the bot is backend-only: API + Telegram)

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Export app for Vercel
export default app;

// Only listen if not on Vercel (local dev / Railway)
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[StockOracle] Server running on http://0.0.0.0:${PORT}`);
    // Initialize Telegram bot + share scan cache + on-demand scan
    setScanCache(scanCache);
    setOnDemandScan(runQuickScan);
    initTelegramBot();

    // Run strategy calibration 30s after startup (non-blocking background task)
    // Uses backtest engine to score each strategy historically → feeds agent conviction
    const existingCal = getCalibration();
    if (!existingCal) {
      setTimeout(() => {
        runCalibration().catch(err => console.error('[Calibrator] Startup run failed:', err.message));
      }, 30000);
    } else {
      console.log(`[Calibrator] Using cached calibration from ${existingCal.lastCalibrated}`);
    }

    // Re-calibrate every Sunday at 2 AM ET (fresh weekly data)
    cron.schedule('0 2 * * 0', () => {
      runCalibration().catch(err => console.error('[Calibrator] Weekly run failed:', err.message));
    }, { timezone: 'America/New_York' });

    // Refresh Supabase signal attribution + blend into live weights — Sunday 3 AM ET
    cron.schedule('0 3 * * 0', () => {
      try { runBacktestRefresh(); } catch (err) { console.error('[Backtest] Weekly refresh failed:', err.message); }
    }, { timezone: 'America/New_York' });

    // Keep the OHLCV archive CURRENT — extend it forward daily at 4 AM ET. Runs overnight
    // when interactive apps are closed and RAM is free (the 1500-symbol x 10y archive is
    // too large to process while the desktop is in active use). This is the "stay on the
    // same level as the market as days pass" job: backtests always reach today.
    cron.schedule('0 4 * * 1-6', () => {
      try { refreshPriceArchive(); } catch (err) { console.error('[Archive] Daily refresh failed:', err.message); }
    }, { timezone: 'America/New_York' });

    // ── NIGHTLY ROLLING BACKTEST — full 1998→today replay on the fresh archive ──
    // Runs at 5:30 AM ET, after the 4 AM archive refresh has appended yesterday's
    // bars, so every night the backtest window grows by one day. Sends a Telegram
    // summary of how each live strategy performs vs. SPY and the monkey baseline.
    cron.schedule('30 5 * * 2-6', () => {
      try { runNightlyReplay(); } catch (err) { console.error('[Replay] Nightly run failed:', err.message); }
    }, { timezone: 'America/New_York' });

    // ── Weekly analog-table refresh — Sunday 5 AM ET ──
    cron.schedule('0 5 * * 0', () => {
      try { runSetupStats(); } catch (err) { console.error('[SetupStats] weekly run failed:', err.message); }
    }, { timezone: 'America/New_York' });

    // ── Weekly strategy R&D replay — Saturday 6 AM ET ──
    cron.schedule('0 6 * * 6', () => {
      try { runWeeklyRnd(); } catch (err) { console.error('[RnD] weekly run failed:', err.message); }
    }, { timezone: 'America/New_York' });

    // ── Weekly minute-bar refresh + intraday entry-timing stats — Saturday 8 AM ET ──
    cron.schedule('0 8 * * 6', () => {
      try { runMinuteRefresh(); } catch (err) { console.error('[Minute] weekly run failed:', err.message); }
    }, { timezone: 'America/New_York' });

    // ── Weekly macro radar — Sunday 12:00 ET (18:00 Italy) ──
    cron.schedule('0 12 * * 0', () => {
      runMacroRadar().catch(err => console.error('[MacroRadar] failed:', err.message));
    }, { timezone: 'America/New_York' });

    // ── Claude hourly market briefing (weekdays, 8 AM - 4 PM ET) ──
    if (isClaudeConfigured()) {
      cron.schedule('5 8-16 * * 1-5', async () => {
        try {
          // Gather market data for the briefing
          const spyData = await yahooFinance.getQuoteBatch(['SPY', 'QQQ', 'IWM']);
          const marketData = {
            spy: spyData.find(q => q.symbol === 'SPY'),
            qqq: spyData.find(q => q.symbol === 'QQQ'),
            iwm: spyData.find(q => q.symbol === 'IWM'),
            movers: scanCache.movers?.slice(0, 5) || [],
            topGems: scanCache.gems?.slice(0, 3)?.map(g => ({ symbol: g.symbol, gemScore: g.gemScore, consensus: g.consensus })) || [],
          };
          await getMarketBriefing(marketData);
        } catch (err) {
          console.error('[Claude] Briefing error:', err.message);
        }
      }, { timezone: 'America/New_York' });
      console.log('[Claude] AI brain active — hourly briefings + per-stock analysis enabled');

    } else {
      console.log('[Claude] No ANTHROPIC_API_KEY — running rule-based only');
    }

    // Run full gem + penny scan 5s after startup (force=true bypasses mutex)
    setTimeout(async () => {
      console.log('[Startup] Running initial gem scan...');
      try {
        await runQuickScan({ force: true });
      } catch (err) {
        console.error('[Startup] Initial scan failed:', err.message);
      }
    }, 5000);
  });
}
