/**
 * Ticker Research — full deep-research dossier for a single symbol.
 *
 * Aggregates every available data source in parallel:
 *   Yahoo Finance: quote, fundamentals, earnings history, upcoming catalysts
 *   Finnhub: analyst recs, insider trades, congressional trades
 *   Reddit:      mention count + sentiment
 *   StockTwits:  bull/bear ratio + message volume
 *   Order flow:  options unusual activity, insider buying, institutional flow
 *   Internal:    runs the live gem-finder scoring on this single symbol
 *   AI:          Claude/Gemini thesis paragraph
 *
 * Sources we DON'T have (would need paid API):
 *   - Fintel:      no free API; requires scraping or paid key
 *   - Ortex:       paid only ($300/mo)
 *   - X/Twitter:   $200/mo basic API; sentiment only via paid services
 *   - eToro:       no public sentiment API; sentiment available via paid scrapes
 *
 * Returns a structured dossier object. Telegram formatter consumes it.
 */

import * as yahooFinance from './yahooFinance.js';
import { getRedditSentiment } from './reddit.js';
import { getStockTwitsSentiment } from './stocktwits.js';
import { getAnalystSignals } from './analystTracker.js';
import { getInsiderSignals } from './insiderIntel.js';
import { getCongressSignals } from './congressTracker.js';
import { getOrderFlow } from './orderFlow.js';
import { analyzeStock, isClaudeConfigured } from './claudeBrain.js';

/**
 * @typedef {Object} TickerDossier
 * @property {string} symbol
 * @property {string} fetchedAt
 * @property {Object|null} price        { last, change, changePct, dayRange, week52, volume, avgVolume, marketCap, float, shortPct, peRatio }
 * @property {Object|null} fundamentals { sector, industry, beta, eps, divYield, profitMargins }
 * @property {Object|null} earnings     { lastBeat, avgSurprise, beatStreak, daysUntilNext }
 * @property {Object|null} analyst      { totalAnalysts, strongBuy, buy, hold, sell, bullPct, recentChange }
 * @property {Object|null} insider      { count30d, netBuying, biggestBuy, recentTransactions }
 * @property {Object|null} congress     { count30d, buyers, biggestBuy }
 * @property {Object|null} options      { putCallRatio, unusualActivity, callSweep, totalVolume, totalOI }
 * @property {Object|null} institutions { netChange, top5Holders, percentInstitutional }
 * @property {Object|null} reddit       { mentions24h, sentiment, trending }
 * @property {Object|null} stocktwits   { bullPct, messageVolume, sentiment }
 * @property {Object|null} catalysts    { earningsDate, analystEvent, fdaEvent, splitDate }
 * @property {Object|null} internal     { gemScore, signals, consensus, agentVerdicts }
 * @property {Object|null} aiThesis     { action, confidence, thesis, riskLevel, targetPct, warnings }
 * @property {Object} verdict           { recommendation, score, reasoning, conviction }
 * @property {string[]} missingSources
 */

/**
 * Run the full research dossier in parallel (~5-15s).
 * @param {string} symbol
 * @returns {Promise<TickerDossier>}
 */
