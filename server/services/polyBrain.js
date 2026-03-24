/**
 * Polymarket AI Brain — Advanced Strategy Engine
 *
 * 6 strategies based on research from real profitable traders:
 *
 * 1. EDGE DETECTION — Claude estimates real probability vs market price
 * 2. CORRELATED MARKET ARBITRAGE — find pricing inconsistencies between related markets
 * 3. LONGSHOT OVERPRICING — sell outcomes retail overpays for
 * 4. NEAR-EXPIRY SAFE BETS — stack 95%+ probability markets for guaranteed returns
 * 5. NEWS SPEED EDGE — analyze breaking news before market reprices
 * 6. CATEGORY ACCURACY — only bet where Claude has proven edge
 *
 * Research sources:
 *   - Bot 0x8dxd: $313 → $438K (crypto latency arb)
 *   - French Whale: $30M → $85M (private polls + conviction)
 *   - Claude AI agent: 1,322% return in 48 hours documented
 *   - 92.4% of wallets lose → our edge MUST be real
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getDailySpend, isClaudeConfigured } from './claudeBrain.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const GEMINI_MODEL = 'gemini-2.0-flash';

let client = null;
function getClient() {
  if (!client && API_KEY) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

let geminiClient = null;
function getGemini() {
  if (!geminiClient && GEMINI_KEY) {
    geminiClient = new GoogleGenerativeAI(GEMINI_KEY);
  }
  return geminiClient;
}

export function isGeminiConfigured() { return !!GEMINI_KEY; }

// Cost tracking
let polySpendCents = 0;
const BUDGET_CENTS = parseInt(process.env.CLAUDE_DAILY_BUDGET_CENTS || '50', 10);

function canSpend() {
  const main = getDailySpend();
  return (main.spentCents + polySpendCents) < BUDGET_CENTS;
}

// Analysis cache: don't re-analyze same market within 30 min
const analysisCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// Previous scan data for whale detection (volume deltas)
let _prevScanMarkets = [];

// ── Category accuracy tracking (persists in memory, resets on restart) ──
// category → { bets: number, wins: number, totalEdge: number }
const categoryStats = new Map();

export function getCategoryStats() {
  const stats = {};
  for (const [cat, s] of categoryStats) {
    stats[cat] = {
      ...s,
      winRate: s.bets > 0 ? Math.round((s.wins / s.bets) * 100) : 0,
      avgEdge: s.bets > 0 ? Math.round((s.totalEdge / s.bets) * 10) / 10 : 0,
    };
  }
  return stats;
}

export function recordCategoryResult(category, won, edge) {
  const cat = (category || 'Other').toLowerCase();
  if (!categoryStats.has(cat)) categoryStats.set(cat, { bets: 0, wins: 0, totalEdge: 0 });
  const s = categoryStats.get(cat);
  s.bets++;
  if (won) s.wins++;
  s.totalEdge += Math.abs(edge || 0);
}

// ── Confidence multiplier based on category track record ──
function getCategoryMultiplier(category) {
  const cat = (category || 'Other').toLowerCase();
  const s = categoryStats.get(cat);
  if (!s || s.bets < 3) return 1.0; // Not enough data yet
  const wr = s.wins / s.bets;
  if (wr >= 0.7) return 1.3;  // Proven edge — bet bigger
  if (wr >= 0.55) return 1.0;  // Decent — normal sizing
  if (wr >= 0.4) return 0.6;   // Below average — bet smaller
  return 0.3; // Bad track record — tiny bets only
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 1: EDGE DETECTION (core — Claude probability analysis)
// ══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are the world's best prediction market analyst. You've studied how the French Whale made $85M on Polymarket using private polls, how bots turned $313 into $438K via arbitrage, and how 92.4% of wallets LOSE money.

You WIN because you do what the crowd doesn't:
1. Decompose questions into sub-probabilities (chain rule)
2. Use base rates and reference class forecasting
3. Detect when markets are anchored to stale information
4. Identify correlated events the market prices independently
5. Understand time decay and deadline pressure

PROBABILITY ESTIMATION METHOD (Superforecaster approach):
1. Start with the base rate (how often does this type of event happen historically?)
2. Adjust for specific evidence (polls, news, trends, expert opinion)
3. Consider the "other side" — why might the market be RIGHT?
4. Estimate final probability as a precise number, not a range
5. If genuinely uncertain, your probability should be CLOSE to market (= no bet)

EDGE CALCULATION:
- edge = |your probability - market price|
- Minimum edge to bet: 10% (0.10)
- If market says 60% and you think 60-65%, that's NOT enough edge → SKIP
- If market says 60% and you think 80%, that's 20% edge → BET

CRITICAL RULES:
- NEVER bet on markets resolving in 6+ months (capital locked, too uncertain)
- NEVER bet > 25% of bankroll on any single market
- Prefer markets with > $100K volume (liquidity matters for exits)
- Markets at extreme prices (<5¢ or >95¢): only bet if expiry < 7 days (safe income)
- If a market just had breaking news, the price may already reflect it → check carefully

POSITION SIZING (Modified Kelly):
- Edge 10-15%: bet 5-8% of bankroll
- Edge 15-25%: bet 10-15% of bankroll
- Edge 25%+: bet 15-25% of bankroll
- High-confidence SAFE bets (>95% markets near expiry): up to 30%

THE GOAL: Compound $1,400 to $400,000. This requires ~286x. You need consistent 5-15% returns per bet with minimal losses. Quality over quantity — skip marginal bets.

Respond ONLY with valid JSON. No markdown, no explanation outside JSON.`;

// ══════════════════════════════════════════════════════════════
// MULTI-MODEL ENSEMBLE — Claude + Gemini
// ══════════════════════════════════════════════════════════════

/**
 * Get Gemini's probability estimate for the same market.
 * Used as a "second opinion" — when both models agree, confidence goes UP.
 * When they disagree, we bet smaller or skip.
 */
