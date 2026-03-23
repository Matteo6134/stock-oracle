/**
 * Claude AI Trading Brain
 *
 * Three capabilities:
 *   1. analyzeStock()    — deep per-stock analysis (Haiku, ~$0.001/call)
 *   2. getMarketBriefing() — hourly market context (Sonnet, ~$0.01/call)
 *   3. askClaude()       — answer user questions via Telegram (Sonnet)
 *
 * Cost-controlled: daily budget cap, 15-min cache, graceful fallback.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getCalibration } from './strategyCalibrator.js';
import { getClaudeAccuracy } from './claudeTracker.js';

// ── Config ──
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DAILY_BUDGET_CENTS = parseInt(process.env.CLAUDE_DAILY_BUDGET_CENTS || '50', 10);
const MODEL_ANALYSIS = process.env.CLAUDE_MODEL_ANALYSIS || 'claude-haiku-4-5-20251001';
const MODEL_BRIEFING = process.env.CLAUDE_MODEL_BRIEFING || 'claude-sonnet-4-6';

// ── Client (lazy init) ──
let client = null;
function getClient() {
  if (!client && API_KEY) {
    client = new Anthropic({ apiKey: API_KEY });
  }
  return client;
}

export function isClaudeConfigured() {
  return !!API_KEY;
}

// ── Cost tracking ──
let dailySpendCents = 0;
let lastResetDate = '';

function resetIfNewDay() {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  if (today !== lastResetDate) {
    dailySpendCents = 0;
    lastResetDate = today;
  }
}

function trackCost(inputTokens, outputTokens, model) {
  // Approximate pricing per 1M tokens (March 2026)
  const rates = {
    'claude-haiku-4-5-20251001': { input: 100, output: 500 },   // $1/$5 per MTok
    'claude-sonnet-4-6':         { input: 300, output: 1500 },   // $3/$15 per MTok
  };
  const r = rates[model] || rates['claude-haiku-4-5-20251001'];
  const costCents = (inputTokens * r.input + outputTokens * r.output) / 1_000_000;
  dailySpendCents += costCents;
  return costCents;
}

function canSpend() {
  resetIfNewDay();
  return dailySpendCents < DAILY_BUDGET_CENTS;
}

export function getDailySpend() {
  resetIfNewDay();
  return { spentCents: Math.round(dailySpendCents * 100) / 100, budgetCents: DAILY_BUDGET_CENTS };
}

// ── Cache ──
const analysisCache = new Map();  // symbol → { result, ts }
const ANALYSIS_CACHE_TTL = 15 * 60 * 1000; // 15 min

// ── Market context (set by getMarketBriefing, read by analyzeStock) ──
let currentMarketContext = null;
export function getMarketContext() { return currentMarketContext; }

// ── Helper: format stock data for Claude's prompt ──
function formatStockData(stock) {
  const verdictSummary = (stock.verdicts || [])
    .filter(v => v.action !== 'DISABLED')
    .map(v => `${v.emoji} ${v.agent}: ${v.action} (conviction ${v.conviction}/5) — ${v.reasoning}`)
    .join('\n');

  const signalList = (stock.signals || []).map(s => s.replace(/_/g, ' ')).join(', ');

  const calInfo = stock.calibration
    ? `Strategy "${stock.calibration.strategy}" has ${stock.calibration.winRate}% historical win rate, PF ${stock.calibration.profitFactor}`
    : 'No calibration data';

  return `
SYMBOL: ${stock.symbol}
PRICE: $${stock.price} | Change: ${(stock.changePct || 0).toFixed(1)}%
VOLUME RATIO: ${(stock.volumeRatio || 0).toFixed(1)}x (vs 20-day avg)
GEM SCORE: ${stock.gemScore || 0}/100
SOURCE: ${stock.source || 'unknown'}
CONSENSUS: ${stock.consensus} (${stock.buyCount || 0}/5 agents say BUY, avg conviction ${stock.avgConviction || 0})

SIGNALS: ${signalList || 'none'}

AGENT VERDICTS:
${verdictSummary || 'none'}

TECHNICAL DETAILS:
- Volume trend: ${stock.details?.volumeTrend || 'N/A'}
- Smart money score: ${stock.details?.smartMoneyScore || 'N/A'}
- Momentum acceleration: ${stock.details?.momentumAccel || 'N/A'}
- Price compression: ${stock.details?.priceCompression || 'N/A'}
- Volume streak days: ${stock.details?.volumeStreakDays || 'N/A'}
- Closing strength: ${stock.details?.closingStrength || 'N/A'}
- Short % of float: ${stock.details?.shortPercentOfFloat || 'N/A'}%
- Days to cover: ${stock.details?.daysToCover || 'N/A'}

CALIBRATION: ${calInfo}
`.trim();
}

// ═══════════════════════════════════════════════════════════════
// 1. ANALYZE STOCK — Per-stock deep analysis (Haiku)
// ═══════════════════════════════════════════════════════════════

const STOCK_SYSTEM_PROMPT = `You are an elite quantitative trader with 20+ years of experience in momentum trading, short squeezes, mean reversion, and earnings plays. You work at a hedge fund analyzing small-cap and penny stocks ($0.50-$20).

Your job: analyze a stock setup and decide whether to trade it. You get:
- Real-time price and volume data
- Technical signals (volume surges, breakouts, squeeze setups)
- 5 rule-based agent verdicts (Momentum Mike, Squeeze Sarah, Volume Victor, Catalyst Claire, Contrarian Carlos)
- Order flow data (insider buying, options activity, institutional flows)
- Historical backtest calibration data
- Current market context (if available)

TRADING STRATEGIES YOU KNOW:
- Opening Range Breakout (ORB): buy the first 30-min high break on volume
- VWAP deviation: buy pullbacks to VWAP with volume confirmation
- EMA ribbon (8/21/50): enter when short EMAs stack above long, exit on cross
- Volume Profile: buy at high-volume nodes (HVN), targets at low-volume nodes (LVN)
- Squeeze plays: Bollinger Band compression + high short interest = explosive move
- Mean reversion: oversold quality stocks bouncing off support
- Momentum continuation: gap-up on volume → flag → continuation

RISK MANAGEMENT RULES:
- Never risk more than 20% of account on one trade
- Penny stocks (<$5): max 10% position size
- Always set stop loss — no exceptions
- If VIX > 30: reduce all position sizes by 50%
- If 3+ consecutive losses: pause trading, re-evaluate

Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;

export async function analyzeStock(stock) {
  if (!isClaudeConfigured() || !canSpend()) return null;

  // Check cache
  const cached = analysisCache.get(stock.symbol);
  if (cached && Date.now() - cached.ts < ANALYSIS_CACHE_TTL) return cached.result;

  const c = getClient();
  if (!c) return null;

  const marketLine = currentMarketContext
    ? `\nMARKET CONTEXT: ${currentMarketContext.regime} — ${currentMarketContext.summary}`
    : '';

  const accuracy = getClaudeAccuracy();
  const accuracyLine = accuracy.totalCalls > 5
    ? `\nYOUR RECENT ACCURACY: ${accuracy.winRate}% win rate on ${accuracy.totalCalls} calls. Avg confidence on wins: ${accuracy.avgConfWin}, on losses: ${accuracy.avgConfLoss}.`
    : '';

  const userPrompt = `Analyze this stock setup and decide whether to trade it.
${formatStockData(stock)}${marketLine}${accuracyLine}

Respond with JSON:
{
  "action": "BUY" | "SKIP",
  "confidence": 1-10,
  "thesis": "2-3 sentence explanation of why to buy or skip",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "suggestedSizePct": 5-15,
  "targetPct": number,
  "stopPct": number,
  "timeframeDays": number,
  "warnings": ["risk factor 1", "risk factor 2"]
}`;

  try {
    const response = await c.messages.create({
      model: MODEL_ANALYSIS,
      max_tokens: 400,
      system: STOCK_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0]?.text || '';
    trackCost(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0, MODEL_ANALYSIS);

    // Parse JSON from response (handle possible markdown wrapping)
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    // Validate required fields
    const validated = {
      action: ['BUY', 'SKIP'].includes(result.action) ? result.action : 'SKIP',
      confidence: Math.min(10, Math.max(1, parseInt(result.confidence) || 5)),
      thesis: String(result.thesis || 'No thesis provided').slice(0, 500),
      riskLevel: ['LOW', 'MEDIUM', 'HIGH'].includes(result.riskLevel) ? result.riskLevel : 'MEDIUM',
      suggestedSizePct: Math.min(20, Math.max(3, parseFloat(result.suggestedSizePct) || 10)),
      targetPct: Math.min(100, Math.max(1, parseFloat(result.targetPct) || 10)),
      stopPct: Math.min(25, Math.max(2, parseFloat(result.stopPct) || 5)),
      timeframeDays: Math.min(30, Math.max(1, parseInt(result.timeframeDays) || 5)),
      warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 5).map(String) : [],
    };

    analysisCache.set(stock.symbol, { result: validated, ts: Date.now() });
    console.log(`[ClaudeBrain] ${stock.symbol}: ${validated.action} (conf ${validated.confidence}/10) — "${validated.thesis.slice(0, 80)}..."`);
    return validated;
  } catch (err) {
    console.error('[ClaudeBrain] analyzeStock error:', err.message);
    return null; // graceful fallback — rule-based agents handle it
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. MARKET BRIEFING — Hourly market context (Sonnet)
// ═══════════════════════════════════════════════════════════════

const BRIEFING_SYSTEM = `You are a senior market strategist providing a concise hourly briefing. Analyze the data and classify the market regime. Be direct and actionable. Respond ONLY with valid JSON.`;

export async function getMarketBriefing(marketData) {
  if (!isClaudeConfigured() || !canSpend()) return currentMarketContext;

  const c = getClient();
  if (!c) return currentMarketContext;

  const calibration = getCalibration();
  const calLine = calibration
    ? `Strategy calibration: ${Object.entries(calibration).filter(([k]) => k !== 'lastCalibrated').map(([s, d]) => `${s}=${d.winRate}%WR`).join(', ')}`
    : '';

  const prompt = `Hourly market briefing. Data:
${JSON.stringify(marketData, null, 2)}
${calLine}

Respond with JSON:
{
  "regime": "RISK_ON" | "CAUTIOUS" | "RISK_OFF",
  "summary": "1-2 sentence market summary",
  "hotSectors": ["sector1", "sector2"],
  "coldSectors": ["sector1"],
  "advice": "1 sentence actionable advice for today",
  "positionSizeMultiplier": 0.5-1.5
}`;

  try {
    const response = await c.messages.create({
      model: MODEL_BRIEFING,
      max_tokens: 300,
      system: BRIEFING_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    trackCost(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0, MODEL_BRIEFING);

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    currentMarketContext = {
      regime: ['RISK_ON', 'CAUTIOUS', 'RISK_OFF'].includes(result.regime) ? result.regime : 'CAUTIOUS',
      summary: String(result.summary || '').slice(0, 300),
      hotSectors: Array.isArray(result.hotSectors) ? result.hotSectors.slice(0, 5) : [],
      coldSectors: Array.isArray(result.coldSectors) ? result.coldSectors.slice(0, 5) : [],
      advice: String(result.advice || '').slice(0, 200),
      positionSizeMultiplier: Math.min(1.5, Math.max(0.3, parseFloat(result.positionSizeMultiplier) || 1)),
      timestamp: new Date().toISOString(),
    };

    console.log(`[ClaudeBrain] Market: ${currentMarketContext.regime} — ${currentMarketContext.summary.slice(0, 60)}`);
    return currentMarketContext;
  } catch (err) {
    console.error('[ClaudeBrain] briefing error:', err.message);
    return currentMarketContext; // keep last known context
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. ASK CLAUDE — Telegram /ask command (Sonnet)
// ═══════════════════════════════════════════════════════════════

const askRateLimit = { count: 0, resetTs: 0 };
const MAX_ASKS_PER_HOUR = 10;

export async function askClaude(question, portfolioContext) {
  if (!isClaudeConfigured()) return 'Claude AI is not configured. Add ANTHROPIC_API_KEY to .env.';
  if (!canSpend()) return 'Daily AI budget reached. Rule-based agents are still active.';

  // Rate limit
  const now = Date.now();
  if (now > askRateLimit.resetTs) {
    askRateLimit.count = 0;
    askRateLimit.resetTs = now + 60 * 60 * 1000;
  }
  if (askRateLimit.count >= MAX_ASKS_PER_HOUR) {
    return `Rate limit: max ${MAX_ASKS_PER_HOUR} questions per hour. Try again later.`;
  }
  askRateLimit.count++;

  const c = getClient();
  if (!c) return 'Claude AI client not available.';

  const marketLine = currentMarketContext
    ? `Market: ${currentMarketContext.regime} — ${currentMarketContext.summary}\nAdvice: ${currentMarketContext.advice}`
    : 'No market briefing available yet.';

  const system = `You are Claude, the AI trading brain powering Stock Oracle. You help the user make money trading stocks. You have access to real-time market data, 5 rule-based trading agents, and historical backtest data. Be direct, specific, and actionable. Keep answers concise (2-4 sentences max). If you don't have enough data, say so.`;

  const prompt = `${marketLine}

${portfolioContext || 'No portfolio data available.'}

User question: ${question}`;

  try {
    const response = await c.messages.create({
      model: MODEL_BRIEFING,
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: prompt }],
    });

    trackCost(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0, MODEL_BRIEFING);
    return response.content[0]?.text || 'No response.';
  } catch (err) {
    console.error('[ClaudeBrain] ask error:', err.message);
    return `Error: ${err.message}`;
  }
}