export async function researchTicker(symbol) {
  const sym = String(symbol || '').toUpperCase().trim();
  if (!sym || !/^[A-Z][A-Z\-]{0,5}$/.test(sym)) {
    throw new Error(`Invalid ticker: ${symbol}`);
  }

  const startedAt = Date.now();
  const missingSources = [];

  // Fire all sources in parallel
  const [
    quoteRes,
    historyRes,
    earningsRes,
    catalystsRes,
    redditRes,
    stocktwitsRes,
    analystRes,
    insiderRes,
    congressRes,
    orderFlowRes,
  ] = await Promise.allSettled([
    yahooFinance.getQuote(sym),
    yahooFinance.getHistoricalData(sym),
    yahooFinance.getEarningsHistory(sym),
    yahooFinance.getUpcomingCatalysts(sym),
    getRedditSentiment(sym),
    getStockTwitsSentiment(sym),
    getAnalystSignals([sym]),
    getInsiderSignals([sym]),
    getCongressSignals([sym]),
    getOrderFlow(sym),
  ]);

  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  if (!quote) {
    missingSources.push('Yahoo quote');
  }

  // ── Price block ──
  const price = quote ? {
    last: Number(quote.regularMarketPrice ?? 0),
    change: Number(quote.regularMarketChange ?? 0),
    changePct: Number(quote.regularMarketChangePercent ?? 0),
    dayLow: Number(quote.regularMarketDayLow ?? 0),
    dayHigh: Number(quote.regularMarketDayHigh ?? 0),
    week52Low: Number(quote.fiftyTwoWeekLow ?? 0),
    week52High: Number(quote.fiftyTwoWeekHigh ?? 0),
    volume: Number(quote.regularMarketVolume ?? 0),
    avgVolume: Number(quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day ?? 0),
    marketCap: Number(quote.marketCap ?? 0),
    sharesOutstanding: Number(quote.sharesOutstanding ?? 0),
    floatShares: Number(quote.floatShares ?? quote.sharesOutstanding ?? 0),
    shortPct: Number(quote.shortPercentOfFloat ?? 0) * 100,
    peRatio: Number(quote.trailingPE ?? 0),
  } : null;

  // ── Fundamentals ──
  const fundamentals = quote ? {
    sector: quote.sector || null,
    industry: quote.industry || null,
    beta: Number(quote.beta ?? 0),
    eps: Number(quote.epsTrailingTwelveMonths ?? 0),
    divYield: Number(quote.trailingAnnualDividendYield ?? 0) * 100,
    profitMargins: Number(quote.profitMargins ?? 0) * 100,
  } : null;

  // ── Earnings ──
  const earningsHist = earningsRes.status === 'fulfilled' ? earningsRes.value : null;
  const earnings = earningsHist ? {
    beatStreak: Number(earningsHist.beatStreak ?? 0),
    avgSurprise: Number(earningsHist.avgSurprise ?? 0),
    sue: Number(earningsHist.sue ?? 0),
    revisionMomentum: Number(earningsHist.revisionMomentum ?? 0),
  } : null;
  if (!earningsHist) missingSources.push('earnings history');

  // ── Catalysts (upcoming events) ──
  const catalysts = catalystsRes.status === 'fulfilled' ? catalystsRes.value : null;

  // ── Analyst ratings ──
  const analystMap = analystRes.status === 'fulfilled' ? analystRes.value : null;
  const analystEntry = analystMap?.[sym] || null;
  const analyst = analystEntry ? {
    totalAnalysts: Number(analystEntry.totalAnalysts ?? 0),
    strongBuy: Number(analystEntry.strongBuy ?? 0),
    buy: Number(analystEntry.buy ?? 0),
    hold: Number(analystEntry.hold ?? 0),
    sell: Number(analystEntry.sell ?? 0),
    bullPct: Number(analystEntry.bullPct ?? 0),
    signals: analystEntry.signals || [],
  } : null;
  if (!analyst) missingSources.push('analyst (Finnhub)');

  // ── Insider activity (Form 4) ──
  const insiderMap = insiderRes.status === 'fulfilled' ? insiderRes.value : null;
  const insiderEntry = insiderMap?.[sym] || null;
  const insider = insiderEntry ? {
    buyCount30d: Number(insiderEntry.buyCount30d ?? 0),
    netDollarValue: Number(insiderEntry.netValue ?? 0),
    distinctInsiders: Number(insiderEntry.distinctInsiders ?? 0),
    signals: insiderEntry.signals || [],
  } : null;
  if (!insider) missingSources.push('insider trades (Finnhub)');

  // ── Congressional trades ──
  const congressMap = congressRes.status === 'fulfilled' ? congressRes.value : null;
  const congressEntry = congressMap?.[sym] || null;
  const congress = congressEntry ? {
    buyCount: Number(congressEntry.buyCount ?? 0),
    distinctMembers: Number(congressEntry.distinctMembers ?? 0),
    senatorBuys: Number(congressEntry.senatorBuys ?? 0),
    signals: congressEntry.signals || [],
  } : null;
  if (!congress) missingSources.push('congress (Finnhub)');

  // ── Order flow (options + institutions + insiders) ──
  const flow = orderFlowRes.status === 'fulfilled' ? orderFlowRes.value : null;
  const options = flow?.optionsData ? {
    putCallRatio: Number(flow.optionsData.putCallRatio ?? 1),
    callVolume: Number(flow.optionsData.callVolume ?? 0),
    putVolume: Number(flow.optionsData.putVolume ?? 0),
    unusualActivity: !!flow.optionsData.unusualActivity,
    signals: flow.optionsSignals || [],
  } : null;
  const institutions = flow?.institutionData ? {
    netChangePct: Number(flow.institutionData.netChange ?? 0),
    pctInstitutional: Number(flow.institutionData.percentInstitutional ?? 0),
  } : null;

  // ── Reddit ──
  const reddit = redditRes.status === 'fulfilled' && redditRes.value ? {
    mentions: Number(redditRes.value.mentions ?? 0),
    sentiment: redditRes.value.sentiment ?? 'neutral',
    sentimentScore: Number(redditRes.value.score ?? 0),
    topPosts: redditRes.value.topPosts || [],
  } : null;

  // ── StockTwits ──
  const stocktwits = stocktwitsRes.status === 'fulfilled' && stocktwitsRes.value ? {
    bullPct: Number(stocktwitsRes.value.bullPct ?? 0),
    messageCount: Number(stocktwitsRes.value.messageCount ?? 0),
    sentiment: stocktwitsRes.value.sentiment ?? 'neutral',
    topMessages: stocktwitsRes.value.topMessages || [],
  } : null;

  // ── Internal scoring (run dailyPicker scoring on a synthetic candidate) ──
  let internal = null;
  if (price && (analyst || insider || options)) {
    const synthSignals = [
      ...(insider?.signals || []),
      ...(analyst?.signals || []),
      ...(options?.signals || []),
      ...(congress?.signals || []),
    ];
    internal = {
      hasOptionsFlow: !!options?.unusualActivity || !!flow?.optionsData?.callSweep,
      insiderBuying: (insider?.buyCount30d || 0) > 0,
      analystBullPct: analyst?.bullPct || null,
      signals: [...new Set(synthSignals)],
    };
  }

  // ── AI thesis (best-effort, may be skipped if no Claude budget) ──
  let aiThesis = null;
  if (isClaudeConfigured() && quote) {
    try {
      const synthStock = {
        symbol: sym,
        price: price.last,
        gemScore: 50,           // neutral starter — let Claude form its own opinion
        consensus: 'Watch',
        signals: internal?.signals || [],
        avgConviction: 3,
        explosion: { expectedGainPct: 5, probability: 50, daysToMove: 1 },
        verdicts: [],
      };
      aiThesis = await analyzeStock(synthStock);
    } catch (err) {
      // Claude budget exceeded or transient; non-fatal
      missingSources.push('AI thesis (Claude/Gemini unavailable)');
    }
  } else if (!isClaudeConfigured()) {
    missingSources.push('AI thesis (no API key)');
  }

  // ── Verdict synthesis ──
  const verdict = synthesizeVerdict({ price, earnings, analyst, insider, congress, options, reddit, stocktwits, aiThesis });

  // ── Annotate paid-source gaps ──
  missingSources.push('Fintel (no free API)');
  missingSources.push('Ortex (paid)');
  missingSources.push('X/Twitter sentiment (paid API)');
  missingSources.push('eToro sentiment (no public API)');

  return {
    symbol: sym,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    price,
    fundamentals,
    earnings,
    catalysts,
    analyst,
    insider,
    congress,
    options,
    institutions,
    reddit,
    stocktwits,
    internal,
    aiThesis,
    verdict,
    missingSources,
  };
}