async function getGeminiEstimate(market) {
  const g = getGemini();
  if (!g) return null;

  try {
    const model = g.getGenerativeModel({ model: GEMINI_MODEL });

    const daysLeft = market.endDate
      ? Math.max(0, Math.round((new Date(market.endDate) - new Date()) / 86400000))
      : null;

    const prompt = `You are a prediction market analyst. Estimate the REAL probability of this outcome.

QUESTION: ${market.question}
CATEGORY: ${market.category || 'Unknown'}
CURRENT MARKET PRICE: ${Math.round(market.yesPrice * 100)}% Yes
VOLUME: $${Math.round(market.volume).toLocaleString()}
${daysLeft !== null ? `DAYS TO RESOLUTION: ${daysLeft}` : ''}

Think step by step:
1. What is the historical base rate?
2. What current evidence shifts that?
3. Your final probability estimate?

Respond with ONLY valid JSON:
{"realProbability": 0.XX, "confidence": 1-10, "reasoning": "one sentence"}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      model: 'gemini',
      realProbability: Math.min(1, Math.max(0, parseFloat(parsed.realProbability) || 0.5)),
      confidence: Math.min(10, Math.max(1, parseInt(parsed.confidence) || 5)),
      reasoning: String(parsed.reasoning || '').slice(0, 200),
    };
  } catch (err) {
    console.error('[PolyBrain] Gemini error:', err.message);
    return null;
  }
}

/**
 * Combine Claude + Gemini estimates into ensemble prediction.
 * When models agree → higher confidence, bigger bets.
 * When models disagree → lower confidence, smaller bets or skip.
 */
function ensemblePrediction(claudeResult, geminiResult) {
  if (!geminiResult) return claudeResult; // Gemini unavailable, use Claude alone

  const claudeProb = claudeResult.realProbability;
  const geminiProb = geminiResult.realProbability;
  const diff = Math.abs(claudeProb - geminiProb);

  // Weighted average: Claude 60%, Gemini 40% (Claude is stronger on reasoning)
  const ensembleProb = Math.round((claudeProb * 0.6 + geminiProb * 0.4) * 1000) / 1000;

  // Agreement bonus/penalty
  let confidenceAdjust = 0;
  if (diff < 0.05) confidenceAdjust = 2;       // Strong agreement → +2 confidence
  else if (diff < 0.10) confidenceAdjust = 1;   // Moderate agreement → +1
  else if (diff < 0.15) confidenceAdjust = 0;    // Mild disagreement → no change
  else if (diff < 0.25) confidenceAdjust = -1;   // Disagreement → -1
  else confidenceAdjust = -3;                     // Strong disagreement → -3 (likely skip)

  const ensembleConf = Math.min(10, Math.max(1, claudeResult.confidence + confidenceAdjust));

  // If models disagree on DIRECTION (one says >50%, other <50%), skip
  const claudeDirection = claudeProb > 0.5 ? 'YES' : 'NO';
  const geminiDirection = geminiProb > 0.5 ? 'YES' : 'NO';
  const directionalDisagree = claudeDirection !== geminiDirection && diff > 0.15;

  return {
    ...claudeResult,
    realProbability: ensembleProb,
    confidence: directionalDisagree ? Math.min(4, ensembleConf) : ensembleConf,
    action: directionalDisagree ? 'SKIP' : claudeResult.action,
    ensemble: {
      claude: { prob: claudeProb, conf: claudeResult.confidence },
      gemini: { prob: geminiProb, conf: geminiResult.confidence, reasoning: geminiResult.reasoning },
      agreement: diff < 0.10 ? 'STRONG' : diff < 0.20 ? 'MODERATE' : 'WEAK',
      diff: Math.round(diff * 1000) / 10,
      directionalDisagree,
    },
    thesis: claudeResult.thesis + (geminiResult.reasoning
      ? `\n\nGemini ${diff < 0.10 ? 'agrees' : 'says'}: ${geminiResult.reasoning}`
      : ''),
  };
}

/**
 * Analyze a single Polymarket market for edge.
 * Uses Claude as primary, Gemini as second opinion (ensemble).
 */
export async function analyzeMarket(market) {
  if (!isClaudeConfigured() || !canSpend()) return null;

  // Check cache
  const cached = analysisCache.get(market.id);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const c = getClient();
  if (!c) return null;

  const daysToResolution = market.endDate
    ? Math.max(0, Math.round((new Date(market.endDate) - new Date()) / 86400000))
    : null;

  // Include category stats if we have them
  const catMultiplier = getCategoryMultiplier(market.category);
  const catStatsStr = categoryStats.size > 0
    ? `\nYOUR TRACK RECORD BY CATEGORY:\n${JSON.stringify(getCategoryStats(), null, 2)}`
    : '';

  const prompt = `Analyze this Polymarket prediction market:

QUESTION: ${market.question}
DESCRIPTION: ${market.description || 'None'}
CATEGORY: ${market.category || 'Unknown'}
CURRENT PRICE: Yes = ${market.yesPrice} (${Math.round(market.yesPrice * 100)}%), No = ${market.noPrice} (${Math.round(market.noPrice * 100)}%)
VOLUME: $${Math.round(market.volume).toLocaleString()}
LIQUIDITY: $${Math.round(market.liquidity || 0).toLocaleString()}
${daysToResolution !== null ? `RESOLVES IN: ~${daysToResolution} days` : ''}
EVENT: ${market.eventTitle || 'N/A'}
${catStatsStr}

STEP-BY-STEP analysis required:
1. What is the BASE RATE for this type of event?
2. What specific evidence adjusts that base rate?
3. What is your estimated REAL probability?
4. How does that compare to market price?
5. Is there enough edge (>10%) to bet?

Respond with JSON:
{
  "baseRate": 0.0-1.0,
  "adjustedProb": 0.0-1.0,
  "realProbability": 0.0-1.0,
  "edge": number,
  "action": "BET_YES" | "BET_NO" | "SKIP",
  "confidence": 1-10,
  "thesis": "2-3 sentences: WHY is the market wrong? What does the crowd miss?",
  "suggestedSizePct": 3-25,
  "timeHorizon": "days to expected resolution",
  "riskFactors": ["factor1", "factor2"],
  "strategy": "edge_detection" | "safe_bet" | "longshot_sell"
}`;

  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    polySpendCents += (inputTokens * 300 + outputTokens * 1500) / 1_000_000;

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const raw = JSON.parse(jsonStr);

    const result = {
      marketId: market.id,
      question: market.question,
      category: market.category || 'Other',
      marketYesPrice: market.yesPrice,
      marketNoPrice: market.noPrice,
      baseRate: Math.min(1, Math.max(0, parseFloat(raw.baseRate) || 0.5)),
      realProbability: Math.min(1, Math.max(0, parseFloat(raw.realProbability) || 0.5)),
      edge: 0,
      action: ['BET_YES', 'BET_NO', 'SKIP'].includes(raw.action) ? raw.action : 'SKIP',
      confidence: Math.min(10, Math.max(1, parseInt(raw.confidence) || 5)),
      thesis: String(raw.thesis || '').slice(0, 500),
      suggestedSizePct: Math.min(25, Math.max(3, parseFloat(raw.suggestedSizePct) || 5)),
      timeHorizon: String(raw.timeHorizon || 'unknown').slice(0, 50),
      riskFactors: Array.isArray(raw.riskFactors) ? raw.riskFactors.slice(0, 3).map(String) : [],
      strategy: raw.strategy || 'edge_detection',
      categoryMultiplier: catMultiplier,
      analyzedAt: new Date().toISOString(),
    };

    // Recalculate edge from our data (don't trust Claude's math)
    if (result.action === 'BET_YES') {
      result.edge = Math.round((result.realProbability - market.yesPrice) * 1000) / 10;
    } else if (result.action === 'BET_NO') {
      result.edge = Math.round(((1 - result.realProbability) - market.noPrice) * 1000) / 10;
    }

    // Apply category multiplier to sizing
    result.suggestedSizePct = Math.round(result.suggestedSizePct * catMultiplier * 10) / 10;
    result.suggestedSizePct = Math.min(25, Math.max(3, result.suggestedSizePct));

    // ── ENSEMBLE: Get Gemini's second opinion ──
    let finalResult = result;
    if (isGeminiConfigured() && result.action !== 'SKIP') {
      const geminiEst = await getGeminiEstimate(market);
      if (geminiEst) {
        finalResult = ensemblePrediction(result, geminiEst);
        // Recalculate edge with ensemble probability
        if (finalResult.action === 'BET_YES') {
          finalResult.edge = Math.round((finalResult.realProbability - market.yesPrice) * 1000) / 10;
        } else if (finalResult.action === 'BET_NO') {
          finalResult.edge = Math.round(((1 - finalResult.realProbability) - market.noPrice) * 1000) / 10;
        }
        const agr = finalResult.ensemble?.agreement || '?';
        console.log(`[PolyBrain] Ensemble: Claude ${Math.round(result.realProbability * 100)}% / Gemini ${Math.round(geminiEst.realProbability * 100)}% => ${Math.round(finalResult.realProbability * 100)}% (${agr})`);
      }
    }

    analysisCache.set(market.id, { result: finalResult, ts: Date.now() });

    const emoji = finalResult.action === 'BET_YES' ? '\uD83D\uDFE2' : finalResult.action === 'BET_NO' ? '\uD83D\uDD34' : '\u26AA';
    console.log(`[PolyBrain] ${emoji} ${finalResult.action} "${market.question.slice(0, 40)}..." — edge ${finalResult.edge}%, conf ${finalResult.confidence}/10, strat: ${finalResult.strategy}`);

    return finalResult;
  } catch (err) {
    console.error('[PolyBrain] analyzeMarket error:', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 2: CORRELATED MARKET ARBITRAGE
// ══════════════════════════════════════════════════════════════

/**
 * Find correlated markets with pricing inconsistencies.
 * Example: "Trump wins GOP" at 37% but "Trump wins general" at 20%
 *   → If Trump wins general, he MUST have won GOP → general can't be > GOP
 *   → If general is underpriced relative to GOP, that's arb
 *
 * @param {Array} markets - All active markets
 * @returns {Array} Arbitrage opportunities
 */
export function findCorrelatedArbitrage(markets) {
  const opportunities = [];

  // Group markets by event
  const eventGroups = new Map();
  for (const m of markets) {
    const key = m.eventTitle || m.eventSlug || '';
    if (!key) continue;
    if (!eventGroups.has(key)) eventGroups.set(key, []);
    eventGroups.get(key).push(m);
  }

  // Within each event group, check for REAL inconsistencies only
  for (const [event, group] of eventGroups) {
    if (group.length < 2) continue;

    // NOTE: We intentionally do NOT do "sum < 100% → buy cheapest" anymore.
    // Groups with many candidates (elections) naturally sum to <100% due to vigorish.
    // Buying 1¢ longshots (LeBron for president) is NOT +EV — it's throwing money away.
    //
    // We only look for REAL inconsistencies: implied probability violations.

    // Cross-market implied probability check
    // If "X wins primary" = 40% but "X wins general" = 50%, that's inconsistent
    // (can't win general without winning primary, so general ≤ primary)
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        // Check if one question implies the other
        const aQ = a.question.toLowerCase();
        const bQ = b.question.toLowerCase();

        // Simple heuristic: same person, "nomination" vs "election"
        const aIsNom = aQ.includes('nominat');
        const bIsElect = bQ.includes('election') || bQ.includes('president');
        const bIsNom = bQ.includes('nominat');
        const aIsElect = aQ.includes('election') || aQ.includes('president');

        if (aIsNom && bIsElect && b.yesPrice > a.yesPrice + 0.05) {
          opportunities.push({
            type: 'implied_inconsistency',
            markets: [
              { question: a.question, yesPrice: a.yesPrice, id: a.id, role: 'prerequisite' },
              { question: b.question, yesPrice: b.yesPrice, id: b.id, role: 'dependent' },
            ],
            edge: Math.round((b.yesPrice - a.yesPrice) * 100),
            thesis: `"${b.question.slice(0, 50)}" at ${Math.round(b.yesPrice * 100)}% can't be higher than "${a.question.slice(0, 50)}" at ${Math.round(a.yesPrice * 100)}% — winning the general requires winning the primary.`,
          });
        } else if (bIsNom && aIsElect && a.yesPrice > b.yesPrice + 0.05) {
          opportunities.push({
            type: 'implied_inconsistency',
            markets: [
              { question: b.question, yesPrice: b.yesPrice, id: b.id, role: 'prerequisite' },
              { question: a.question, yesPrice: a.yesPrice, id: a.id, role: 'dependent' },
            ],
            edge: Math.round((a.yesPrice - b.yesPrice) * 100),
            thesis: `"${a.question.slice(0, 50)}" at ${Math.round(a.yesPrice * 100)}% can't be higher than "${b.question.slice(0, 50)}" at ${Math.round(b.yesPrice * 100)}%.`,
          });
        }
      }
    }
  }

  return opportunities.sort((a, b) => b.edge - a.edge);
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 3: LONGSHOT OVERPRICING
// ══════════════════════════════════════════════════════════════

