/**
 * Google Sheets Logger — Log trades via Google Apps Script webhook
 *
 * Setup:
 * 1. Create a Google Sheet
 * 2. Extensions > Apps Script
 * 3. Paste the provided script (see bottom of this file)
 * 4. Deploy > New deployment > Web app > Anyone
 * 5. Copy the URL → add GOOGLE_SHEETS_WEBHOOK_URL to .env
 */

import axios from 'axios';

const WEBHOOK_URL = () => process.env.GOOGLE_SHEETS_WEBHOOK_URL;

/**
 * Log a new trade entry to Google Sheets.
 */
export async function logNewTrade(trade) {
  const url = WEBHOOK_URL();
  if (!url) return;

  const probability = trade.buyCount ? Math.round((trade.buyCount / 5) * 100) : 0;

  const row = {
    action: 'addTrade',
    data: {
      id: trade.id,
      dateTime: new Date(trade.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }),
      symbol: trade.symbol,
      side: 'Long',  // all auto-trades are buys (long)
      entryPrice: (trade.price || 0).toFixed(2),
      targetPct: trade.targetPct || 10,
      stopLossPct: trade.stopPct || 5,
      takeProfitPct: trade.targetPct || 10,
      probability: probability,
      amount: trade.amount,
      consensus: trade.consensus,
      gemScore: trade.gemScore,
      source: trade.source === 'penny' ? 'Penny Stocks' : 'Gem Finder',
      status: 'OPEN',
      exitPrice: '',
      pnl: '',
      exitReason: '',
    },
  };

  try {
    await axios.post(url, row, { timeout: 10000 });
    console.log(`[Sheets] Logged trade: ${trade.symbol} BUY $${trade.amount}`);
  } catch (err) {
    console.error('[Sheets] Failed to log trade:', err.message);
  }
}

/**
 * Update a trade with exit info.
 */
export async function updateTradeExit(trade) {
  const url = WEBHOOK_URL();
  if (!url) return;

  const pnlPct = trade.price ? ((((trade.exitPrice || 0) - trade.price) / trade.price) * 100).toFixed(1) : 0;

  const row = {
    action: 'updateTrade',
    data: {
      id: trade.id,
      status: 'CLOSED',
      exitPrice: (trade.exitPrice || 0).toFixed(2),
      pnl: `${(trade.pnl || 0) >= 0 ? '+' : ''}$${(trade.pnl || 0).toFixed(2)} (${pnlPct}%)`,
      exitReason: trade.exitReason || 'Manual close',
    },
  };

  try {
    await axios.post(url, row, { timeout: 10000 });
    console.log(`[Sheets] Updated trade: ${trade.symbol} → ${trade.exitReason}`);
  } catch (err) {
    console.error('[Sheets] Failed to update trade:', err.message);
  }
}

/*
 * ═══════════════════════════════════════════════════════
 * GOOGLE APPS SCRIPT — Copy this into your Google Sheet
 * ═══════════════════════════════════════════════════════
 *
 * function doPost(e) {
 *   var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
 *   var data = JSON.parse(e.postData.contents);
 *
 *   if (data.action === 'addTrade') {
 *     var d = data.data;
 *     // Add headers if sheet is empty
 *     if (sheet.getLastRow() === 0) {
 *       sheet.appendRow(['Date/Time', 'Symbol', 'Side', 'Entry $', 'Target %', 'SL %', 'TP %', 'Prob %', 'Amount $', 'Consensus', 'Score', 'Source', 'Status', 'Exit $', 'P/L', 'Exit Reason', 'Trade ID']);
 *     }
 *     sheet.appendRow([d.dateTime, d.symbol, d.side, d.entryPrice, d.targetPct + '%', d.stopLossPct + '%', d.takeProfitPct + '%', d.probability + '%', '$' + d.amount, d.consensus, d.gemScore, d.source, d.status, d.exitPrice, d.pnl, d.exitReason, d.id]);
 *   }
 *
 *   if (data.action === 'updateTrade') {
 *     var d = data.data;
 *     var rows = sheet.getDataRange().getValues();
 *     for (var i = 1; i < rows.length; i++) {
 *       if (rows[i][16] === d.id) { // Trade ID is column Q (index 16)
 *         sheet.getRange(i + 1, 13).setValue(d.status);     // Status
 *         sheet.getRange(i + 1, 14).setValue(d.exitPrice);  // Exit $
 *         sheet.getRange(i + 1, 15).setValue(d.pnl);        // P/L
 *         sheet.getRange(i + 1, 16).setValue(d.exitReason); // Exit Reason
 *         break;
 *       }
 *     }
 *   }
 *
 *   return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
 * }
 */