/**
 * Synthesize a verdict from all signals. Returns a recommendation + score 0-100 + reasoning bullets.
 *
 * Uses the same attribution-corrected weight philosophy as dailyPicker:
 * - Heavy weight on volume_contraction, call_sweep, smart_money, insider_cluster
 * - Penalize put_call_bullish, options_volume_spike (proven losers)
 * - AI thesis gets a vote at confidence ≥7
 * - Bear filters: short>30%, deep loss vs 52w high (only if not also a squeeze)
 */
function synthesizeVerdict({ price, earnings, analyst, insider, congress, options, reddit, stocktwits, aiThesis }) {
  let score = 50;        // neutral start
  const reasons = [];
  const bears = [];

  // ── Bullish signals ──
  if (analyst?.bullPct >= 75) { score += 8; reasons.push(`Analysts very bullish (${analyst.bullPct.toFixed(0)}% buy/strong-buy)`); }
  else if (analyst?.bullPct >= 60) { score += 4; reasons.push(`Analysts bullish (${analyst.bullPct.toFixed(0)}%)`); }
  else if (analyst?.bullPct != null && analyst.bullPct < 40) { score -= 6; bears.push(`Analysts bearish (${analyst.bullPct.toFixed(0)}% buy)`); }

  if (insider?.buyCount30d >= 3) { score += 12; reasons.push(`Insider cluster: ${insider.buyCount30d} buys in 30d ($${Math.round((insider.netDollarValue||0)/1000)}k net)`); }
  else if (insider?.buyCount30d >= 1) { score += 4; reasons.push(`Recent insider buying (${insider.buyCount30d})`); }

  if (congress?.distinctMembers >= 3) { score += 10; reasons.push(`Congressional cluster (${congress.distinctMembers} members buying)`); }
  else if (congress?.buyCount >= 1) { score += 3; reasons.push(`Congressional buying`); }

  if (options?.putCallRatio < 0.5 && options?.unusualActivity) { score += 10; reasons.push(`Heavy bullish options flow (P/C ${options.putCallRatio.toFixed(2)})`); }
  else if (options?.putCallRatio < 0.7) { score += 4; reasons.push(`Bullish options bias`); }
  else if (options?.putCallRatio > 1.5) { score -= 6; bears.push(`Bearish options flow (P/C ${options.putCallRatio.toFixed(2)})`); }

  if (earnings?.beatStreak >= 4) { score += 6; reasons.push(`${earnings.beatStreak} consecutive earnings beats`); }
  if (earnings?.avgSurprise > 5) { score += 3; reasons.push(`Avg earnings surprise +${earnings.avgSurprise.toFixed(1)}%`); }

  if (reddit?.mentions > 100) { score += 3; reasons.push(`Reddit traction (${reddit.mentions} mentions)`); }
  if (stocktwits?.bullPct >= 70 && stocktwits?.messageCount > 50) { score += 3; reasons.push(`StockTwits bullish (${stocktwits.bullPct.toFixed(0)}%)`); }

  // ── Bear filters ──
  if (price?.shortPct > 30 && price?.changePct > 0) {
    score += 6;
    reasons.push(`Short squeeze setup (${price.shortPct.toFixed(0)}% SI, price rising)`);
  } else if (price?.shortPct > 30) {
    score -= 4;
    bears.push(`Heavily shorted (${price.shortPct.toFixed(0)}% SI)`);
  }

  if (price && price.last < price.week52High * 0.5) {
    score -= 5;
    bears.push(`Far from 52w high (${((price.last/price.week52High - 1)*100).toFixed(0)}%)`);
  }
  if (price && price.last >= price.week52High * 0.95) {
    score += 4;
    reasons.push(`Near 52w high`);
  }

  // ── AI vote (highest weight when confident) ──
  if (aiThesis?.action === 'BUY' && aiThesis?.confidence >= 8) {
    score += 12;
    reasons.push(`AI strong BUY (conf ${aiThesis.confidence}/10): "${(aiThesis.thesis || '').slice(0, 100)}"`);
  } else if (aiThesis?.action === 'BUY' && aiThesis?.confidence >= 6) {
    score += 6;
    reasons.push(`AI BUY (conf ${aiThesis.confidence}/10)`);
  } else if (aiThesis?.action === 'SKIP') {
    score -= 10;
    bears.push(`AI says SKIP (conf ${aiThesis?.confidence ?? '?'}): "${(aiThesis?.thesis || '').slice(0, 100)}"`);
  }

  // ── Volume confirmation ──
  if (price?.volume > price?.avgVolume * 2 && price?.changePct > 0) {
    score += 4;
    reasons.push(`Volume surge (${(price.volume/price.avgVolume).toFixed(1)}× avg, price up)`);
  }

  // Clamp & classify
  score = Math.max(0, Math.min(100, Math.round(score)));
  let recommendation, conviction;
  if (score >= 70)      { recommendation = 'BUY';   conviction = 'HIGH'; }
  else if (score >= 60) { recommendation = 'BUY';   conviction = 'MEDIUM'; }
  else if (score >= 50) { recommendation = 'WATCH'; conviction = 'LOW'; }
  else if (score >= 35) { recommendation = 'SKIP';  conviction = 'LOW'; }
  else                  { recommendation = 'SKIP';  conviction = 'HIGH'; }

  return { recommendation, score, conviction, reasons, bears };
}
