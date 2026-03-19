import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import apiRoutes from './routes/api.js';
import { scanPremarketMovers } from './services/premarketScanner.js';
import { findTomorrowMovers } from './services/tomorrowMovers.js';
import { analyzeGem } from './services/tradingDesk.js';
import { saveGemSnapshot } from './services/gemHistory.js';
import * as yahooFinance from './services/yahooFinance.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000', 'http://localhost:5174'],
  methods: ['GET', 'POST'],
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
      console.log('[Cron] Running gem scan...');
      const result = await findTomorrowMovers();
      if (result.gems?.length > 0) {
        const gemsWithVerdicts = result.gems.map(gem => {
          const { verdicts, consensus, buyCount, avgConviction } = analyzeGem(gem);
          return { ...gem, verdicts, consensus, buyCount, avgConviction };
        });
        saveGemSnapshot(gemsWithVerdicts).catch(() => {});
        broadcastSSE({
          type: 'gems_update',
          gemsCount: gemsWithVerdicts.length,
          topGems: gemsWithVerdicts.slice(0, 3).map(g => ({
            symbol: g.symbol, gemScore: g.gemScore, consensus: g.consensus,
          })),
          timestamp: new Date().toISOString(),
        });
        console.log(`[Cron] Gem scan complete: ${gemsWithVerdicts.length} gems found`);
      }
    } catch (err) {
      console.error('[Cron] Gem scan error:', err.message);
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
  });
}
