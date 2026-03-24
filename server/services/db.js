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
    const { data, error } = await db.from('predictions').insert({
      symbol: prediction.symbol,
      action: prediction.action,
      confidence: prediction.confidence,
      thesis: prediction.thesis,
      risk_level: prediction.riskLevel,
      target_pct: prediction.targetPct,
      stop_pct: prediction.stopPct,
      timeframe_days: prediction.timeframeDays,
      entry_price: prediction.entryPrice,
      gem_score: prediction.gemScore,
      consensus: prediction.consensus,
      provider: prediction.provider || 'claude',
    }).select();

    if (error) throw error;
    return data?.[0];
  } catch (err) {
    console.error('[DB] savePrediction error:', err.message);
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
