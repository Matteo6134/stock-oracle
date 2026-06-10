import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('[Supabase] Client initialized for background logging');
} else {
  console.warn('[Supabase] Credentials missing. Logging disabled.');
}

/**
 * Log a new trade entry to Supabase.
 */
export async function logNewTrade(trade) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('stock_trade').insert({
      symbol: trade.symbol,
      side: trade.side || 'buy',
      qty: trade.amount ? trade.amount / (trade.price || 1) : 1,
      entry_price: trade.price,
      amount: trade.amount,
      consensus: trade.consensus,
      gem_score: trade.gemScore,
      claude_confidence: trade.claudeConfidence,
      claude_thesis: trade.claudeThesis,
      signals: trade.signals || [],
    });
    if (error) throw error;
  } catch (err) {
    console.error('[Supabase] Error logging new trade:', err.message);
  }
}

/**
 * Log a trade exit to Supabase.
 */
export async function logTradeExit(trade) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('stock_trade')
      .update({
        exit_price: trade.exitPrice,
        pnl: trade.pnl,
        exit_reason: trade.exitReason,
        closed_at: new Date().toISOString()
      })
      .eq('symbol', trade.symbol)
      .is('exit_price', null);
      
    if (error) throw error;
  } catch (err) {
    console.error('[Supabase] Error logging trade exit:', err.message);
  }
}
