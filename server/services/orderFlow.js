/**
 * Order Flow Intelligence — See what big players are doing BEFORE price moves
 *
 * 1. Insider Trading (SEC Form 4) — executives buying/selling their own stock
 * 2. Options Flow — put/call ratio, unusual volume = big money positioning
 * 3. Institutional Holdings — funds increasing/decreasing positions
 * 4. Short Volume — FINRA daily short volume ratio
 *
 * All from free sources (Yahoo Finance + SEC EDGAR)
 */

import YahooFinance from 'yahoo-finance2';
import axios from 'axios';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Cache per symbol (5 min TTL)
const flowCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Get complete order flow analysis for a symbol.
 */
export async function getOrderFlow(symbol) {
  const cached = flowCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const [insiders, options, institutions] = await Promise.allSettled([
    getInsiderActivity(symbol),
    getOptionsFlow(symbol),
    getInstitutionalFlow(symbol),
  ]);

  const insiderData = insiders.status === 'fulfilled' ? insiders.value : null;
  const optionsData = options.status === 'fulfilled' ? options.value : null;
  const institutionData = institutions.status === 'fulfilled' ? institutions.value : null;

  // ── Compute overall flow signal ──
  let bullSignals = 0, bearSignals = 0;
  const signals = [];

  if (insiderData) {
    if (insiderData.netBuying > 0) { bullSignals += 2; signals.push('Insiders buying'); }
    if (insiderData.netBuying < 0) { bearSignals += 2; signals.push('Insiders selling'); }
    if (insiderData.recentBuys > 0) { bullSignals += 1; }
  }

  if (optionsData) {
    if (optionsData.putCallRatio < 0.7) { bullSignals += 1; signals.push('Bullish options flow'); }
    if (optionsData.putCallRatio > 1.3) { bearSignals += 1; signals.push('Bearish options flow'); }
    if (optionsData.unusualActivity) { bullSignals += 1; signals.push('Unusual options volume'); }
  }

  if (institutionData) {
    if (institutionData.netChange > 0) { bullSignals += 1; signals.push('Institutions accumulating'); }
    if (institutionData.netChange < 0) { bearSignals += 1; signals.push('Institutions reducing'); }
  }

  const flowScore = bullSignals - bearSignals; // -5 to +5
  const flowSignal = flowScore >= 3 ? 'strong_buy' : flowScore >= 1 ? 'bullish' : flowScore <= -3 ? 'strong_sell' : flowScore <= -1 ? 'bearish' : 'neutral';

  const data = {
    symbol,
    insiders: insiderData,
    options: optionsData,
    institutions: institutionData,
    flowScore,
    flowSignal,
    signals,
    summary: buildSummary(flowSignal, signals),
    updatedAt: new Date().toISOString(),
  };

  flowCache.set(symbol, { data, ts: Date.now() });
  return data;
}

// ── Insider Trading (Form 4) ──
async function getInsiderActivity(symbol) {
  try {
    const summary = await yf.quoteSummary(symbol, {
      modules: ['insiderTransactions', 'insiderHolders'],
    });

    const transactions = summary?.insiderTransactions?.transactions || [];
    const holders = summary?.insiderHolders?.holders || [];

    // Analyze recent transactions (last 90 days)
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

    const recent = transactions.filter(t => {
      const txDate = t.startDate?.raw ? t.startDate.raw * 1000 : (t.startDate ? new Date(t.startDate).getTime() : 0);
      return txDate > ninetyDaysAgo;
    });

    let totalBought = 0, totalSold = 0, recentBuys = 0, recentSells = 0;
    const recentTrades = [];

    for (const t of recent.slice(0, 10)) {
      const shares = t.shares?.raw ?? t.shares ?? 0;
      const value = t.value?.raw ?? t.value ?? 0;
      const txType = (t.transaction || '').toLowerCase();
      const isBuy = txType.includes('buy') || txType.includes('purchase') || txType.includes('acquisition');
      const isSell = txType.includes('sale') || txType.includes('sell') || txType.includes('disposition');

      if (isBuy) { totalBought += value; recentBuys++; }
      if (isSell) { totalSold += value; recentSells++; }

      recentTrades.push({
        name: t.filerName || 'Unknown',
        relation: t.filerRelation || '',
        type: isBuy ? 'BUY' : isSell ? 'SELL' : t.transaction || 'OTHER',
        shares: Math.abs(shares),
        value: Math.abs(value),
        date: t.startDate?.fmt || t.startDate || '',
      });
    }

    const netBuying = totalBought - totalSold;
    const topHolders = holders.slice(0, 5).map(h => ({
      name: h.name || 'Unknown',
      position: h.positionDirect?.raw ?? h.positionDirect ?? 0,
      relation: h.relation || '',
    }));

    return {
      recentTrades,
      recentBuys,
      recentSells,
      totalBought,
      totalSold,
      netBuying,
      netBuyingLabel: netBuying > 0 ? `+$${formatMoney(netBuying)} net buying` : netBuying < 0 ? `-$${formatMoney(Math.abs(netBuying))} net selling` : 'Neutral',
      sentiment: netBuying > 100000 ? 'bullish' : netBuying < -100000 ? 'bearish' : 'neutral',
      topHolders,
    };
  } catch (err) {
    console.error(`[OrderFlow] Insider data error for ${symbol}:`, err.message);
    return null;
  }
}

