/**
 * Supabase Database Layer
 *
 * Persists all learning data so it survives Railway redeploys:
 *   - Claude predictions + outcomes (win/loss tracking)
 *   - Polymarket bets + settlements
 *   - Trade history (Alpaca auto-trades)
 *
 * Falls back to local JSON files if Supabase is not configured.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

let supabase = null;

function getClient() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabase;
}

export function isDbConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

// ═══════════════════════════════════════════════════════════
// Claude Predictions
// ═══════════════════════════════════════════════════════════

export async function savePrediction(prediction) {
  const db = getClient();
  if (!db) return null;

  try {
    // Pack explosion data into thesis field (existing column)
    const explosionMeta = prediction.predictedGainPct
      ? `[PRED:+${prediction.predictedGainPct}%/${prediction.predictedDays}d/${prediction.predictedProbability}%/${prediction.explosionType}] `
      : '';
    const signalsMeta = prediction.signals?.length
      ? `[SIG:${prediction.signals.join(',')}] ` : '';
    const verdictsMeta = prediction.agentVerdicts
      ? `[AGENTS:${prediction.agentVerdicts}] ` : '';

    const { data, error } = await db.from('predictions').insert({
      symbol: prediction.symbol,
      action: prediction.action,
      confidence: prediction.confidence,
      thesis: `${explosionMeta}${signalsMeta}${verdictsMeta}${prediction.thesis || ''}`.slice(0, 1000),
      risk_level: prediction.riskLevel,
      target_pct: prediction.predictedGainPct || prediction.targetPct,
      stop_pct: prediction.stopPct,
      timeframe_days: prediction.predictedDays || prediction.timeframeDays,
      entry_price: prediction.entryPrice,
      gem_score: prediction.gemScore,
      consensus: prediction.consensus,
      provider: prediction.provider || 'gemini',
    }).select();

    if (error) throw error;
    return data?.[0];
  } catch (err) {
    console.error('[DB] savePrediction error:', err.message);
    return null;
  }
}

/**
 * Save explosion prediction for a gem — called every scan cycle
 * for gems with strong setups. Outcome resolved days later.
 */
export async function saveExplosionPrediction(gem) {
  const db = getClient();
  if (!db) return null;

  try {
    // Don't duplicate — check if we already predicted this stock today
    const today = new Date().toISOString().split('T')[0];
    const { data: existing } = await db.from('predictions')
      .select('id')
      .eq('symbol', gem.symbol)
      .gte('created_at', `${today}T00:00:00`)
      .is('outcome', null)
      .limit(1);

    if (existing?.length > 0) return existing[0]; // Already predicted today

    const expl = gem.explosion || {};
    const factorsStr = expl.factors?.slice(0, 3).join('; ') || 'Signal-based prediction';
    const signalsStr = (gem.signals || []).join(',');
    const verdictsStr = gem.verdicts
      ? gem.verdicts.map(v => `${v.agent?.split(' ')[0] || '?'}:${v.action}(${v.conviction})`).join(',')
      : '';

    const thesis = [
      `[PRED:+${expl.expectedGainPct || 10}%/${expl.daysToMove || 5}d/${expl.probability || 30}%/${expl.explosionType || 'setup'}]`,
      `[SIG:${signalsStr}]`,
      verdictsStr ? `[AGENTS:${verdictsStr}]` : '',
      factorsStr,
    ].filter(Boolean).join(' ').slice(0, 1000);

    const { data, error } = await db.from('predictions').insert({
      symbol: gem.symbol,
      action: gem.consensus === 'Strong Buy' || gem.consensus === 'Buy' ? 'BUY' : 'WATCH',
      confidence: gem.avgConviction || 3,
      thesis,
      risk_level: gem.risk || 'moderate',
      target_pct: expl.expectedGainPct || 10,
      stop_pct: 5,
      timeframe_days: expl.daysToMove || 5,
      entry_price: gem.price,
      gem_score: gem.gemScore,
      consensus: gem.consensus,
      provider: 'explosion_model',
    }).select();

    if (error) throw error;
    return data?.[0];
  } catch (err) {
    console.error('[DB] saveExplosionPrediction error:', err.message);
    return null;
  }
}

/**
 * Resolve explosion predictions — check if predicted gains actually happened.
 * Called daily. Looks at predictions from 1-7 days ago and checks actual price.
 */
