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
      confidence: Math.round(gem.avgConviction || 3),
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
      // FIX: schema column is `timeframe_days` (not `predicted_days`) — see saveExplosionPrediction
      const predictedDays = pred.timeframe_days || pred.predicted_days || 5;

      // Only resolve if enough time has passed (predicted days + 1 buffer day)
      if (ageInDays < predictedDays + 1) continue;

      // Get current price
      try {
        const quote = await getQuoteFn(pred.symbol);
        const currentPrice = quote?.regularMarketPrice;
        if (!currentPrice || !pred.entry_price) continue;

        const actualPct = Math.round(((currentPrice - pred.entry_price) / pred.entry_price) * 10000) / 100;
        const targetPct = pred.target_pct || 10;
        // Hit if got 50%+ of predicted gain (e.g. predicted +10% → hit if actual >= +5%)
        const hit = actualPct >= targetPct * 0.5;
        // Outcome reflects target attainment, not just direction — feeds signalLearner correctly
        const outcome = hit ? 'win' : (actualPct > 0 ? 'partial' : 'loss');

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
// Daily Picks (1-day MOO/MOC bot)
// ═══════════════════════════════════════════════════════════

/**
 * Upsert a daily pick into Supabase. Idempotent on (pick_date, symbol).
 * Order ids and dollar allocation are added by submitDayTradeOrders → updateDailyPickOrderIds.
 *
 * @param {Object} pick                The DailyPick object from dailyPicker.js
 * @param {number} [rank=1]            1 = top pick, 2 = second, etc.
 * @returns {Promise<Object|null>}     The inserted/updated row, or null on failure
 */
export async function saveDailyPick(pick, rank = 1) {
  const db = getClient();
  if (!db) return null;
  try {
    const row = {
      pick_date: pick.pickDate,
      symbol: pick.symbol,
      rank,
      composite_score: pick.compositeScore,
      gem_score: pick.gemScore,
      claude_confidence: pick.claudeConfidence,
      explosion_prob: pick.explosionProb,
      entry_price: pick.entryPrice,
      expected_return_pct: pick.expectedReturnPct,
      reasoning: pick.reasoning,
      signals: pick.signals || [],
    };
    const { data, error } = await db
      .from('daily_picks')
      .upsert(row, { onConflict: 'pick_date,symbol' })
      .select();
    if (error) throw error;
    return data?.[0] || null;
  } catch (err) {
    console.error('[DB] saveDailyPick error:', err.message);
    return null;
  }
}

/**
 * Attach Alpaca order ids + dollar allocation to a previously-saved pick.
 * Called by dailyPicker after MOO/MOC submission succeeds.
 */
export async function updateDailyPickOrderIds(pickDate, symbol, { buyOrderId, sellOrderId, dollarAllocated }) {
  const db = getClient();
  if (!db) return;
  try {
    const { error } = await db
      .from('daily_picks')
      .update({
        alpaca_buy_order_id: buyOrderId,
        alpaca_sell_order_id: sellOrderId,
        dollar_allocated: dollarAllocated,
        outcome: 'pending',
      })
      .eq('pick_date', pickDate)
      .eq('symbol', symbol);
    if (error) throw error;
  } catch (err) {
    console.error('[DB] updateDailyPickOrderIds error:', err.message);
  }
}

/**
 * Settle a daily pick after MOC fills. Computes realized P&L net of slippage.
 */
export async function settleDailyPick(pickDate, symbol, { fillOpen, fillClose, qty }) {
  const db = getClient();
  if (!db) return;
  try {
    if (!fillOpen || !fillClose || !qty) {
      await db.from('daily_picks')
        .update({ outcome: 'pending', settled_at: null })
        .eq('pick_date', pickDate).eq('symbol', symbol);
      return;
    }
    const realizedPnl = (fillClose - fillOpen) * qty;
    const realizedPct = ((fillClose - fillOpen) / fillOpen) * 100;
    // 'win' if >= +1% (covers slippage); 'partial' if positive but < 1%; 'loss' if <= 0
    const outcome = realizedPct >= 1 ? 'win' : (realizedPct > 0 ? 'partial' : 'loss');
    const { error } = await db
      .from('daily_picks')
      .update({
        outcome,
        fill_price_open: fillOpen,
        fill_price_close: fillClose,
        realized_pnl: Math.round(realizedPnl * 100) / 100,
        realized_pct: Math.round(realizedPct * 100) / 100,
        settled_at: new Date().toISOString(),
      })
      .eq('pick_date', pickDate)
      .eq('symbol', symbol);
    if (error) throw error;
  } catch (err) {
    console.error('[DB] settleDailyPick error:', err.message);
  }
}

/**
 * Resolve daily picks against Alpaca's actual fills. Called by cron after MOC settles.
 *
 * @param {Object} alpacaModule  The alpaca service (so this file stays decoupled)
 * @returns {Promise<{ resolved: number, results: Array }>}
 */
export async function resolveDailyPickFills(alpacaModule) {
  const db = getClient();
  if (!db) return { resolved: 0, results: [] };
  try {
    // Get pending picks from the last 5 trading days
    const { data: pending } = await db
      .from('daily_picks')
      .select('*')
      .in('outcome', ['pending'])
      .not('alpaca_buy_order_id', 'is', null)
      .order('pick_date', { ascending: true })
      .limit(50);
    if (!pending?.length) return { resolved: 0, results: [] };

    const results = [];
    for (const p of pending) {
      try {
        const buy = await alpacaModule.getOrder(p.alpaca_buy_order_id);
        const sell = await alpacaModule.getOrder(p.alpaca_sell_order_id);
        if (!buy?.filledAt || !sell?.filledAt) continue;   // not yet filled, skip
        const fillOpen = Number(buy.filledAvgPrice);
        const fillClose = Number(sell.filledAvgPrice);
        const qty = Number(buy.filledQty);
        await settleDailyPick(p.pick_date, p.symbol, { fillOpen, fillClose, qty });
        // Mirror to legacy stock_trade table for unified P&L queries
        try {
          await db.from('stock_trade').insert({
            symbol: p.symbol,
            side: 'buy',
            qty,
            entry_price: fillOpen,
            exit_price: fillClose,
            exit_reason: 'MOC settled',
            pnl: Math.round((fillClose - fillOpen) * qty * 100) / 100,
            signals: p.signals || [],
            gem_score: p.gem_score,
            claude_confidence: p.claude_confidence,
          });
        } catch (mirrorErr) {
          // non-fatal; daily_picks is the source of truth
          console.warn('[DB] stock_trade mirror skip:', mirrorErr.message);
        }
        results.push({ symbol: p.symbol, pickDate: p.pick_date, fillOpen, fillClose, pnlPct: ((fillClose - fillOpen) / fillOpen * 100).toFixed(2) });
      } catch (err) {
        console.warn(`[DB] resolve failed ${p.symbol} ${p.pick_date}:`, err.message);
      }
    }
    return { resolved: results.length, results };
  } catch (err) {
    console.error('[DB] resolveDailyPickFills error:', err.message);
    return { resolved: 0, results: [] };
  }
}

// ═══════════════════════════════════════════════════════════
// Polymarket Bets
// ═══════════════════════════════════════════════════════════

// Polymarket helpers (savePolyBet / settlePolyBet / getPolyStats) removed —
// the poly* services were deleted and nothing referenced these. Dead code.

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