/**
 * Find markets where low-probability outcomes are overpriced.
 * Research: retail pays 15¢ for outcomes worth 3¢ in <$100K volume markets.
 *
 * We look for: market price 5-20%, low volume, Claude thinks real prob is much lower.
 */
export function findOverpricedLongshots(markets) {
  const now = new Date();
  return markets.filter(m => {
    // Skip markets resolving > 60 days out
    if (m.endDate) {
      const daysLeft = (new Date(m.endDate) - now) / 86400000;
      if (daysLeft > 60 || daysLeft < 0) return false;
    }
    // Yes side is a longshot (5-20%)
    const isLongshotYes = m.yesPrice >= 0.05 && m.yesPrice <= 0.20;
    // No side is a longshot (80-95% yes = 5-20% no)
    const isLongshotNo = m.noPrice >= 0.05 && m.noPrice <= 0.20;
    // Low volume = more mispricing
    const lowVolume = m.volume < 200000;

    return (isLongshotYes || isLongshotNo) && lowVolume;
  }).map(m => ({
    ...m,
    strategy: 'longshot_sell',
    longshotSide: m.yesPrice <= 0.20 ? 'Yes' : 'No',
    longshotPrice: m.yesPrice <= 0.20 ? m.yesPrice : m.noPrice,
  }));
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 4: NEAR-EXPIRY SAFE BETS
// ══════════════════════════════════════════════════════════════

/**
 * Find markets near expiry with very high/low probability.
 * These are "safe income" — small return but near-certain.
 *
 * Example: "Will X happen by tomorrow?" at 97¢ → buy Yes for 3% return in 1 day.
 */
export function findSafeBets(markets) {
  const now = new Date();
  return markets.filter(m => {
    if (!m.endDate) return false;
    const daysLeft = Math.max(0, (new Date(m.endDate) - now) / 86400000);
    if (daysLeft > 7) return false; // Only near-expiry

    // Price near extreme = high confidence market
    const isHighConfYes = m.yesPrice >= 0.92;
    const isHighConfNo = m.noPrice >= 0.92;
    // Need decent volume
    const hasVolume = m.volume >= 50000;

    return (isHighConfYes || isHighConfNo) && hasVolume;
  }).map(m => {
    const betSide = m.yesPrice >= 0.92 ? 'Yes' : 'No';
    const price = betSide === 'Yes' ? m.yesPrice : m.noPrice;
    const returnPct = Math.round(((1 / price) - 1) * 1000) / 10;
    const daysLeft = Math.max(0.1, (new Date(m.endDate) - now) / 86400000);
    const annualized = Math.round((returnPct / daysLeft) * 365 * 10) / 10;

    return {
      ...m,
      strategy: 'safe_bet',
      betSide,
      price,
      returnPct,
      daysLeft: Math.round(daysLeft * 10) / 10,
      annualizedReturn: annualized,
    };
  }).sort((a, b) => b.annualizedReturn - a.annualizedReturn);
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 5: NEWS SPEED EDGE (via Claude)
// ══════════════════════════════════════════════════════════════

/**
 * Analyze a breaking news event against related markets.
 * Call this when a news alert fires — Claude evaluates how it changes probabilities
 * faster than the market can reprice.
 *
 * @param {string} newsHeadline - Breaking news text
 * @param {Array} relatedMarkets - Markets that might be affected
 */
export async function analyzeNewsImpact(newsHeadline, relatedMarkets) {
  if (!isClaudeConfigured() || !canSpend()) return null;

  const c = getClient();
  if (!c) return null;

  const marketsStr = relatedMarkets.slice(0, 5).map(m =>
    `- "${m.question}" @ Yes=${Math.round(m.yesPrice * 100)}%, Vol=$${Math.round(m.volume).toLocaleString()}`
  ).join('\n');

  const prompt = `BREAKING NEWS: "${newsHeadline}"

These Polymarket markets may be affected:
${marketsStr}

For EACH market, estimate:
1. How does this news change the probability?
2. Has the market already repriced (is the current price already reflecting this)?
3. Is there a tradeable edge RIGHT NOW before others react?

Respond with JSON:
{
  "impacts": [
    {
      "question": "...",
      "oldProb": 0.XX,
      "newProb": 0.XX,
      "alreadyPriced": true/false,
      "action": "BET_YES" | "BET_NO" | "SKIP",
      "urgency": "immediate" | "wait" | "none",
      "thesis": "..."
    }
  ]
}`;

  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: 'You are an expert news trader. You analyze breaking news and immediately identify which prediction markets are mispriced. Speed is everything — the market reprices within minutes. Be decisive.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    polySpendCents += ((response.usage?.input_tokens || 0) * 300 + (response.usage?.output_tokens || 0) * 1500) / 1_000_000;

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[PolyBrain] analyzeNewsImpact error:', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 6: CONDITIONAL PROBABILITY CHAINS
// ══════════════════════════════════════════════════════════════

/**
 * Find downstream markets affected by a high-confidence bet.
 *
 * If Claude is very confident about Market A, what other markets
 * does that imply? Bet those BEFORE the market catches up.
 *
 * Example: If Claude thinks "Fed cuts rates in June" = 80% (market says 55%),
 * then "S&P hits 6000 by July" probably underpriced too.
 *
 * @param {Array} allAnalyzed - Markets already analyzed with Claude verdicts
 * @param {Array} allMarkets - All available markets
 */
export async function findConditionalChains(allAnalyzed, allMarkets) {
  if (!isClaudeConfigured() || !canSpend()) return [];

  // Only chain from high-confidence picks (conf >= 8)
  const anchors = allAnalyzed.filter(a =>
    a.action !== 'SKIP' && a.confidence >= 8 && Math.abs(a.edge) >= 15
  );

  if (anchors.length === 0) return [];

  const c = getClient();
  if (!c) return [];

  // Build a list of all market questions for Claude to match against
  const otherMarkets = allMarkets
    .filter(m => !anchors.some(a => a.marketId === m.id))
    .slice(0, 20)
    .map(m => `- "${m.question}" @ ${Math.round(m.yesPrice * 100)}%`);

  if (otherMarkets.length === 0) return [];

  const anchorStr = anchors.slice(0, 3).map(a =>
    `- "${a.question}" → Claude says ${Math.round(a.realProbability * 100)}% (market ${Math.round(a.marketYesPrice * 100)}%), ${a.action}`
  ).join('\n');

  const prompt = `You made high-confidence bets on these markets:
${anchorStr}

IF your bets are correct, which of these OTHER markets are now mispriced as a downstream consequence?

Available markets:
${otherMarkets.join('\n')}

For each affected market, explain the causal chain and estimate the new fair probability.

Respond with JSON:
{
  "chains": [
    {
      "anchor": "the market you bet on",
      "downstream": "the affected market question (exact text from list)",
      "causalChain": "If A happens then B because...",
      "newFairProb": 0.XX,
      "confidence": 1-10
    }
  ]
}

Only include chains where you're confident (>= 7) and the repricing is significant (>10% move). Max 3 chains.`;

  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: 'You are a prediction market strategist. Find causal chains between events — when one outcome becomes likely, what downstream markets should reprice? Be precise and only suggest chains with strong causal links.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    polySpendCents += ((response.usage?.input_tokens || 0) * 300 + (response.usage?.output_tokens || 0) * 1500) / 1_000_000;

    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    const results = [];
    for (const chain of (parsed.chains || [])) {
      // Find the matching downstream market
      const match = allMarkets.find(m =>
        m.question && chain.downstream &&
        m.question.toLowerCase().includes(chain.downstream.toLowerCase().slice(0, 30))
      );
      if (!match) continue;

      const newProb = Math.min(1, Math.max(0, parseFloat(chain.newFairProb) || 0.5));
      const edge = Math.round(Math.abs(newProb - match.yesPrice) * 1000) / 10;

      if (edge < 8) continue; // Not enough edge

      results.push({
        marketId: match.id,
        question: `[CHAIN] ${match.question}`,
        marketYesPrice: match.yesPrice,
        marketNoPrice: match.noPrice,
        realProbability: newProb,
        edge,
        action: newProb > match.yesPrice ? 'BET_YES' : 'BET_NO',
        confidence: Math.min(10, Math.max(1, parseInt(chain.confidence) || 6)),
        thesis: `Conditional chain: ${chain.causalChain}`,
        strategy: 'conditional_chain',
        anchor: chain.anchor,
        suggestedSizePct: Math.min(10, edge / 3), // Conservative on chains
        analyzedAt: new Date().toISOString(),
      });
    }

    console.log(`[PolyBrain] Found ${results.length} conditional chains from ${anchors.length} anchors`);
    return results;
  } catch (err) {
    console.error('[PolyBrain] Conditional chains error:', err.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// STRATEGY 7: WHALE COPY-TRADING
// ══════════════════════════════════════════════════════════════

/**
 * Monitor Polymarket leaderboard for big moves by top traders.
 *
 * Uses Polymarket's public activity data to detect when whales
 * make large bets. If a top-20 trader bets big, follow within minutes.
 *
 * Since Polymarket doesn't have a direct whale API, we use
 * volume spikes as a proxy: sudden large volume on a mid-range
 * market = someone big just entered.
 *
 * @param {Array} markets - Current markets with volume data
 * @param {Array} prevMarkets - Previous scan's markets (for delta)
 */
export function detectWhaleActivity(markets, prevMarkets) {
  if (!prevMarkets || prevMarkets.length === 0) return [];

  const prevMap = new Map(prevMarkets.map(m => [m.id, m]));
  const signals = [];

  for (const m of markets) {
    const prev = prevMap.get(m.id);
    if (!prev) continue;

    const volumeDelta = m.volume - prev.volume;
    const priceDelta = m.yesPrice - prev.yesPrice;

    // Detect whale activity: large volume spike + significant price move
    // A $50K+ volume increase in 30 min on a single market = likely whale
    if (volumeDelta > 50000 && Math.abs(priceDelta) > 0.03) {
      const direction = priceDelta > 0 ? 'YES' : 'NO';
      signals.push({
        marketId: m.id,
        question: `[WHALE] ${m.question}`,
        marketYesPrice: m.yesPrice,
        marketNoPrice: m.noPrice,
        action: direction === 'YES' ? 'BET_YES' : 'BET_NO',
        edge: Math.round(Math.abs(priceDelta) * 100),
        confidence: Math.min(8, 5 + Math.floor(volumeDelta / 100000)),
        thesis: `Whale detected: $${Math.round(volumeDelta).toLocaleString()} volume spike + ${Math.round(priceDelta * 100)}% price move toward ${direction}. Smart money is moving.`,
        strategy: 'whale_follow',
        volumeDelta: Math.round(volumeDelta),
        priceDelta: Math.round(priceDelta * 1000) / 10,
        suggestedSizePct: Math.min(8, Math.floor(volumeDelta / 50000) * 3),
        analyzedAt: new Date().toISOString(),
      });
    }
  }

  return signals.sort((a, b) => b.volumeDelta - a.volumeDelta);
}

// ══════════════════════════════════════════════════════════════
// MASTER SCANNER — combines all strategies
// ══════════════════════════════════════════════════════════════

/**
 * Find best bets across ALL strategies.
 * Returns a ranked list of opportunities.
 *
 * @param {Array} markets - All active markets from Polymarket
 * @returns {Array} Ranked bet opportunities
 */
export async function findBestBets(markets) {
  const allBets = [];

  // ── Pre-filter: remove garbage markets ──
  // 1. Skip markets that resolve too far out (>90 days = dead money)
  // 2. Skip near-impossible outcomes (price < 5¢ or > 95¢ — no real edge there)
  // 3. Prefer markets resolving in 1-30 days for fast capital turnover
  const now = new Date();
  const filteredMarkets = markets.filter(m => {
    // Must have an end date
    if (m.endDate) {
      const daysLeft = Math.round((new Date(m.endDate) - now) / (1000 * 60 * 60 * 24));
      if (daysLeft > 90) return false;  // Too far out — money sits dead
      if (daysLeft < 0) return false;   // Already expired
      m._daysLeft = daysLeft;           // Attach for later use
    }
    return true;
  });

  // ── Strategy 1: Claude edge detection on top markets ──
  // Mid-range prices (15-85%) on markets with decent volume and <90 day resolution
  const midRangeMarkets = filteredMarkets
    .filter(m => m.yesPrice >= 0.15 && m.yesPrice <= 0.85 && m.volume >= 50000)
    .sort((a, b) => (a._daysLeft || 999) - (b._daysLeft || 999)) // Prefer sooner resolution
    .slice(0, 12);

  for (const market of midRangeMarkets) {
    const analysis = await analyzeMarket(market);
    if (analysis && analysis.action !== 'SKIP' && Math.abs(analysis.edge) >= 10) {
      allBets.push({
        ...analysis,
        strategy: 'edge_detection',
        score: Math.abs(analysis.edge) * analysis.confidence,
      });
    }
  }

  // ── Strategy 2: Implied inconsistency arbitrage ──
  // Only real logical inconsistencies (e.g. "election price > nomination price")
  // NO more "buy cheapest in a group" — that was buying LeBron for president at 1¢
  const arbOpps = findCorrelatedArbitrage(markets);
  const impliedArbs = arbOpps.filter(a => a.type === 'implied_inconsistency');
  for (const arb of impliedArbs.slice(0, 3)) {
    // The dependent market is overpriced — sell it (BET_NO)
    const dependent = arb.markets.find(m => m.role === 'dependent') || arb.markets[1];
    const prerequisite = arb.markets.find(m => m.role === 'prerequisite') || arb.markets[0];
    allBets.push({
      marketId: dependent?.id || arb.markets[0]?.id,
      question: dependent?.question || prerequisite?.question,
      action: 'BET_NO', // Sell the overpriced dependent
      marketYesPrice: dependent?.yesPrice || 0.5,
      marketNoPrice: 1 - (dependent?.yesPrice || 0.5),
      realProbability: prerequisite?.yesPrice || 0.5, // Can't be higher than prerequisite
      edge: arb.edge,
      confidence: Math.min(9, 6 + Math.floor(arb.edge / 5)),
      thesis: arb.thesis,
      strategy: 'arbitrage',
      suggestedSizePct: Math.min(10, arb.edge / 3),
      score: arb.edge * 7,
      arbDetails: arb,
      analyzedAt: new Date().toISOString(),
    });
  }

  // ── Strategy 3: Longshot overpricing ──
  const longshots = findOverpricedLongshots(markets);
  for (const ls of longshots.slice(0, 5)) {
    // Quick Claude check on longshots (cheaper — just ask if it's overpriced)
    const analysis = await analyzeMarket(ls);
    if (analysis && analysis.action !== 'SKIP') {
      allBets.push({
        ...analysis,
        strategy: 'longshot_sell',
        score: Math.abs(analysis.edge) * analysis.confidence * 0.8,
      });
    }
  }

  // ── Strategy 4: Near-expiry safe bets ──
  const safeBets = findSafeBets(markets);
  for (const sb of safeBets.slice(0, 3)) {
    allBets.push({
      marketId: sb.id,
      question: sb.question,
      marketYesPrice: sb.yesPrice,
      marketNoPrice: sb.noPrice,
      action: sb.betSide === 'Yes' ? 'BET_YES' : 'BET_NO',
      edge: sb.returnPct,
      confidence: 9, // High confidence — near-certain outcome
      thesis: `Near-expiry safe bet: ${sb.returnPct}% return in ${sb.daysLeft} days (${sb.annualizedReturn}% annualized). Market at ${Math.round(sb.price * 100)}% with ${sb.daysLeft} days to go.`,
      strategy: 'safe_bet',
      suggestedSizePct: Math.min(30, 15 + sb.returnPct), // Bigger for safe bets
      score: sb.annualizedReturn * 0.5,
      returnPct: sb.returnPct,
      daysLeft: sb.daysLeft,
      annualizedReturn: sb.annualizedReturn,
      analyzedAt: new Date().toISOString(),
    });
  }

  // ── Strategy 5: Cross-platform arbitrage (Polymarket vs Kalshi) ──
  try {
    const { findCrossPlatformArb } = await import('./kalshiArb.js');
    const crossArb = await findCrossPlatformArb(markets);
    for (const arb of crossArb.slice(0, 3)) {
      if (arb.isArbitrage) {
        allBets.push({
          marketId: arb.polymarket.question,
          question: arb.polymarket.question,
          action: arb.cheaperYes === 'polymarket' ? 'BET_YES' : 'BET_NO',
          edge: arb.arbProfit,
          confidence: 10, // Risk-free!
          thesis: arb.thesis,
          strategy: 'cross_platform_arb',
          suggestedSizePct: 20, // High allocation for risk-free
          score: arb.arbProfit * 15, // Very high score
          arbDetails: arb,
          analyzedAt: new Date().toISOString(),
        });
      } else if (arb.priceDiff > 8) {
        // Not risk-free arb, but strong price divergence = confirmation signal
        allBets.push({
          marketId: arb.polymarket.question,
          question: arb.polymarket.question,
          marketYesPrice: arb.polymarket.yesPrice,
          marketNoPrice: arb.polymarket.noPrice,
          action: arb.cheaperYes === 'polymarket' ? 'BET_YES' : 'BET_NO',
          edge: arb.priceDiff,
          confidence: 7,
          thesis: arb.thesis,
          strategy: 'cross_platform_edge',
          suggestedSizePct: 10,
          score: arb.priceDiff * 5,
          analyzedAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error('[PolyBrain] Cross-platform arb error:', err.message);
  }

  // ── Strategy 6: Conditional probability chains ──
  // (only if we have high-confidence picks from strategy 1)
  const highConfPicks = allBets.filter(b => b.strategy === 'edge_detection' && b.confidence >= 8);
  if (highConfPicks.length > 0) {
    try {
      const chains = await findConditionalChains(highConfPicks, markets);
      for (const chain of chains.slice(0, 3)) {
        allBets.push({
          ...chain,
          score: Math.abs(chain.edge) * chain.confidence * 0.7,
        });
      }
    } catch (err) {
      console.error('[PolyBrain] Conditional chains error:', err.message);
    }
  }

  // ── Strategy 7: Whale activity detection ──
  if (_prevScanMarkets.length > 0) {
    const whaleSignals = detectWhaleActivity(markets, _prevScanMarkets);
    for (const ws of whaleSignals.slice(0, 2)) {
      allBets.push({
        ...ws,
        score: ws.volumeDelta / 10000 * ws.confidence,
      });
    }
  }
  // Store current markets for next scan's whale detection
  _prevScanMarkets = markets.map(m => ({ id: m.id, yesPrice: m.yesPrice, noPrice: m.noPrice, volume: m.volume }));

  // Sort all opportunities by score (best first)
  allBets.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Tag the best opportunity
  if (allBets.length > 0) allBets[0].isBestBet = true;

  const xArb = allBets.filter(b => b.strategy === 'cross_platform_arb' || b.strategy === 'cross_platform_edge').length;
  const chains = allBets.filter(b => b.strategy === 'conditional_chain').length;
  const whales = allBets.filter(b => b.strategy === 'whale_follow').length;
  console.log(`[PolyBrain] Found ${allBets.length} opps: ${allBets.filter(b => b.strategy === 'edge_detection').length} edge, ${allBets.filter(b => b.strategy === 'arbitrage').length} arb, ${xArb} cross-plat, ${allBets.filter(b => b.strategy === 'longshot_sell').length} longshot, ${allBets.filter(b => b.strategy === 'safe_bet').length} safe, ${chains} chains, ${whales} whale`);

  return allBets;
}

/**
 * Get a summary of all strategies and their status.
 */
export function getStrategyStatus() {
  return {
    strategies: [
      { name: 'Edge Detection', desc: 'Claude probability vs market price', active: true },
      { name: 'Multi-Model Ensemble', desc: 'Claude + Gemini weighted average', active: isGeminiConfigured() },
      { name: 'Correlated Arbitrage', desc: 'Find pricing inconsistencies', active: true },
      { name: 'Cross-Platform Arb', desc: 'Polymarket vs Kalshi price gaps', active: true },
      { name: 'Longshot Overpricing', desc: 'Sell overpriced low-probability bets', active: true },
      { name: 'Near-Expiry Safe Bets', desc: 'Stack near-certain outcomes', active: true },
      { name: 'Compound Reinvestment', desc: 'Pyramid growth: safe→medium→aggressive', active: true },
      { name: 'Conditional Chains', desc: 'If A happens, bet downstream B, C, D', active: true },
      { name: 'Whale Follow', desc: 'Detect volume spikes from big traders', active: _prevScanMarkets.length > 0 },
      { name: 'News Speed Edge', desc: 'React to breaking news fast', active: true },
      { name: 'Category Accuracy', desc: 'Bet more where proven edge', active: categoryStats.size > 0 },
    ],
    geminiActive: isGeminiConfigured(),
    categoryStats: getCategoryStats(),
    budgetUsed: Math.round(polySpendCents * 100) / 100,
    budgetRemaining: Math.round((BUDGET_CENTS - polySpendCents) * 100) / 100,
    cacheSize: analysisCache.size,
  };
}