export async function resolveExplosionPredictions(getQuoteFn) {
  const db = getClient();
  if (!db) return { resolved: 0 };

  try {
    // Find unresolved explosion predictions older than their predicted timeframe
    const { data: unresolved } = await db.from('predictions')
      .select('*')
      .is('outcome', null)
      .eq('provider', 'explosion_model')
      .order('created_at', { ascending: true })
      .limit(50);

    if (!unresolved?.length) return { resolved: 0 };

    let resolved = 0;
    const results = [];

    for (const pred of unresolved) {
      const createdAt = new Date(pred.created_at);
      const ageInDays = (Date.now() - createdAt.getTime()) / 86400000;
      const predictedDays = pred.predicted_days || 5;

      // Only resolve if enough time has passed (predicted days + 1 buffer day)
      if (ageInDays < predictedDays + 1) continue;

      // Get current price
      try {
        const quote = await getQuoteFn(pred.symbol);
        const currentPrice = quote?.regularMarketPrice;
        if (!currentPrice || !pred.entry_price) continue;

        const actualPct = Math.round(((currentPrice - pred.entry_price) / pred.entry_price) * 10000) / 100;
        const hit = actualPct >= (pred.target_pct || 10) * 0.5; // Hit if got 50%+ of predicted gain
        const outcome = actualPct > 0 ? 'win' : 'loss';

        await db.from('predictions').update({
          outcome,
          exit_price: currentPrice,
          actual_pct: actualPct,
          exit_reason: `Resolved after ${Math.round(ageInDays)}d (predicted ${predictedDays}d)`,
          settled_at: new Date().toISOString(),
        }).eq('id', pred.id);

        resolved++;
        results.push({
          symbol: pred.symbol,
          predicted: `+${pred.target_pct || '?'}% in ${predictedDays}d`,
          actual: `${actualPct > 0 ? '+' : ''}${actualPct}% in ${Math.round(ageInDays)}d`,
          hit,
          outcome,
        });
      } catch (err) {
        // Skip this symbol if quote fails
      }
    }

    if (results.length > 0) {
      const hits = results.filter(r => r.hit).length;
      console.log(`[DB] Resolved ${resolved} predictions: ${hits}/${results.length} hit target (${Math.round(hits / results.length * 100)}%)`);
    }

    return { resolved, results };
  } catch (err) {
    console.error('[DB] resolveExplosionPredictions error:', err.message);
    return { resolved: 0 };
  }
}

/**
 * Get explosion prediction accuracy stats
 */
export async function getExplosionStats() {
  const db = getClient();
  if (!db) return null;

  try {
    const { data: all } = await db.from('predictions')
      .select('*')
      .eq('provider', 'explosion_model')
      .order('created_at', { ascending: false })
      .limit(200);

    if (!all?.length) return null;

    // Parse explosion data from thesis field [PRED:+XX%/Xd/XX%/type]
    for (const p of all) {
      const match = (p.thesis || '').match(/\[PRED:\+(\d+)%\/(\d+)d\/(\d+)%\/([^\]]+)\]/);
      if (match) {
        p._predictedGain = parseInt(match[1]);
        p._predictedDays = parseInt(match[2]);
        p._predictedProb = parseInt(match[3]);
        p._explosionType = match[4];
      }
    }

    const settled = all.filter(p => p.outcome);
    const wins = settled.filter(p => p.outcome === 'win');
    const bigWins = settled.filter(p => p.actual_pct >= 10);

    // Accuracy by explosion type
    const byType = {};
    for (const p of settled) {
      const type = p._explosionType || 'unknown';
      if (!byType[type]) byType[type] = { total: 0, wins: 0, avgPredicted: 0, avgActual: 0 };
      byType[type].total++;
      if (p.outcome === 'win') byType[type].wins++;
      byType[type].avgPredicted += (p._predictedGain || p.target_pct || 0);
      byType[type].avgActual += (p.actual_pct || 0);
    }
    for (const [type, stats] of Object.entries(byType)) {
      stats.winRate = Math.round((stats.wins / stats.total) * 100);
      stats.avgPredicted = Math.round(stats.avgPredicted / stats.total);
      stats.avgActual = Math.round((stats.avgActual / stats.total) * 100) / 100;
    }

    return {
      totalPredictions: all.length,
      totalSettled: settled.length,
      pending: all.length - settled.length,
      winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0,
      bigWinRate: settled.length > 0 ? Math.round((bigWins.length / settled.length) * 100) : 0,
      avgPredictedGain: all.length > 0
        ? Math.round(all.reduce((s, p) => s + (p._predictedGain || p.target_pct || 0), 0) / all.length) : 0,
      avgActualGain: settled.length > 0
        ? Math.round(settled.reduce((s, p) => s + (p.actual_pct || 0), 0) / settled.length * 100) / 100 : 0,
      byExplosionType: byType,
      recentPredictions: all.slice(0, 10).map(p => ({
        symbol: p.symbol,
        predicted: `+${p._predictedGain || p.target_pct || '?'}%`,
        actual: p.outcome ? `${p.actual_pct > 0 ? '+' : ''}${p.actual_pct}%` : 'pending',
        outcome: p.outcome || 'pending',
        daysAgo: Math.round((Date.now() - new Date(p.created_at).getTime()) / 86400000),
      })),
    };
  } catch (err) {
    console.error('[DB] getExplosionStats error:', err.message);
    return null;
  }
}

