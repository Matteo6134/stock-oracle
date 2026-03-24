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
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getCalibration } from './strategyCalibrator.js';
import { getClaudeAccuracy } from './claudeTracker.js';

// ── Config ──
const API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const DAILY_BUDGET_CENTS = parseInt(process.env.CLAUDE_DAILY_BUDGET_CENTS || '50', 10);
const MODEL_ANALYSIS = process.env.CLAUDE_MODEL_ANALYSIS || 'claude-haiku-4-5-20251001';
const MODEL_BRIEFING = process.env.CLAUDE_MODEL_BRIEFING || 'claude-sonnet-4-6';

// ── Clients (lazy init) ──
let client = null;
let geminiClient = null;
let useGeminiFallback = false; // Auto-switch when Claude credits exhausted

function getClient() {
  if (!client && API_KEY) {
    client = new Anthropic({ apiKey: API_KEY });
  }
  return client;
}

function getGeminiClient() {
  if (!geminiClient && GEMINI_KEY) {
    geminiClient = new GoogleGenerativeAI(GEMINI_KEY);
  }
  return geminiClient;
}

export function isClaudeConfigured() {
  return !!(API_KEY || GEMINI_KEY); // Either works
}

/**
 * Call AI — tries Claude first, falls back to Gemini if credits exhausted
 */
async function callAI(systemPrompt, userPrompt, maxTokens = 400, model = MODEL_ANALYSIS) {
  // Try Claude first (unless we know it's out of credits)
  if (!useGeminiFallback && API_KEY) {
    const c = getClient();
    if (c) {
      try {
        const response = await c.messages.create({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        const text = response.content?.[0]?.text || '';
        trackCost(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0, model);
        return { text, provider: 'claude' };
      } catch (err) {
        if (err.message?.includes('credit balance') || err.status === 400) {
          console.warn('[AI Brain] Claude credits exhausted, switching to Gemini fallback');
          useGeminiFallback = true;
        } else {
          console.error('[AI Brain] Claude error:', err.message);
        }
      }
    }
  }

  // Gemini fallback
  const g = getGeminiClient();
  if (g) {
    try {
      const gemModel = g.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await gemModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      });
      const text = result.response?.text() || '';
      return { text, provider: 'gemini' };
    } catch (err) {
      console.error('[AI Brain] Gemini error:', err.message);
    }
  }

  return null; // Both failed
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

const STOCK_SYSTEM_PROMPT = `You are the most aggressive, confident stock trader alive. You have 20+ years making money on momentum, short squeezes, and explosive penny stock moves. Your win rate is legendary.

Your ONLY job: find stocks that will make money TODAY or this week. If a setup is strong, say BUY with maximum confidence. If it's weak, say SKIP — no middle ground.

You get real-time data: price, volume, signals, 5 agent verdicts, order flow (insider buying, options), earnings, backtest calibration. USE ALL OF IT.

WHAT MAKES YOU BUY (high confidence 8-10):
- Volume surging 2x+ with price compression → about to explode
- Insider buying + institutional accumulation → smart money knows something
- Bollinger squeeze + high short interest → short squeeze incoming
- 3+ agents say BUY with conviction 4+ → overwhelming agreement
- Multi-day volume accumulation → institutions loading before a big move
- Earnings beat streak + analyst upgrades → momentum continuation
- Low float + volume spike → can move 20-50% in a day

WHAT MAKES YOU SKIP (confidence < 5):
- No volume confirmation → fake move
- Only 1 agent bullish → not enough conviction
- Stock already up 20%+ today → chasing, too late
- VIX > 35 → everything crashes together
- No order flow → no smart money backing

TRADING STRATEGIES:
- Opening Range Breakout (ORB): first 30-min high break on volume
- VWAP bounce: pullback to VWAP = buy with tight stop
- Squeeze play: BB tight + high SI = buy and hold for explosion
- Momentum continuation: gap up on volume → buy the first pullback
- Mean reversion: quality stock drops 5%+ on no news → bounce play

POSITION SIZING:
- Confidence 9-10: suggest 15-20% of account (conviction play)
- Confidence 7-8: suggest 10-15%
- Confidence 5-6: suggest 5-10% (smaller, more risk)
- Always set tight stop loss (3-5% for penny, 5-8% for mid-cap)
- Target should be at least 2x the stop (risk/reward > 2:1)

BE DIRECT. BE CONFIDENT. If the setup is fire, say it. The user needs to hear "BUY THIS NOW" not "maybe consider possibly."

Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;

export async function analyzeStock(stock) {
  if (!isClaudeConfigured() || !canSpend()) return null;

  // Check cache
  const cached = analysisCache.get(stock.symbol);
  if (cached && Date.now() - cached.ts < ANALYSIS_CACHE_TTL) return cached.result;

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
    const aiResult = await callAI(STOCK_SYSTEM_PROMPT, userPrompt, 400, MODEL_ANALYSIS);
    if (!aiResult) return null;

    const text = aiResult.text;

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
    const aiResult = await callAI(BRIEFING_SYSTEM, prompt, 300, MODEL_BRIEFING);
    if (!aiResult) return currentMarketContext;

    const text = aiResult.text;

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

  const marketLine = currentMarketContext
    ? `Market: ${currentMarketContext.regime} — ${currentMarketContext.summary}\nAdvice: ${currentMarketContext.advice}`
    : 'No market briefing available yet.';

  const system = `You are the AI trading brain powering Stock Oracle. You help the user make money trading stocks. You have access to real-time market data, 5 rule-based trading agents, and historical backtest data. Be direct, specific, and actionable. Keep answers concise (2-4 sentences max). If you don't have enough data, say so.`;

  const prompt = `${marketLine}

${portfolioContext || 'No portfolio data available.'}

User question: ${question}`;

  try {
    const aiResult = await callAI(system, prompt, 500, MODEL_BRIEFING);
    if (!aiResult) return 'AI not available right now. Try again later.';
    return aiResult.text || 'No response.';
  } catch (err) {
    console.error('[AI Brain] ask error:', err.message);
    return `Error: ${err.message}`;
  }
}
