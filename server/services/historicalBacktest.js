/**
 * Historical Backtest Engine
 *
 * Fetches daily OHLCV data from Yahoo Finance (going back to early 1990s for major stocks),
 * applies a signal strategy on each bar, simulates non-overlapping trades, and returns:
 *   - Equity curve vs buy-and-hold baseline
 *   - Key stats: total return, CAGR, win rate, max drawdown, profit factor
 *   - Individual trade log
 */

import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
  validation: { logErrors: false, logOptionsErrors: false },
});

// ── Indicator helpers ──

function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return Math.round(100 - 100 / (1 + rs));
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  const trs = bars.slice(-period).map((b, i, arr) => {
    const prev = i > 0 ? arr[i - 1].close : b.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  return trs.reduce((s, v) => s + v, 0) / period;
}

// ── Signal detection ──

function detectSignal(bars, i, strategy) {
  const LOOKBACK = 20;
  if (i < LOOKBACK + 5) return false;

  const win = bars.slice(i - LOOKBACK, i + 1);
  const closes = win.map(b => b.close);
  const vols = win.map(b => b.volume);
  const b = bars[i];

  const avgVol = sma(vols, LOOKBACK) || 1;
  const sma20 = sma(closes, LOOKBACK) || b.close;
  const sma50 = sma(bars.slice(Math.max(0, i - 50), i + 1).map(x => x.close), 50) || b.close;
  const highest20 = Math.max(...bars.slice(i - LOOKBACK, i).map(x => x.close));
  const curRsi = rsi(closes, 14);

  const volBoom = b.volume > avgVol * 1.6;        // volume 60%+ above avg
  const bullBar = b.close > b.open;               // green candle
  const aboveSMA20 = b.close > sma20;
  const aboveSMA50 = b.close > sma50;
  const breakout20 = b.close > highest20;         // 20-day high breakout
  const notOverbought = curRsi < 72;
  const isOversold = curRsi < 35;

  switch (strategy) {
    case 'volume_surge':
      // Raw volume explosion on a bullish day
      return volBoom && bullBar && aboveSMA20;

    case 'momentum':
      // Breaking out of 20-day high on high volume
      return breakout20 && volBoom && aboveSMA50;

    case 'mean_reversion':
      // Oversold bounce above trend
      return isOversold && aboveSMA50 && bullBar;

    case 'gem_finder':
    default:
      // Our custom combo: volume surge + uptrend, or breakout on volume, not overbought
      return notOverbought && (
        (volBoom && aboveSMA20 && bullBar) ||
        (breakout20 && volBoom)
      );
  }
}

// ── Date string helper ──

function ds(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().split('T')[0];
}

// ── Main backtest runner ──

export async function runHistoricalBacktest({ symbol, years = 5, holdDays = 5, strategy = 'gem_finder' }) {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - years);

  // Extra 90-day buffer so indicators are warm at start date
  const fetchFrom = new Date(fromDate);
  fetchFrom.setDate(fetchFrom.getDate() - 90);

  // Yahoo Finance has data going back to 1993 for most US stocks
  const maxFrom = new Date('1993-01-01');
  if (fetchFrom < maxFrom) fetchFrom.setTime(maxFrom.getTime());

  let rawHistory;
  try {
    rawHistory = await yf.historical(symbol.toUpperCase(), {
      period1: ds(fetchFrom),
      period2: ds(toDate),
      interval: '1d',
    });
  } catch (err) {
    throw new Error(`Yahoo Finance error: ${err.message}`);
  }

  if (!rawHistory || rawHistory.length < 50) {
    throw new Error(`Not enough historical data for ${symbol} (${rawHistory?.length || 0} bars). Try a shorter period or check the ticker.`);
  }

  const bars = [...rawHistory]
    .filter(b => b.open > 0 && b.close > 0 && b.volume > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const startTs = fromDate.getTime();
  const startIdx = bars.findIndex(b => new Date(b.date).getTime() >= startTs);
  if (startIdx < 25) throw new Error('Not enough lookback bars before start date');

  // Buy-and-hold baseline: $10,000 in at the first bar
  const bhEntry = bars[startIdx].close;
  const bhShares = 10000 / bhEntry;

  // ── Strategy simulation ──
  let equity = 10000;
  const trades = [];
  const equityByDate = new Map();
  let i = startIdx;

  while (i < bars.length - holdDays - 2) {
    const b = bars[i];
    equityByDate.set(ds(b.date), equity);

    if (detectSignal(bars, i, strategy)) {
      const entryIdx = i + 1;
      const exitIdx = Math.min(i + holdDays + 1, bars.length - 1);

      const entryPrice = bars[entryIdx].open || bars[entryIdx].close;
      const exitPrice = bars[exitIdx].open || bars[exitIdx].close;

      if (!entryPrice || !exitPrice || entryPrice <= 0) { i++; continue; }

      const plPct = (exitPrice - entryPrice) / entryPrice * 100;
      const positionSize = equity * 0.15; // 15% of equity per trade
      const plDollar = positionSize * (plPct / 100);
      equity += plDollar;
      if (equity < 10) equity = 10; // floor to avoid collapse

      const entryDate = ds(bars[entryIdx].date);
      const exitDate = ds(bars[exitIdx].date);

      trades.push({
        signalDate: ds(bars[i].date),
        entryDate,
        exitDate,
        entry: Math.round(entryPrice * 100) / 100,
        exit: Math.round(exitPrice * 100) / 100,
        plPct: Math.round(plPct * 100) / 100,
        plDollar: Math.round(plDollar * 100) / 100,
        equity: Math.round(equity * 100) / 100,
        win: plPct > 0,
      });

      // Mark every day in the hold as the updated equity
      for (let j = entryIdx; j <= exitIdx; j++) {
        equityByDate.set(ds(bars[j].date), Math.round(equity * 100) / 100);
      }

      i = exitIdx + 1;
    } else {
      i++;
    }
  }

  // ── Build equity curve (fill gaps with last known value) ──
  const equityCurve = [];
  let lastEquity = 10000;

  for (const b of bars.slice(startIdx)) {
    const d = ds(b.date);
    if (equityByDate.has(d)) lastEquity = equityByDate.get(d);
    equityCurve.push({
      date: d,
      equity: lastEquity,
      bh: Math.round(bhShares * b.close * 100) / 100,
    });
  }

  // Downsample to max 250 points for the chart
  const maxPts = 250;
  const step = Math.max(1, Math.floor(equityCurve.length / maxPts));
  const sampled = equityCurve.filter((_, idx) => idx % step === 0);
  if (sampled[sampled.length - 1] !== equityCurve[equityCurve.length - 1]) {
    sampled.push(equityCurve[equityCurve.length - 1]);
  }

  // ── Stats ──
  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const totalReturn = ((equity - 10000) / 10000) * 100;
  const cagr = years > 0 ? (Math.pow(equity / 10000, 1 / years) - 1) * 100 : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.plPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.plPct, 0) / losses.length) : 0.001;
  const profitFactor = avgWinPct / avgLossPct;
  const bhFinalValue = bhShares * bars[bars.length - 1].close;
  const bhReturn = ((bhFinalValue - 10000) / 10000) * 100;

  // Max drawdown
  let peak = 10000, maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? ((peak - pt.equity) / peak * 100) : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    symbol: symbol.toUpperCase(),
    strategy,
    years,
    holdDays,
    dataRange: {
      from: ds(bars[startIdx].date),
      to: ds(bars[bars.length - 1].date),
      totalBars: bars.length - startIdx,
    },
    stats: {
      totalReturn: Math.round(totalReturn * 100) / 100,
      cagr: Math.round(cagr * 100) / 100,
      winRate: trades.length > 0 ? Math.round(wins.length / trades.length * 100) : 0,
      totalTrades: trades.length,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
      avgWin: Math.round(avgWinPct * 100) / 100,
      avgLoss: Math.round(avgLossPct * 100) / 100,
      bestTrade: trades.length > 0 ? Math.max(...trades.map(t => t.plPct)) : 0,
      worstTrade: trades.length > 0 ? Math.min(...trades.map(t => t.plPct)) : 0,
      finalEquity: Math.round(equity * 100) / 100,
      bhReturn: Math.round(bhReturn * 100) / 100,
      bhFinalEquity: Math.round(bhFinalValue * 100) / 100,
      // Beat buy-and-hold?
      beatBH: totalReturn > bhReturn,
    },
    equityCurve: sampled,
    recentTrades: [...trades].reverse().slice(0, 50),
  };
}