export async function updatePredictionOutcome(symbol, exitPrice, actualPct, exitReason) {
  const db = getClient();
  if (!db) return;

  try {
    // Find the most recent open prediction for this symbol
    const { data: open } = await db.from('predictions')
      .select('id')
      .eq('symbol', symbol)
      .is('outcome', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!open?.[0]) return;

    const { error } = await db.from('predictions')
      .update({
        outcome: actualPct > 0 ? 'win' : 'loss',
        exit_price: exitPrice,
        actual_pct: Math.round(actualPct * 100) / 100,
        exit_reason: exitReason,
        settled_at: new Date().toISOString(),
      })
      .eq('id', open[0].id);

    if (error) throw error;
  } catch (err) {
    console.error('[DB] updatePredictionOutcome error:', err.message);
  }
}

export async function getPredictionStats() {
  const db = getClient();
  if (!db) return null;

  try {
    const { data: all } = await db.from('predictions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (!all || all.length === 0) return null;

    const settled = all.filter(p => p.outcome && p.action === 'BUY');
    const wins = settled.filter(p => p.outcome === 'win');
    const losses = settled.filter(p => p.outcome === 'loss');

    return {
      totalCalls: all.length,
      totalSettled: settled.length,
      winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0,
      avgReturn: settled.length > 0
        ? Math.round(settled.reduce((s, p) => s + (p.actual_pct || 0), 0) / settled.length * 100) / 100
        : 0,
      avgConfWin: wins.length > 0
        ? Math.round(wins.reduce((s, p) => s + p.confidence, 0) / wins.length * 10) / 10 : 0,
      avgConfLoss: losses.length > 0
        ? Math.round(losses.reduce((s, p) => s + p.confidence, 0) / losses.length * 10) / 10 : 0,
      recentCalls: all.slice(0, 10),
    };
  } catch (err) {
    console.error('[DB] getPredictionStats error:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Polymarket Bets
// ═══════════════════════════════════════════════════════════

export async function savePolyBet(bet) {
  const db = getClient();
  if (!db) return null;

  try {
    const { data, error } = await db.from('poly_bets').insert({
      market_id: bet.marketId,
      question: bet.question,
      outcome: bet.outcome,
      shares: bet.shares,
      entry_price: bet.entryPrice,
      amount: bet.amount,
      confidence: bet.confidence,
      thesis: bet.thesis,
      strategy: bet.strategy,
      edge_pct: bet.edgePct,
    }).select();

    if (error) throw error;
    return data?.[0];
  } catch (err) {
    console.error('[DB] savePolyBet error:', err.message);
    return null;
  }
}

export async function settlePolyBet(id, won, settlementPrice) {
  const db = getClient();
  if (!db) return;

  try {
    const { error } = await db.from('poly_bets')
      .update({
        status: won ? 'won' : 'lost',
        settlement_price: settlementPrice,
        pnl: won ? (1.0 - (settlementPrice || 0)) * 100 : -(settlementPrice || 0) * 100,
        settled_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw error;
  } catch (err) {
    console.error('[DB] settlePolyBet error:', err.message);
  }
}

export async function getPolyStats() {
  const db = getClient();
  if (!db) return null;

  try {
    const { data } = await db.from('poly_bets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (!data) return null;

    const settled = data.filter(b => b.status === 'won' || b.status === 'lost');
    const wins = settled.filter(b => b.status === 'won');

    return {
      totalBets: data.length,
      openBets: data.filter(b => b.status === 'open').length,
      settledBets: settled.length,
      winRate: settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0,
      totalPnl: settled.reduce((s, b) => s + (b.pnl || 0), 0),
      recentBets: data.slice(0, 10),
    };
  } catch (err) {
    console.error('[DB] getPolyStats error:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// Stock Trades (Alpaca auto-trades)
// ═══════════════════════════════════════════════════════════

export async function saveTrade(trade) {
  const db = getClient();
  if (!db) return null;

  try {
    const { data, error } = await db.from('trades').insert({
      symbol: trade.symbol,
      side: trade.side,
      qty: trade.qty,
      entry_price: trade.entryPrice,
      amount: trade.amount,
      consensus: trade.consensus,
      gem_score: trade.gemScore,
      claude_confidence: trade.claudeConfidence,
      claude_thesis: trade.claudeThesis,
      signals: trade.signals,
    }).select();

    if (error) throw error;
    return data?.[0];
  } catch (err) {
    console.error('[DB] saveTrade error:', err.message);
    return null;
  }
}

export async function closeTrade(symbol, exitPrice, pnl, exitReason) {
  const db = getClient();
  if (!db) return;

  try {
    const { data: open } = await db.from('trades')
      .select('id, entry_price')
      .eq('symbol', symbol)
      .is('exit_price', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!open?.[0]) return;

    const { error } = await db.from('trades')
      .update({
        exit_price: exitPrice,
        pnl: Math.round(pnl * 100) / 100,
        exit_reason: exitReason,
        closed_at: new Date().toISOString(),
      })
      .eq('id', open[0].id);

    if (error) throw error;
  } catch (err) {
    console.error('[DB] closeTrade error:', err.message);
  }
}
