import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './routes/api.js';
import { scanPremarketMovers } from './services/premarketScanner.js';
import { findTomorrowMovers } from './services/tomorrowMovers.js';
import { analyzeGem } from './services/tradingDesk.js';
import { saveGemSnapshot } from './services/gemHistory.js';
import * as yahooFinance from './services/yahooFinance.js';
import { scanPennyStocks } from './services/pennyScanner.js';
import { processSignals, checkExitSignals } from './services/autoTrader.js';
import { initTelegramBot, setScanCache, notifyBuyAlerts, notifyNewTrade } from './services/telegram.js';
import { runCalibration, getCalibration } from './services/strategyCalibrator.js';
import { analyzeStock, getMarketBriefing, isClaudeConfigured, getMarketContext } from './services/claudeBrain.js';
import { logPrediction } from './services/claudeTracker.js';
import { getTopMarkets } from './services/polymarket.js';
import { findBestBets } from './services/polyBrain.js';
import { getPortfolio, placeBet, calculateKellyBet, shouldBet, getCategoryMultiplier } from './services/polySimulator.js';
import { getAllIntelligence, getMarketRegime, getSectorRotation } from './services/stockIntel.js';
import { startNewsMonitor, matchNewsToMarkets } from './services/newsEdge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err?.message || err);
});

// ── Scan mutex: prevent overlapping cron jobs from piling up ──
let gemScanRunning = false;
let polyScanRunning = false;

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

