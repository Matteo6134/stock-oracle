/**
 * Polymarket Paper Trading Simulator
 *
 * Virtual portfolio starting at $1,400. Tracks bets, positions, P&L.
 * Goal: $1,400 → $400,000 through compound betting with edge.
 *
 * Position sizing uses modified Kelly criterion:
 *   betSize = bankroll × (edge / odds) × kellyFraction
 *   where edge = claudeProbability - marketPrice
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'polyPortfolio.json');

const STARTING_BALANCE = 1400;
const GOAL = 400000;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_FILE)) {
      return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    }
  } catch { /* start fresh */ }
  return {
    balance: STARTING_BALANCE,
    positions: [],
    history: [],
    startDate: new Date().toISOString(),
    peakValue: STARTING_BALANCE,
  };
}

function savePortfolio(portfolio) {
  ensureDir();
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2), 'utf8');
}

/**
 * Get current portfolio state with live P&L calculations.
 */
export function getPortfolio() {
  const p = loadPortfolio();
  const positionValue = p.positions
    .filter(pos => pos.status === 'open')
    .reduce((sum, pos) => sum + (pos.shares * (pos.currentPrice || pos.entryPrice)), 0);

  const totalValue = p.balance + positionValue;
  const pnl = totalValue - STARTING_BALANCE;
  const pnlPct = (pnl / STARTING_BALANCE) * 100;
  const goalPct = Math.min(100, (totalValue / GOAL) * 100);

  // Track peak for drawdown
  if (totalValue > p.peakValue) p.peakValue = totalValue;
  const drawdown = p.peakValue > 0 ? ((p.peakValue - totalValue) / p.peakValue) * 100 : 0;

  const wins = p.history.filter(h => h.status === 'won').length;
  const losses = p.history.filter(h => h.status === 'lost').length;
  const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;

  return {
    balance: Math.round(p.balance * 100) / 100,
    positionValue: Math.round(positionValue * 100) / 100,
    totalValue: Math.round(totalValue * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    goal: GOAL,
    goalPct: Math.round(goalPct * 100) / 100,
    multiplier: Math.round((totalValue / STARTING_BALANCE) * 100) / 100,
    drawdown: Math.round(drawdown * 100) / 100,
    openPositions: p.positions.filter(pos => pos.status === 'open'),
    tradeCount: p.history.length,
    winRate,
    wins,
    losses,
    startDate: p.startDate,
  };
}

/**
 * Place a simulated bet on a Polymarket outcome.
 *
 * @param {object} params
 * @param {string} params.marketId - Polymarket market ID
 * @param {string} params.question - The market question
 * @param {string} params.outcome - 'Yes' or 'No'
 * @param {number} params.price - Current market price (0-1)
 * @param {number} params.amount - USD to bet
 * @param {number} params.claudeConfidence - Claude's confidence (1-10)
 * @param {string} params.claudeThesis - Claude's reasoning
 * @param {number} params.claudeProb - Claude's estimated real probability
 */
export function placeBet({ marketId, question, outcome, price, amount, claudeConfidence, claudeThesis, claudeProb }) {
  const p = loadPortfolio();

  if (amount > p.balance) {
    return { success: false, error: `Insufficient balance ($${p.balance.toFixed(2)} available)` };
  }
  if (amount < 1) {
    return { success: false, error: 'Minimum bet is $1' };
  }
  if (price <= 0 || price >= 1) {
    return { success: false, error: 'Invalid price (must be 0-1)' };
  }

  const shares = Math.round((amount / price) * 100) / 100; // shares = amount / price per share
  const edge = (claudeProb || 0.5) - price;

  const position = {
    id: randomUUID(),
    marketId,
    question: String(question).slice(0, 200),
    outcome,
    shares,
    entryPrice: price,
    currentPrice: price,
    amount: Math.round(amount * 100) / 100,
    edge: Math.round(edge * 1000) / 10, // as percentage
    claudeConfidence: claudeConfidence || 0,
    claudeThesis: String(claudeThesis || '').slice(0, 500),
    claudeProb: claudeProb || 0.5,
    timestamp: new Date().toISOString(),
    status: 'open',
    pnl: null,
  };

  p.balance -= amount;
  p.positions.push(position);
  savePortfolio(p);

  console.log(`[PolySim] BET ${outcome} on "${question.slice(0, 40)}..." — $${amount} at ${price} (edge ${position.edge}%, conf ${claudeConfidence})`);

  return { success: true, position };
}

/**
 * Update current prices for open positions (call periodically).
 */
export function updatePositionPrices(priceMap) {
  const p = loadPortfolio();
  let changed = false;

  for (const pos of p.positions) {
    if (pos.status !== 'open') continue;
    const newPrice = priceMap[pos.marketId];
    if (newPrice !== undefined && newPrice !== pos.currentPrice) {
      pos.currentPrice = Math.round(parseFloat(newPrice) * 100) / 100;
      changed = true;
    }
  }

  if (changed) savePortfolio(p);
}

/**
 * Settle a bet (market resolved).
 *
 * @param {string} positionId
 * @param {boolean} won - Did the outcome happen?
 */
export function settleBet(positionId, won) {
  const p = loadPortfolio();
  const pos = p.positions.find(pp => pp.id === positionId);
  if (!pos || pos.status !== 'open') return { success: false, error: 'Position not found or already settled' };

  if (won) {
    // Shares pay $1.00 each
    const payout = pos.shares * 1;
    pos.pnl = Math.round((payout - pos.amount) * 100) / 100;
    pos.status = 'won';
    p.balance += payout;
  } else {
    pos.pnl = -pos.amount;
    pos.status = 'lost';
    // No payout — shares worthless
  }

  pos.settledAt = new Date().toISOString();
  p.history.push({ ...pos });
  p.positions = p.positions.filter(pp => pp.id !== positionId);
  savePortfolio(p);

  console.log(`[PolySim] SETTLED ${pos.question.slice(0, 30)}... → ${won ? 'WON' : 'LOST'} (${pos.pnl >= 0 ? '+' : ''}$${pos.pnl})`);
  return { success: true, position: pos };
}

/**
 * Get trade history (most recent first).
 */
export function getTradeHistory(limit = 50) {
  const p = loadPortfolio();
  return [...p.history].reverse().slice(0, limit);
}

/**
 * Calculate optimal bet size using Kelly criterion.
 * kelly = (bp - q) / b
 * where b = odds, p = probability of winning, q = 1-p
 *
 * We use fractional Kelly (25%) to be conservative.
 */
export function calculateKellyBet(balance, marketPrice, claudeProbability, maxPct = 25) {
  const p = claudeProbability;
  const q = 1 - p;
  const b = (1 / marketPrice) - 1; // odds (e.g., price 0.6 → odds 0.667)

  if (b <= 0) return 0;

  const kellyFull = (b * p - q) / b;
  if (kellyFull <= 0) return 0; // No edge → don't bet

  // Fractional Kelly (25%) — safer
  const kellyFraction = kellyFull * 0.25;
  const betPct = Math.min(kellyFraction * 100, maxPct);
  const betAmount = Math.round(balance * (betPct / 100) * 100) / 100;

  return Math.max(1, betAmount); // Minimum $1
}

/**
 * Reset portfolio to starting state.
 */
export function resetPortfolio() {
  savePortfolio({
    balance: STARTING_BALANCE,
    positions: [],
    history: [],
    startDate: new Date().toISOString(),
    peakValue: STARTING_BALANCE,
  });
}
