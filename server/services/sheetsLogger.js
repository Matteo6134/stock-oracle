/**
 * Stock Oracle — Google Sheets Logger
 *
 * Uses a Google Apps Script web app as a simple webhook.
 * No OAuth needed — user deploys the script and pastes the URL in .env.
 *
 * Setup (one-time, 2 minutes):
 * 1. Open Google Sheets → Extensions → Apps Script
 * 2. Paste the script from the comment block below
 * 3. Deploy → New deployment → Web app → Anyone → Deploy
 * 4. Copy the web app URL → add to .env as GOOGLE_SHEETS_WEBHOOK_URL=https://...
 *
 * ─── Google Apps Script to paste ───────────────────────────────────────────
 *
 * function doPost(e) {
 *   try {
 *     const data = JSON.parse(e.postData.contents);
 *     const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
 *
 *     if (data.action === 'new_trade') {
 *       sheet.appendRow([
 *         data.dateTime,      // A: Date/Time
 *         data.symbol,        // B: Symbol
 *         data.side,          // C: Long/Short
 *         data.entryPrice,    // D: Entry $
 *         data.targetPct,     // E: Target %
 *         data.stopPct,       // F: SL %
 *         data.tpPrice,       // G: TP Price $
 *         data.slPrice,       // H: SL Price $
 *         data.probability,   // I: Probability %
 *         data.amount,        // J: Amount $
 *         data.consensus,     // K: Consensus
 *         data.agents,        // L: Agents
 *         data.gemScore,      // M: Gem Score
 *         data.source,        // N: Source
 *         'Open',             // O: Status
 *         '',                 // P: Exit $
 *         '',                 // Q: P/L $
 *         '',                 // R: Exit Reason
 *       ]);
 *     }
 *
 *     if (data.action === 'exit_trade') {
 *       const sheet2 = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
 *       sheet2.appendRow([
 *         data.dateTime,
 *         data.symbol,
 *         data.side,
 *         data.entryPrice,
 *         data.targetPct,
 *         data.stopPct,
 *         data.tpPrice,
 *         data.slPrice,
 *         data.probability,
 *         data.amount,
 *         data.consensus,
 *         data.agents,
 *         data.gemScore,
 *         data.source,
 *         'Closed',
 *         data.exitPrice,
 *         data.pnl,
 *         data.exitReason,
 *       ]);
 *     }
 *
 *     return ContentService.createTextOutput(JSON.stringify({ ok: true }))
 *       .setMimeType(ContentService.MimeType.JSON);
 *   } catch (err) {
 *     return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
 *       .setMimeType(ContentService.MimeType.JSON);
 *   }
 * }
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

const WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

function fmt$(n) { return n != null ? Number(n).toFixed(2) : ''; }
function fmtPct(n) { return n != null ? Number(n).toFixed(1) : ''; }

async function post(payload) {
  if (!WEBHOOK_URL) return; // silently skip if not configured
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('[Sheets] Webhook returned', res.status);
    }
  } catch (err) {
    console.warn('[Sheets] Webhook error:', err.message);
  }
}

/**
 * Log a new trade entry to Google Sheets.
 * @param {Object} trade - trade entry from autoTrader.js
 */
export async function logNewTrade(trade) {
  const entryPrice = trade.price || 0;
  const tpPrice = entryPrice > 0 ? fmt$(entryPrice * (1 + (trade.targetPct || 10) / 100)) : '';
  const slPrice = entryPrice > 0 ? fmt$(entryPrice * (1 - (trade.stopPct || 5) / 100)) : '';
  const probability = trade.buyCount != null
    ? Math.round((trade.buyCount / 5) * 100)
    : null;

  await post({
    action: 'new_trade',
    dateTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    symbol: trade.symbol,
    side: 'Long',
    entryPrice: fmt$(entryPrice),
    targetPct: fmtPct(trade.targetPct),
    stopPct: fmtPct(trade.stopPct),
    tpPrice,
    slPrice,
    probability: probability != null ? `${probability}%` : '',
    amount: fmt$(trade.amount),
    consensus: trade.consensus || '',
    agents: (trade.agents || []).join(', '),
    gemScore: trade.gemScore || '',
    source: trade.source || '',
  });
}

/**
 * Log a trade exit (stop loss / take profit / trailing stop).
 * @param {Object} trade - closed trade entry from autoTrader.js
 */
export async function logTradeExit(trade) {
  const entryPrice = trade.price || 0;
  const tpPrice = entryPrice > 0 ? fmt$(entryPrice * (1 + (trade.targetPct || 10) / 100)) : '';
  const slPrice = entryPrice > 0 ? fmt$(entryPrice * (1 - (trade.stopPct || 5) / 100)) : '';
  const probability = trade.buyCount != null
    ? Math.round((trade.buyCount / 5) * 100)
    : null;

  await post({
    action: 'exit_trade',
    dateTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    symbol: trade.symbol,
    side: 'Long',
    entryPrice: fmt$(entryPrice),
    targetPct: fmtPct(trade.targetPct),
    stopPct: fmtPct(trade.stopPct),
    tpPrice,
    slPrice,
    probability: probability != null ? `${probability}%` : '',
    amount: fmt$(trade.amount),
    consensus: trade.consensus || '',
    agents: (trade.agents || []).join(', '),
    gemScore: trade.gemScore || '',
    source: trade.source || '',
    exitPrice: fmt$(trade.exitPrice),
    pnl: fmt$(trade.pnl),
    exitReason: trade.exitReason || '',
  });
}