app.use(cors({
  origin: true, // Allow all origins — Vercel + Railway + localhost
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());
app.use('/api', apiRoutes);

// ══════════════════════════════════════════
// SSE — Server-Sent Events for real-time data
// ══════════════════════════════════════════
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial heartbeat
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  sseClients.add(res);
  console.log(`[SSE] Client connected (${sseClients.size} total)`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected (${sseClients.size} total)`);
  });

  // Keep alive every 30s
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => clearInterval(keepAlive));
});

function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
}

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
};

if (!process.env.VERCEL) {
  // Track symbols users are watching (populated by SSE connections + API calls)
  const watchedSymbols = new Set([
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD', 'PLTR', 'ARM',
  ]);

  // ── Price refresh every 15 seconds during market hours ──
  cron.schedule('*/15 * * * * *', async () => {
    if (sseClients.size === 0) return; // No listeners, skip

    // Check if US market is open (9:30-16:00 ET, weekdays)
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const min = et.getMinutes();
    const day = et.getDay();
    const marketOpen = day >= 1 && day <= 5 && (hour > 9 || (hour === 9 && min >= 30)) && hour < 16;
    // Also run in pre-market (4-9:30 AM) and after-hours (16-20)
    const extendedHours = day >= 1 && day <= 5 && ((hour >= 4 && hour < 9) || (hour === 9 && min < 30) || (hour >= 16 && hour < 20));

    if (!marketOpen && !extendedHours) return;

    try {
      const symbols = [...watchedSymbols];
      const quotes = await yahooFinance.getQuoteBatch(symbols.slice(0, 30));
      const prices = {};
      for (const q of quotes) {
        if (!q?.symbol) continue;
        prices[q.symbol] = {
          price: q.regularMarketPrice,
          change: q.regularMarketChangePercent,
          volume: q.regularMarketVolume,
          preMarketPrice: q.preMarketPrice,
          preMarketChange: q.preMarketChangePercent,
        };
      }
      broadcastSSE({ type: 'prices', prices, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[Cron] Price refresh error:', err.message);
    }
  });

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
      if (result.gems?.length > 0) {
        const gemsWithVerdicts = result.gems.map(gem => {
          const { verdicts, consensus, buyCount, avgConviction } = analyzeGem(gem);
          return { ...gem, verdicts, consensus, buyCount, avgConviction, source: 'gem' };
        });
        saveGemSnapshot(gemsWithVerdicts).catch(() => {});
        scanCache.gems = gemsWithVerdicts;
        allAnalyzed.push(...gemsWithVerdicts);
        broadcastSSE({
          type: 'gems_update',
          gemsCount: gemsWithVerdicts.length,
          topGems: gemsWithVerdicts.slice(0, 3).map(g => ({
            symbol: g.symbol, gemScore: g.gemScore, consensus: g.consensus,
          })),
          timestamp: new Date().toISOString(),
        });
        console.log(`[Cron] Gem scan: ${gemsWithVerdicts.length} gems found`);
      }

      // Scan penny stocks and run agents on them too
      try {
        const pennyResult = await scanPennyStocks(5);
        if (pennyResult.stocks?.length > 0) {
          const penniesWithVerdicts = pennyResult.stocks.map(stock => {
            const { verdicts, consensus, buyCount, avgConviction } = analyzeGem(stock);
            return { ...stock, verdicts, consensus, buyCount, avgConviction, source: 'penny' };
          });
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

      // Update scan cache
      scanCache.allAnalyzed = allAnalyzed;
      scanCache.lastScanTime = new Date().toISOString();

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

      // ── Proactive Telegram buy alerts (independent of auto-trading) ──
      // Fires for every new strong setup so user can buy manually before it moves
      if (allAnalyzed.length > 0) {
        notifyBuyAlerts(allAnalyzed).catch(err =>
          console.error('[Cron] Buy alert error:', err.message)
        );
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
          }
        }
        if (tradeResult.bought?.length > 0) {
          broadcastSSE({
            type: 'auto_trade',
            trades: tradeResult.bought,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[Cron] Gem scan error:', err.message);
    } finally {
      gemScanRunning = false;
    }
  });

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
        broadcastSSE({
          type: 'movers_update',
          count: result.length,
          topMovers: result.slice(0, 5).map(m => ({
            symbol: m.symbol, gapPct: m.gapPct, volumeRatio: m.volumeRatio,
          })),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[Cron] Movers scan error:', err.message);
    }
  });

  console.log('[Cron] Background jobs scheduled:');
  console.log('  - Price stream: every 15s (market hours only, when clients connected)');
  console.log('  - Gem scan: every 5m (8 AM - 6 PM ET weekdays)');
  console.log('  - Movers scan: every 3m (4 - 9:30 AM ET pre-market)');
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sseClients: sseClients.size,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// ══════════════════════════════════════════
// Serve frontend — only when NOT on Vercel
// (Vercel handles static files + SPA routing via vercel.json)
// ══════════════════════════════════════════
if (!process.env.VERCEL) {
  const distPath = path.join(__dirname, '..', 'dist');
  try {
    const { existsSync } = await import('fs');
    if (existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        if (req.path.startsWith('/api')) {
          return res.status(404).json({ error: 'Not found' });
        }
        res.sendFile(path.join(distPath, 'index.html'));
      });
      console.log('[Server] Serving frontend from dist/');
    }
  } catch {}
}

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
    // Initialize Telegram bot + share scan cache
    setScanCache(scanCache);
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

      // ── Polymarket Oracle: 13-strategy scan every 15 min, auto-bet ──
      cron.schedule('*/15 * * * *', async () => {
        if (polyScanRunning) {
          console.log('[PolyCron] Already running, skipping');
          return;
        }
        polyScanRunning = true;
        try {
          console.log('[PolyCron] Running 13-strategy scan...');
          const markets = await getTopMarkets(30);
          if (markets.length === 0) return;

          // Record prices for momentum tracking
          try {
            const { recordPrices } = await import('./services/polyMomentum.js');
            recordPrices(markets);
          } catch (err) {
            console.error('[PolyCron] Momentum record error:', err.message);
          }
          const rawPicks = await findBestBets(markets);
          // Filter out garbage: NaN prices, NaN edges, missing questions
          const picks = rawPicks.filter(p => {
            if (!p.question || p.question.startsWith('[ARB]') || p.question.startsWith('[WHALE]')) {
              // Clean up question prefix
              if (p.question) p.question = p.question.replace(/^\[(ARB|WHALE|CHAIN)\]\s*/, '');
            }
            if (isNaN(p.edge) || isNaN(p.confidence)) return false;
            if (isNaN(p.marketYesPrice) && isNaN(p.marketNoPrice)) return false;
            // Fix missing price fields
            if (!p.marketYesPrice && p.marketNoPrice) p.marketYesPrice = 1 - p.marketNoPrice;
            if (!p.marketNoPrice && p.marketYesPrice) p.marketNoPrice = 1 - p.marketYesPrice;
            if (!p.realProbability) p.realProbability = p.action === 'BET_YES' ? 0.7 : 0.3;
            return true;
          });
          if (picks.length === 0) { console.log('[PolyCron] No edge found'); return; }

          console.log(`[PolyCron] ${picks.length} valid opportunities (${rawPicks.length} raw)`);
          const portfolio = getPortfolio();

          // Auto-bet rules — each strategy has its own quality gate
          // Claude ONLY bets when the math is right. Not every scan = a bet.
          let betsPlaced = 0;
          for (const pick of picks.slice(0, 5)) {
            let minConf, minEdge, maxSizePct;
            switch (pick.strategy) {
              case 'safe_bet':
                minConf = 6; minEdge = 2; maxSizePct = 30; break;     // Safe: low bar, near-certain
              case 'arbitrage':
              case 'cross_platform_arb':
                minConf = 5; minEdge = 3; maxSizePct = 15; break;     // Arb: near risk-free
              case 'cross_platform_edge':
                minConf = 6; minEdge = 5; maxSizePct = 12; break;     // Cross-plat price gap
              case 'conditional_chain':
                minConf = 7; minEdge = 8; maxSizePct = 10; break;     // Chain: needs confidence
              case 'whale_follow':
                minConf = 6; minEdge = 2; maxSizePct = 8; break;      // Whale: follow smart money
              case 'longshot_sell':
                minConf = 7; minEdge = 10; maxSizePct = 10; break;    // Longshot: still careful
              case 'resolution_snipe':
                minConf = 7; minEdge = 5; maxSizePct = 20; break;     // Snipe: near-certain, bigger bets
              case 'momentum':
                minConf = 7; minEdge = 8; maxSizePct = 10; break;     // Momentum: needs strong signal
              default: // edge_detection
                minConf = 6; minEdge = 8; maxSizePct = 20; break;     // Edge: Claude just needs decent edge
            }

            if (pick.confidence < minConf || Math.abs(pick.edge) < minEdge) continue;

            // Growth phase gate — skip strategies not allowed in current phase
            const phaseCheck = shouldBet(pick, portfolio.balance);
            if (!phaseCheck.allowed) continue;

            // Category accuracy gate — reduce or block bets on bad categories
            const catMult = getCategoryMultiplier(pick.category);
            if (catMult === 0) continue;

            const outcome = pick.action === 'BET_YES' ? 'Yes' : 'No';
            const price = pick.action === 'BET_YES'
              ? (pick.marketYesPrice || 0.5)
              : (pick.marketNoPrice || 0.5);

            if (price <= 0 || price >= 1) continue;

            const amount = calculateKellyBet(
              portfolio.balance, price,
              pick.realProbability || (pick.action === 'BET_YES' ? 0.7 : 0.3),
              maxSizePct
            );
            if (amount < 5 || amount > portfolio.balance) continue;

            const betResult = placeBet({
              marketId: pick.marketId,
              question: pick.question || pick.thesis?.slice(0, 100),
              outcome,
              price,
              amount,
              claudeConfidence: pick.confidence,
              claudeThesis: pick.thesis,
              claudeProb: pick.realProbability || 0.5,
              category: pick.category,
              strategy: pick.strategy,
              daysLeft: pick.daysLeft || pick._daysLeft || null,
            });

            // Send Telegram alert for each auto-bet
            if (betResult.success) {
              betsPlaced++;
              const stratLabels = {
                edge_detection: '\uD83D\uDD0D Edge',
                arbitrage: '\uD83D\uDD04 Arb',
                cross_platform_arb: '\uD83C\uDF10 Cross-Arb',
                cross_platform_edge: '\uD83C\uDF10 Cross-Edge',
                longshot_sell: '\uD83C\uDFB0 Longshot',
                safe_bet: '\uD83D\uDEE1 Safe',
                conditional_chain: '\uD83D\uDD17 Chain',
                whale_follow: '\uD83D\uDC33 Whale',
              };
              const stratLabel = stratLabels[pick.strategy] || pick.strategy;
              const dl = pick.daysLeft || pick._daysLeft;
              const dlStr = dl != null ? `\u23F0 Resolves in ~${Math.round(dl)} days` : '';
              const potentialWin = outcome === 'Yes'
                ? Math.round((amount / price) - amount)
                : Math.round((amount / (1 - price)) - amount);
              const msg = [
                `\uD83E\uDDE0 *AUTO-BET* [${stratLabel}]`,
                '',
                `${pick.action === 'BET_YES' ? '\uD83D\uDFE2' : '\uD83D\uDD34'} *${outcome}* \u2014 "${(pick.question || '').replace(/^\[(ARB|CHAIN|WHALE)\] /, '').slice(0, 60)}"`,
                `\uD83D\uDCB5 *$${Math.round(amount)}* at ${Math.round(price * 100)}\u00A2 \u2192 Win: +$${potentialWin}`,
                `\uD83D\uDCC8 Edge: ${pick.edge}% \u00B7 Conf: ${pick.confidence}/10`,
                dlStr,
                `\uD83D\uDCDD ${(pick.thesis || '').slice(0, 120)}`,
              ].filter(Boolean).join('\n');
              notifyNewTrade(msg).catch(() => {});
            }
          }

          // Report scan result — even if no bets placed
          if (betsPlaced === 0 && picks.length > 0) {
            console.log(`[PolyCron] Found ${picks.length} opportunities but none passed quality gates`);
          } else if (betsPlaced > 0) {
            const p = getPortfolio();
            console.log(`[PolyCron] Placed ${betsPlaced} bets. Balance: $${p.balance.toFixed(2)}, ${p.openPositions.length} positions`);
          }
        } catch (err) {
          console.error('[PolyCron] Scan error:', err.message);
        } finally {
          polyScanRunning = false;
        }
      });
      console.log('[PolyOracle] 11-strategy scanner active — every 15 min');

      // ── News Speed Edge: breaking news triggers immediate poly scan ──
      startNewsMonitor(async (newsItem) => {
        try {
          console.log(`[NewsEdge] BREAKING: ${newsItem.title} (${newsItem.source})`);
          const markets = await getTopMarkets(30);
          if (markets.length === 0) return;

          const matches = matchNewsToMarkets(newsItem, markets);
          if (matches.length === 0) {
            console.log('[NewsEdge] No matching markets for this headline');
            return;
          }

          console.log(`[NewsEdge] ${matches.length} markets affected — running Claude analysis...`);
          const affectedMarkets = matches.map(m => m.market);
          const picks = await findBestBets(affectedMarkets);
          if (picks.length === 0) { console.log('[NewsEdge] No edge found on affected markets'); return; }

          const portfolio = getPortfolio();
          for (const pick of picks.slice(0, 3)) {
            // Growth phase check
            const phaseCheck = shouldBet(pick, portfolio.balance);
            if (!phaseCheck.allowed) { console.log(`[NewsEdge] Skipped: ${phaseCheck.reason}`); continue; }

            const outcome = pick.action === 'BET_YES' ? 'Yes' : 'No';
            const price = pick.action === 'BET_YES'
              ? (pick.marketYesPrice || 0.5)
              : (pick.marketNoPrice || 0.5);
            if (price <= 0 || price >= 1) continue;

            const amount = calculateKellyBet(portfolio.balance, price, pick.realProbability || 0.5, 15);
            if (amount < 5 || amount > portfolio.balance) continue;

            const betResult = placeBet({
              marketId: pick.marketId,
              question: pick.question || pick.thesis?.slice(0, 100),
              outcome, price, amount,
              claudeConfidence: pick.confidence,
              claudeThesis: `[NEWS] ${newsItem.title.slice(0, 80)} — ${(pick.thesis || '').slice(0, 200)}`,
              claudeProb: pick.realProbability || 0.5,
              category: pick.category,
              strategy: pick.strategy,
              daysLeft: pick.daysLeft || null,
            });

            if (betResult.success) {
              const potentialWin = outcome === 'Yes'
                ? Math.round((amount / price) - amount)
                : Math.round((amount / (1 - price)) - amount);
              const msg = [
                `\u26A1 *BREAKING NEWS BET*`,
                '',
                `\uD83D\uDCF0 ${newsItem.title.slice(0, 80)}`,
                `${pick.action === 'BET_YES' ? '\uD83D\uDFE2' : '\uD83D\uDD34'} *${outcome}* — "${(pick.question || '').slice(0, 60)}"`,
                `\uD83D\uDCB5 *$${Math.round(amount)}* at ${Math.round(price * 100)}\u00A2 \u2192 Win: +$${potentialWin}`,
                `\uD83D\uDCC8 Edge: ${pick.edge}% \u00B7 Conf: ${pick.confidence}/10`,
                `\uD83D\uDCDD ${(pick.thesis || '').slice(0, 120)}`,
              ].filter(Boolean).join('\n');
              notifyNewTrade(msg).catch(() => {});
            }
          }
        } catch (err) {
          console.error('[NewsEdge] Callback error:', err.message);
        }
      });
      console.log('[NewsEdge] Breaking news monitor active');

    } else {
      console.log('[Claude] No ANTHROPIC_API_KEY — running rule-based only');
    }

    // Warm up gem + penny cache 15s after start so first page load is fast
    setTimeout(async () => {
      console.log('[Startup] Pre-warming scan cache...');
      try {
        const result = await findTomorrowMovers();
        if (result.gems?.length > 0) {
          const gemsWithVerdicts = result.gems.map(gem => {
            const { verdicts, consensus, buyCount, avgConviction } = analyzeGem(gem);
            return { ...gem, verdicts, consensus, buyCount, avgConviction, source: 'gem' };
          });
          scanCache.gems = gemsWithVerdicts;
          scanCache.allAnalyzed = gemsWithVerdicts;
          scanCache.lastScanTime = new Date().toISOString();
          console.log(`[Startup] Cache warmed: ${gemsWithVerdicts.length} gems`);
        }
      } catch (err) {
        console.warn('[Startup] Warm-up failed (will retry on next cron tick):', err.message);
      }
    }, 15000);
  });
}
