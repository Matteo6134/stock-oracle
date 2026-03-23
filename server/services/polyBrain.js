/**
 * Polymarket AI Brain
 *
 * Claude analyzes prediction markets and finds edge:
 *   marketPrice = what the crowd thinks (e.g. 62%)
 *   claudeEstimate = what Claude thinks after deep analysis (e.g. 80%)
 *   edge = claudeEstimate - marketPrice = 18% → BET
 *
 * Uses Sonnet for deep reasoning about geopolitics, economics, events.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDailySpend, isClaudeConfigured } from './claudeBrain.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6'; // Need deep reasoning for prediction markets

let client = null;
function getClient() {
  if (!client && API_KEY) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

// Cost tracking (shared with claudeBrain via getDailySpend)
let polySpendCents = 0;
const BUDGET_CENTS = parseInt(process.env.CLAUDE_DAILY_BUDGET_CENTS || '50', 10);

function canSpend() {
  const main = getDailySpend();
  return (main.spentCents + polySpendCents) < BUDGET_CENTS;
}

// Cache: don't re-analyze same market within 30 min
const analysisCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

const SYSTEM_PROMPT = `You are the world's best prediction market trader. You made $2M on Polymarket by finding mispriced markets — when the crowd is wrong, you bet against them.

Your edge: you analyze events deeper than anyone. You read between the lines. You understand base rates, historical precedents, and how markets overprice dramatic outcomes.

HOW YOU FIND EDGE:
1. Read the question carefully — what EXACTLY needs to happen?
2. Check the market price (crowd's probability estimate)
3. Estimate the REAL probability based on your analysis
4. If your estimate differs from market by >10% → that's edge → BET

EXAMPLES OF EDGE:
- Market says "X will happen by March 31" at 40¢ → but the deadline is 8 days away and X requires 3 steps → real prob is 15% → BET NO
- Market says "Y wins election" at 55¢ → but polls show 70% and historical accuracy of polls at this stage is 85% → real prob is ~68% → BET YES
- Market says "GDP growth > 3%" at 60¢ → but leading indicators (PMI, jobs, consumer spending) all point to 2.5% → real prob is 30% → BET NO

POSITION SIZING (Kelly Criterion):
- Edge 10-15%: small bet (5-8% of bankroll)
- Edge 15-25%: medium bet (10-15%)
- Edge 25%+: large bet (15-25%)
- NEVER bet more than 25% on one market
- The goal is compound growth: $1,400 → $400,000

WHAT TO AVOID:
- Markets that resolve in 6+ months (too much uncertainty, capital locked)
- Markets with < $50K volume (illiquid, hard to exit)
- Markets at extreme prices (<5¢ or >95¢) — small edge, big risk
- "Meme" markets with no fundamental basis

BE DECISIVE. If you see edge, say BET. If no edge, say SKIP. No middle ground.

Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;

/**
 * Analyze a single Polymarket market for edge.
 */
export async function analyzeMarket(market) {
  if (!isClaudeConfigured() || !canSpend()) return null;

  // Check cache
  const cached = analysisCache.get(market.id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const c = getClient();
  if (!c) return null;

  const daysToResolution = market.endDate
    ? Math.max(0, Math.round((new Date(market.endDate) - new Date()) / (86400000)))
    : null;

  const prompt = `Analyze this Polymarket prediction market:

QUESTION: ${market.question}
DESCRIPTION: ${market.description || 'None'}
CATEGORY: ${market.category || 'Unknown'}
CURRENT PRICE: Yes = ${market.yesPrice}¢ (${Math.round(market.yesPrice * 100)}%), No = ${market.noPrice}¢ (${Math.round(market.noPrice * 100)}%)
VOLUME: $${Math.round(market.volume).toLocaleString()}
LIQUIDITY: $${Math.round(market.liquidity || 0).toLocaleString()}
${daysToResolution !== null ? `RESOLVES IN: ~${daysToResolution} days` : ''}
EVENT: ${market.eventTitle || 'N/A'}

Your bankroll: check the edge. Is the crowd wrong?

Respond with JSON:
{
  "realProbability": 0.0-1.0,
  "edge": number (your prob minus market price, can be negative for BET_NO),
  "action": "BET_YES" | "BET_NO" | "SKIP",
  "confidence": 1-10,
  "thesis": "2-3 sentences: WHY is the market wrong? What does the crowd miss?",
  "suggestedSizePct": 3-25,
  "timeHorizon": "days to expected resolution or price move",
  "riskFactors": ["factor1", "factor2"]
}`;

  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    // Track cost (~$0.01 per Sonnet call)
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    polySpendCents += (inputTokens * 300 + outputTokens * 1500) / 1_000_000;

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const raw = JSON.parse(jsonStr);

    const result = {
      marketId: market.id,
      question: market.question,
      marketYesPrice: market.yesPrice,
      marketNoPrice: market.noPrice,
      realProbability: Math.min(1, Math.max(0, parseFloat(raw.realProbability) || 0.5)),
      edge: Math.round((parseFloat(raw.edge) || 0) * 1000) / 10, // as %
      action: ['BET_YES', 'BET_NO', 'SKIP'].includes(raw.action) ? raw.action : 'SKIP',
      confidence: Math.min(10, Math.max(1, parseInt(raw.confidence) || 5)),
      thesis: String(raw.thesis || '').slice(0, 500),
      suggestedSizePct: Math.min(25, Math.max(3, parseFloat(raw.suggestedSizePct) || 5)),
      timeHorizon: String(raw.timeHorizon || 'unknown').slice(0, 50),
      riskFactors: Array.isArray(raw.riskFactors) ? raw.riskFactors.slice(0, 3).map(String) : [],
      analyzedAt: new Date().toISOString(),
    };

    // Recalculate edge from our data (in case Claude's math is off)
    if (result.action === 'BET_YES') {
      result.edge = Math.round((result.realProbability - market.yesPrice) * 1000) / 10;
    } else if (result.action === 'BET_NO') {
      result.edge = Math.round(((1 - result.realProbability) - market.noPrice) * 1000) / 10;
    }

    analysisCache.set(market.id, { result, ts: Date.now() });

    const actionEmoji = result.action === 'BET_YES' ? '🟢' : result.action === 'BET_NO' ? '🔴' : '⚪';
    console.log(`[PolyBrain] ${actionEmoji} ${result.action} "${market.question.slice(0, 40)}..." — edge ${result.edge}%, conf ${result.confidence}/10`);

    return result;
  } catch (err) {
    console.error('[PolyBrain] analyzeMarket error:', err.message);
    return null;
  }
}

/**
 * Scan top markets and return all with edge.
 * Used by the cron job and Telegram /bet command.
 */
export async function findBestBets(markets) {
  const results = [];

  for (const market of markets.slice(0, 15)) { // max 15 per scan
    const analysis = await analyzeMarket(market);
    if (analysis && analysis.action !== 'SKIP' && Math.abs(analysis.edge) >= 10) {
      results.push(analysis);
    }
  }

  // Sort by edge × confidence (best bets first)
  return results.sort((a, b) => (Math.abs(b.edge) * b.confidence) - (Math.abs(a.edge) * a.confidence));
}
