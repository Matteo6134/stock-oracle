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
import { initTelegramBot, setScanCache } from './services/telegram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prevent crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err?.message || err);
});

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

      // Update scan cache
      scanCache.allAnalyzed = allAnalyzed;
      scanCache.lastScanTime = new Date().toISOString();

      // Auto-trader: execute trades for strong consensus picks
      if (allAnalyzed.length > 0) {
        const tradeResult = await processSignals(allAnalyzed);
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
