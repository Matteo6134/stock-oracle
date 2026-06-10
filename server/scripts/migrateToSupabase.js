/**
 * One-time migration: load agentTrades.json → Supabase stock_trade table
 * Run: node server/scripts/migrateToSupabase.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, '..', 'data', 'agentTrades.json');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function migrate() {
  const raw = fs.readFileSync(TRADES_FILE, 'utf8');
  const trades = JSON.parse(raw);

  console.log(`[Migration] Found ${trades.length} trades to migrate...\n`);

  let success = 0;
  let errors = 0;

  for (const t of trades) {
    const row = {
      symbol: t.symbol,
      side: t.side || 'buy',
      qty: t.price > 0 ? Math.floor(t.amount / t.price) : 1,
      entry_price: t.price || null,
      exit_price: t.exitPrice || null,
      exit_reason: t.exitReason || null,
      pnl: t.pnl || null,
      signals: t.signals || [],
      claude_confidence: t.claudeConfidence || null,
      claude_thesis: t.claudeThesis || null,
      gem_score: t.gemScore || null,
      created_at: t.timestamp || new Date().toISOString(),
    };

    const { error } = await supabase.from('stock_trade').insert(row);

    if (error) {
      console.error(`  ✗ ${t.symbol} (${t.timestamp}) — ${error.message}`);
      errors++;
    } else {
      const status = t.exitPrice ? `CLOSED (PnL: $${t.pnl})` : 'OPEN';
      console.log(`  ✓ ${t.symbol} @ $${t.price} — ${status}`);
      success++;
    }
  }

  console.log(`\n[Migration] Done! ${success} imported, ${errors} errors.`);
}

migrate().catch(err => {
  console.error('[Migration] Fatal error:', err);
  process.exit(1);
});