// ── Options Flow (Put/Call Ratio + Unusual Activity) ──
async function getOptionsFlow(symbol) {
  try {
    const chain = await yf.options(symbol);
    if (!chain || !chain.options || chain.options.length === 0) return null;

    const opt = chain.options[0]; // nearest expiry
    const calls = opt.calls || [];
    const puts = opt.puts || [];

    const totalCallVol = calls.reduce((s, c) => s + (c.volume?.raw ?? c.volume ?? 0), 0);
    const totalPutVol = puts.reduce((s, p) => s + (p.volume?.raw ?? p.volume ?? 0), 0);
    const totalCallOI = calls.reduce((s, c) => s + (c.openInterest?.raw ?? c.openInterest ?? 0), 0);
    const totalPutOI = puts.reduce((s, p) => s + (p.openInterest?.raw ?? p.openInterest ?? 0), 0);

    const putCallRatio = totalCallVol > 0 ? Math.round((totalPutVol / totalCallVol) * 100) / 100 : 0;
    const putCallOIRatio = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

    // Unusual activity = total options volume > 2x average (estimated from OI)
    const avgDailyOI = (totalCallOI + totalPutOI) / 20; // rough estimate
    const totalVol = totalCallVol + totalPutVol;
    const unusualActivity = avgDailyOI > 0 && totalVol > avgDailyOI * 2;

    // Find highest volume strikes (where big money is betting)
    const allOptions = [
      ...calls.map(c => ({ ...c, type: 'CALL' })),
      ...puts.map(p => ({ ...p, type: 'PUT' })),
    ];
    const topStrikes = allOptions
      .filter(o => (o.volume?.raw ?? o.volume ?? 0) > 0)
      .sort((a, b) => (b.volume?.raw ?? b.volume ?? 0) - (a.volume?.raw ?? a.volume ?? 0))
      .slice(0, 5)
      .map(o => ({
        type: o.type,
        strike: o.strike?.raw ?? o.strike ?? 0,
        volume: o.volume?.raw ?? o.volume ?? 0,
        openInterest: o.openInterest?.raw ?? o.openInterest ?? 0,
        impliedVol: o.impliedVolatility?.raw ?? o.impliedVolatility ?? 0,
      }));

    const sentiment = putCallRatio < 0.5 ? 'very_bullish'
      : putCallRatio < 0.7 ? 'bullish'
      : putCallRatio > 1.5 ? 'very_bearish'
      : putCallRatio > 1.0 ? 'bearish'
      : 'neutral';

    return {
      putCallRatio,
      putCallOIRatio,
      totalCallVol,
      totalPutVol,
      totalCallOI,
      totalPutOI,
      unusualActivity,
      sentiment,
      sentimentLabel: putCallRatio < 0.7 ? 'Calls dominating — bulls in control'
        : putCallRatio > 1.3 ? 'Puts dominating — bears betting against'
        : 'Balanced options flow',
      topStrikes,
      expiryDate: opt.expirationDate?.fmt || '',
    };
  } catch (err) {
    console.error(`[OrderFlow] Options data error for ${symbol}:`, err.message);
    return null;
  }
}

// ── Institutional Holdings ──
async function getInstitutionalFlow(symbol) {
  try {
    const summary = await yf.quoteSummary(symbol, {
      modules: ['majorHoldersBreakdown', 'institutionOwnership'],
    });

    const holders = summary?.majorHoldersBreakdown;
    const institutions = summary?.institutionOwnership?.ownershipList || [];

    const insiderPct = holders?.insidersPercentHeld?.raw ?? holders?.insidersPercentHeld ?? 0;
    const institutionPct = holders?.institutionsPercentHeld?.raw ?? holders?.institutionsPercentHeld ?? 0;
    const institutionCount = holders?.institutionsCount?.raw ?? holders?.institutionsCount ?? 0;

    // Top institutional holders
    const topInstitutions = institutions.slice(0, 5).map(inst => ({
      name: inst.organization || 'Unknown',
      shares: inst.position?.raw ?? inst.position ?? 0,
      value: inst.value?.raw ?? inst.value ?? 0,
      pctChange: inst.pctChange?.raw ?? inst.pctChange ?? 0,
    }));

    // Net institutional change
    const netChange = topInstitutions.reduce((s, i) => s + (i.pctChange || 0), 0);

    return {
      insiderPct: Math.round(insiderPct * 10000) / 100,
      institutionPct: Math.round(institutionPct * 10000) / 100,
      institutionCount,
      topInstitutions,
      netChange: Math.round(netChange * 100) / 100,
      sentiment: netChange > 5 ? 'accumulating' : netChange < -5 ? 'distributing' : 'holding',
      sentimentLabel: netChange > 5 ? 'Institutions increasing positions'
        : netChange < -5 ? 'Institutions reducing exposure'
        : 'Institutional holdings stable',
    };
  } catch (err) {
    console.error(`[OrderFlow] Institutional data error for ${symbol}:`, err.message);
    return null;
  }
}

// ── Helpers ──
function formatMoney(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toString();
}

function buildSummary(signal, signals) {
  if (signals.length === 0) return 'No significant order flow detected.';
  const prefix = signal === 'strong_buy' ? 'Strong bullish signal'
    : signal === 'bullish' ? 'Bullish flow'
    : signal === 'strong_sell' ? 'Strong bearish signal'
    : signal === 'bearish' ? 'Bearish flow'
    : 'Mixed signals';
  return `${prefix}: ${signals.join(', ')}.`;
}
