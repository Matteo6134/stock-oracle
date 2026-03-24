/**
 * Polymarket Momentum Detection
 *
 * Tracks price history in memory and detects significant moves.
 * When a market moves 5%+ in 1h or 10%+ in 4h, something happened.
 * Either ride the momentum or fade the overreaction.
 */

// marketId → [{ yesPrice, timestamp }]
const priceHistory = new Map();
const MAX_HISTORY_PER_MARKET = 200; // ~50 hours of 15-min data

/**
 * Record current prices for all markets. Call every scan cycle.
 */
export function recordPrices(markets) {
  const now = Date.now();
  let recorded = 0;

  for (const m of markets) {
    if (!m.id || m.yesPrice == null) continue;

    if (!priceHistory.has(m.id)) {
      priceHistory.set(m.id, []);
    }

    const history = priceHistory.get(m.id);
    history.push({
      yesPrice: m.yesPrice,
      noPrice: m.noPrice || (1 - m.yesPrice),
      volume: m.volume || 0,
      ts: now,
    });

    // Trim old data
    if (history.length > MAX_HISTORY_PER_MARKET) {
      history.splice(0, history.length - MAX_HISTORY_PER_MARKET);
    }

    recorded++;
  }

  console.log(`[Momentum] Recorded prices for ${recorded} markets (${priceHistory.size} total tracked)`);
}

/**
 * Calculate price change over a time window.
 */
function getPriceChange(history, windowMs) {
  if (history.length < 2) return null;

  const now = history[history.length - 1];
  const cutoff = now.ts - windowMs;

  // Find the oldest point within the window
  let oldest = null;
  for (const point of history) {
    if (point.ts >= cutoff) {
      oldest = point;
      break;
    }
  }

  if (!oldest || oldest === now) return null;

  const change = Math.round((now.yesPrice - oldest.yesPrice) * 1000) / 10; // percentage points
  const volumeChange = now.volume - oldest.volume;

  return { change, volumeChange, from: oldest.yesPrice, to: now.yesPrice };
}

/**
 * Detect markets with significant momentum.
 * Returns sorted list of strongest moves.
 */
export function detectMomentum(markets) {
  const signals = [];
  const HOUR = 3600000;

  for (const m of markets) {
    if (!m.id || !priceHistory.has(m.id)) continue;

    const history = priceHistory.get(m.id);
    if (history.length < 3) continue; // Need at least 3 data points

    const m1h = getPriceChange(history, 1 * HOUR);
    const m4h = getPriceChange(history, 4 * HOUR);
    const m24h = getPriceChange(history, 24 * HOUR);

    // Check if any timeframe has a significant move
    const abs1h = Math.abs(m1h?.change || 0);
    const abs4h = Math.abs(m4h?.change || 0);
    const abs24h = Math.abs(m24h?.change || 0);

    const has1hMove = abs1h >= 5;   // 5% in 1 hour
    const has4hMove = abs4h >= 10;  // 10% in 4 hours
    const has24hMove = abs24h >= 15; // 15% in 24 hours

    if (!has1hMove && !has4hMove && !has24hMove) continue;

    // Determine direction (use shortest significant timeframe)
    const primaryChange = has1hMove ? m1h.change : has4hMove ? m4h.change : m24h.change;
    const direction = primaryChange > 0 ? 'up' : 'down';

    // Check if all timeframes agree (strong momentum)
    const allAgree = [m1h?.change, m4h?.change, m24h?.change]
      .filter(c => c != null && Math.abs(c) > 1)
      .every(c => (c > 0) === (primaryChange > 0));

    // Strength: how many timeframes show significant moves
    const sigCount = [has1hMove, has4hMove, has24hMove].filter(Boolean).length;
    const strength = sigCount >= 3 ? 'strong' : sigCount >= 2 ? 'moderate' : 'weak';

    signals.push({
      id: m.id,
      question: m.question,
      yesPrice: m.yesPrice,
      noPrice: m.noPrice || (1 - m.yesPrice),
      volume: m.volume,
      endDate: m.endDate,
      momentum1h: m1h?.change || 0,
      momentum4h: m4h?.change || 0,
      momentum24h: m24h?.change || 0,
      direction,
      strength,
      allAgree,
      maxMove: Math.max(abs1h, abs4h, abs24h),
      thesis: buildMomentumThesis(m, m1h, m4h, m24h, direction, strength),
    });
  }

  // Sort by strongest moves first
  return signals.sort((a, b) => b.maxMove - a.maxMove);
}

function buildMomentumThesis(market, m1h, m4h, m24h, direction, strength) {
  const parts = [];

  if (m1h && Math.abs(m1h.change) >= 5) {
    parts.push(`${m1h.change > 0 ? '+' : ''}${m1h.change}% in 1h`);
  }
  if (m4h && Math.abs(m4h.change) >= 5) {
    parts.push(`${m4h.change > 0 ? '+' : ''}${m4h.change}% in 4h`);
  }
  if (m24h && Math.abs(m24h.change) >= 5) {
    parts.push(`${m24h.change > 0 ? '+' : ''}${m24h.change}% in 24h`);
  }

  const moveSummary = parts.join(', ');
  const dirWord = direction === 'up' ? 'rising' : 'falling';

  return `${strength.toUpperCase()} momentum ${dirWord}: ${moveSummary}. Market "${(market.question || '').slice(0, 50)}" is moving ${direction} on volume.`;
}

/**
 * Get all current momentum signals for display.
 */
export function getMomentumSignals() {
  return {
    trackedMarkets: priceHistory.size,
    signals: [...priceHistory.entries()]
      .map(([id, history]) => {
        if (history.length < 3) return null;
        const HOUR = 3600000;
        const m1h = getPriceChange(history, 1 * HOUR);
        const m4h = getPriceChange(history, 4 * HOUR);
        const m24h = getPriceChange(history, 24 * HOUR);
        const abs1h = Math.abs(m1h?.change || 0);
        const abs4h = Math.abs(m4h?.change || 0);
        const abs24h = Math.abs(m24h?.change || 0);
        if (abs1h < 3 && abs4h < 5 && abs24h < 8) return null;
        return { id, m1h: m1h?.change || 0, m4h: m4h?.change || 0, m24h: m24h?.change || 0 };
      })
      .filter(Boolean)
      .sort((a, b) => Math.max(Math.abs(b.m1h), Math.abs(b.m4h), Math.abs(b.m24h)) - Math.max(Math.abs(a.m1h), Math.abs(a.m4h), Math.abs(a.m24h)))
      .slice(0, 10),
  };
}
