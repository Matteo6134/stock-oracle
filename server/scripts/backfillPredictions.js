/**
 * One-shot backfill — resolves all stuck predictions in Supabase.
 * Run after fixing the field-name and timezone bugs in db.js / index.js.
 *
 *   node server/scripts/backfillPredictions.js
 */
import 'dotenv/config';
import { resolveExplosionPredictions } from '../services/db.js';
import * as yahooFinance from '../services/yahooFinance.js';

async function main() {
  let total = 0;
  let totalHits = 0;
  for (let pass = 1; pass <= 10; pass++) {
    const result = await resolveExplosionPredictions(yahooFinance.getQuote);
    if (!result?.resolved) {
      console.log(`Pass ${pass}: no more to resolve, stopping`);
      break;
    }
    const hits = (result.results || []).filter(r => r.hit).length;
    total += result.resolved;
    totalHits += hits;
    console.log(`Pass ${pass}: resolved ${result.resolved} (${hits} hit target)`);
  }
  console.log(`\nDone. Total resolved: ${total}, hits: ${totalHits} (${total ? Math.round(totalHits / total * 100) : 0}%)`);
  process.exit(0);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
