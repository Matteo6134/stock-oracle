/**
 * Multi-Day Signal Tracker
 *
 * The #1 predictor of a 10%+ move in 1-5 days is SIGNAL PERSISTENCE:
 * A stock showing accumulation/compression signals for 2-5 consecutive days
 * is exponentially more likely to explode than one showing it for 1 day.
 *
 * This service tracks signal evolution over consecutive days and assigns
 * progressive urgency stages:
 *
 *   BUILDING  (Day 1-2)  — Initial detection, signals appearing
 *   LOADING   (Day 2-4)  — Signals strengthening, score rising
 *   IMMINENT  (Day 3+)   — Max conviction, expect move within 1-3 days
 *
 * Persistence: server/data/signalTracker.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_FILE = path.join(__dirname, '..', 'data', 'signalTracker.json');

const dataDir = path.dirname(TRACKER_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Signals that indicate LOADING (pre-move accumulation) ──
const LOADING_SIGNALS = new Set([
  'multi_day_accumulation', 'stealth_accumulation', 'volume_acceleration',
  'smart_money', 'insider_buying', 'institutions_accumulating',
  'bullish_options', 'unusual_options_volume',
  'bb_squeeze', 'price_compression', 'volume_contraction',
  'short_squeeze_loading',
]);

// ── Signals that indicate the move is STARTING (day 0-1) ──
const BREAKOUT_SIGNALS = new Set([
  'early_momentum', 'early_breakout', 'momentum_acceleration',
  'gap_up_momentum', 'gap_up_explosive', 'unusual_volume',
  'low_float_volume', 'near_52w_high', 'bull_flag',
]);

function loadTracker() {
  if (!fs.existsSync(TRACKER_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
  } catch { return {}; }
}

function saveTracker(data) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Update the signal tracker with today's gem scan results.
 * Call this after every gem scan.
 *
 * @param {Array} gems - Array of gem objects from the scanner
 * @returns {Object} Updated tracker data
 */
export function updateSignalTracker(gems) {
  if (!gems?.length) return loadTracker();

  const tracker = loadTracker();
  const today = new Date().toISOString().split('T')[0];

  // Track which symbols appeared today
  const todaySymbols = new Set();

  for (const gem of gems) {
    const sym = gem.symbol;
    if (!sym) continue;
    todaySymbols.add(sym);

    const loadingSignals = (gem.signals || []).filter(s => LOADING_SIGNALS.has(s));
    const breakoutSignals = (gem.signals || []).filter(s => BREAKOUT_SIGNALS.has(s));

    if (!tracker[sym]) {
      // New entry — first day seeing this stock
      tracker[sym] = {
        firstSeen: today,
        lastUpdate: today,
        consecutiveDays: 1,
        totalAppearances: 1,
        stage: 'BUILDING',
        history: [{
          date: today,
          gemScore: gem.gemScore || 0,
          price: gem.price || 0,
          signals: gem.signals || [],
          loadingSignalCount: loadingSignals.length,
          breakoutSignalCount: breakoutSignals.length,
          consensus: gem.consensus || '',
          volumeRatio: gem.volumeRatio || 0,
        }],
        peakScore: gem.gemScore || 0,
        scoreTrajectory: 'rising', // rising, flat, falling
        companyName: gem.companyName || '',
        explosion: gem.explosion || null,
      };
    } else {
      const entry = tracker[sym];

      // Check if this is a consecutive day or a gap
      const lastDate = entry.lastUpdate;
      const daysDiff = dateDiffDays(lastDate, today);

      if (daysDiff === 0) {
        // Same day — update if higher score
        const lastHist = entry.history[entry.history.length - 1];
        if ((gem.gemScore || 0) > (lastHist?.gemScore || 0)) {
          lastHist.gemScore = gem.gemScore || 0;
          lastHist.signals = gem.signals || [];
          lastHist.loadingSignalCount = loadingSignals.length;
          lastHist.breakoutSignalCount = breakoutSignals.length;
          lastHist.consensus = gem.consensus || '';
          lastHist.volumeRatio = gem.volumeRatio || 0;
          lastHist.price = gem.price || 0;
        }
      } else if (daysDiff === 1 || (daysDiff <= 3 && isWeekendGap(lastDate, today))) {
        // Consecutive day (accounting for weekends)
        entry.consecutiveDays++;
        entry.totalAppearances++;
        entry.lastUpdate = today;
        entry.history.push({
          date: today,
          gemScore: gem.gemScore || 0,
          price: gem.price || 0,
          signals: gem.signals || [],
          loadingSignalCount: loadingSignals.length,
          breakoutSignalCount: breakoutSignals.length,
          consensus: gem.consensus || '',
          volumeRatio: gem.volumeRatio || 0,
        });
        // Keep last 10 days of history
        if (entry.history.length > 10) entry.history = entry.history.slice(-10);
      } else {
        // Gap > 1 business day — reset streak but keep history
        entry.consecutiveDays = 1;
        entry.totalAppearances++;
        entry.lastUpdate = today;
        entry.history.push({
          date: today,
          gemScore: gem.gemScore || 0,
          price: gem.price || 0,
          signals: gem.signals || [],
          loadingSignalCount: loadingSignals.length,
          breakoutSignalCount: breakoutSignals.length,
          consensus: gem.consensus || '',
          volumeRatio: gem.volumeRatio || 0,
        });
        if (entry.history.length > 10) entry.history = entry.history.slice(-10);
      }

      // Update peak score
      if ((gem.gemScore || 0) > entry.peakScore) {
        entry.peakScore = gem.gemScore || 0;
      }

      // Calculate score trajectory
      entry.scoreTrajectory = calcScoreTrajectory(entry.history);

      // Update stage
      entry.stage = calcStage(entry);

      // Update explosion prediction
      entry.explosion = gem.explosion || entry.explosion;
      entry.companyName = gem.companyName || entry.companyName;
    }
  }

  // Decay entries not seen today: if a stock hasn't appeared for 5+ business days, remove it
  for (const sym of Object.keys(tracker)) {
    if (!todaySymbols.has(sym)) {
      const daysSinceUpdate = dateDiffDays(tracker[sym].lastUpdate, today);
      if (daysSinceUpdate > 7) {
        delete tracker[sym];
      } else if (daysSinceUpdate > 0) {
        // Mark as cooling if not seen today
        tracker[sym].stage = tracker[sym].consecutiveDays >= 3 ? 'COOLING' : tracker[sym].stage;
      }
    }
  }

  saveTracker(tracker);
  return tracker;
}

/**
 * Calculate the urgency stage based on signal history.
 */
function calcStage(entry) {
  const days = entry.consecutiveDays;
  const trajectory = entry.scoreTrajectory;
  const latestHist = entry.history[entry.history.length - 1];
  const latestScore = latestHist?.gemScore || 0;
  const loadingCount = latestHist?.loadingSignalCount || 0;
  const breakoutCount = latestHist?.breakoutSignalCount || 0;

  // IMMINENT: 3+ consecutive days, score rising or high, strong loading signals
  if (days >= 3 && latestScore >= 60 && (trajectory === 'rising' || trajectory === 'flat')) {
    return 'IMMINENT';
  }
  if (days >= 2 && latestScore >= 75 && loadingCount >= 3) {
    return 'IMMINENT';
  }
  // Also IMMINENT if breakout signals are firing on a loaded setup
  if (days >= 2 && breakoutCount >= 2 && loadingCount >= 2) {
    return 'IMMINENT';
  }

  // LOADING: 2+ days with increasing conviction
  if (days >= 2 && (trajectory === 'rising' || latestScore >= 55)) {
    return 'LOADING';
  }
  if (days >= 2 && loadingCount >= 2) {
    return 'LOADING';
  }

  // BUILDING: day 1, or signals still forming
  return 'BUILDING';
}

/**
 * Calculate score trajectory from history entries.
 */
function calcScoreTrajectory(history) {
  if (history.length < 2) return 'rising'; // first day = assume rising
  const scores = history.slice(-3).map(h => h.gemScore);
  if (scores.length < 2) return 'flat';

  const lastScore = scores[scores.length - 1];
  const prevScore = scores[scores.length - 2];
  const diff = lastScore - prevScore;

  if (diff > 5) return 'rising';
  if (diff < -10) return 'falling';
  return 'flat';
}

/**
 * Get all tracked stocks, sorted by urgency and score.
 * @returns {Array} Sorted list of tracked stocks with full context
 */
export function getTrackedStocks() {
  const tracker = loadTracker();
  const stocks = [];

  for (const [symbol, data] of Object.entries(tracker)) {
    const latest = data.history[data.history.length - 1];
    if (!latest) continue;

    stocks.push({
      symbol,
      companyName: data.companyName || '',
      stage: data.stage,
      consecutiveDays: data.consecutiveDays,
      totalAppearances: data.totalAppearances,
      firstSeen: data.firstSeen,
      lastUpdate: data.lastUpdate,
      currentScore: latest.gemScore,
      peakScore: data.peakScore,
      scoreTrajectory: data.scoreTrajectory,
      currentPrice: latest.price,
      currentSignals: latest.signals,
      loadingSignalCount: latest.loadingSignalCount,
      breakoutSignalCount: latest.breakoutSignalCount,
      consensus: latest.consensus,
      volumeRatio: latest.volumeRatio,
      explosion: data.explosion,
      history: data.history,
    });
  }

  // Sort: IMMINENT first, then LOADING, then BUILDING. Within same stage, by score.
  const stageOrder = { IMMINENT: 0, LOADING: 1, BUILDING: 2, COOLING: 3 };
  stocks.sort((a, b) => {
    const stageDiff = (stageOrder[a.stage] ?? 4) - (stageOrder[b.stage] ?? 4);
    if (stageDiff !== 0) return stageDiff;
    return b.currentScore - a.currentScore;
  });

  return stocks;
}

/**
 * Get only stocks at IMMINENT or LOADING stage.
 */
export function getHotStocks() {
  return getTrackedStocks().filter(s => s.stage === 'IMMINENT' || s.stage === 'LOADING');
}

// ── Helpers ──

function dateDiffDays(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00Z');
  const d2 = new Date(dateStr2 + 'T00:00:00Z');
  return Math.round((d2 - d1) / (24 * 60 * 60 * 1000));
}

function isWeekendGap(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00Z');
  const d2 = new Date(dateStr2 + 'T00:00:00Z');
  const day1 = d1.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const diff = Math.round((d2 - d1) / (24 * 60 * 60 * 1000));
  // Friday → Monday = 3 days, but only 1 business day gap
  return (day1 === 5 && diff <= 3) || (day1 === 4 && diff <= 4);
}
