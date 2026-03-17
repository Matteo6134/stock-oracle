/**
 * ENHANCED Prediction Scoring Engine v3
 *
 * KEY CHANGES from v2:
 * 1. Earnings catalyst REDUCED — having earnings alone is a coin flip
 * 2. Overextension PENALTY — stocks already pumped get penalized
 * 3. Mean reversion awareness — RSI > 70 = overbought penalty
 * 4. Earnings Quality + Revision remain strong (these actually predict)
 * 5. Liquidity bonus — higher volume = more reliable signal
 * 6. Negative filters — entry signal "too_late"/"risky" = score penalty
 *
 * Categories (rebalanced for real accuracy):
 * - Catalyst Score (0-12): Reduced — earnings alone don't predict direction
 * - Earnings Quality (0-25): INCREASED — strongest predictor of beats
 * - Revision Momentum (0-18): INCREASED — 2nd strongest predictor
 * - Technical Setup (0-25): INCREASED — price action quality matters most short-term
 * - News Score (0-10): Reduced — mostly noise
 * - Social Score (0-5): Minimal — worst predictor
 * - Overextension Penalty (-15 to 0): NEW — punish already-pumped stocks
 * - PEAD Bonus (±5): Post-earnings drift
 *
 * Total: 100 points max
 */

// ── Catalyst Score (0-12, reduced from 20) ──
// Having earnings is a COIN FLIP. Only score high when combined with quality signals.
function calcCatalystScore(data) {
  let s = 0;
  const catalysts = data.catalysts || [];

  // Earnings proximity — REDUCED (was 15, now 8 max alone)
  if (data.hasEarningsToday) s += 8;
  else if (data.hasEarningsTomorrow) s += 6;
  else {
    const earningsCat = catalysts.find(c => c.type === 'earnings');
    if (earningsCat) {
      if (earningsCat.daysAway <= 2) s += 5;
      else if (earningsCat.daysAway <= 5) s += 3;
      else s += 1;
    }
  }

  // Analyst consensus — only strong consensus matters
  const analyst = catalysts.find(c => c.type === 'analyst');
  if (analyst) {
    if (analyst.buyPercentage >= 0.85) s += 3;
    else if (analyst.buyPercentage >= 0.7) s += 2;
    else if (analyst.buyPercentage >= 0.5) s += 1;
  }

  // Positive forward EPS growth
  const q = data.quote || {};
  if (q.epsForward > 0 && q.epsTrailingTwelveMonths > 0 && q.epsForward > q.epsTrailingTwelveMonths) s += 1;

  return Math.min(12, s);
}

// ── Earnings Quality Score (0-25) — STRONGEST PREDICTOR ──
// Historical earnings surprise pattern: beat streak, SUE, avg surprise
function calcEarningsQualityScore(data) {
  let s = 0;
  const eh = data.earningsHistory || {};

  // EPS Beat Streak (0-12)
  // Companies that consistently beat have ~70% chance of beating again
  if (eh.beatStreak >= 4) s += 12;       // 4+ consecutive beats = very reliable
  else if (eh.beatStreak >= 3) s += 10;
  else if (eh.beatStreak >= 2) s += 7;
  else if (eh.beatStreak >= 1) s += 4;

  // SUE — Standardized Unexpected Earnings (0-7)
  if (eh.sue >= 2.0) s += 7;
  else if (eh.sue >= 1.0) s += 5;
  else if (eh.sue >= 0.5) s += 3;
  else if (eh.sue > 0) s += 1;
  else if (eh.sue < -1.0) s -= 4;        // Consistent misser — strong penalty

  // Average Surprise Magnitude (0-6)
  if (eh.avgSurprise >= 15) s += 6;
  else if (eh.avgSurprise >= 8) s += 5;
  else if (eh.avgSurprise >= 3) s += 3;
  else if (eh.avgSurprise > 0) s += 1;
  else if (eh.avgSurprise < -5) s -= 3;

  return Math.max(0, Math.min(25, s));
}

// ── Revision Momentum Score (0-18) — 2nd STRONGEST PREDICTOR ──
function calcRevisionScore(data) {
  let s = 0;
  const eh = data.earningsHistory || {};
  const momentum = eh.revisionMomentum || 0;

  // Revision direction (0-12)
  if (momentum >= 0.5) s += 12;
  else if (momentum >= 0.2) s += 10;
  else if (momentum >= 0.05) s += 6;
  else if (momentum >= -0.05) s += 3;
  else if (momentum >= -0.2) s += 1;
  // Strong downward = 0

  // Convergence bonus: upward revisions + beat streak
  if (momentum > 0.1 && (eh.beatStreak || 0) >= 2) s += 6;

  return Math.min(18, s);
}

// ── Technical Setup Score (0-25, INCREASED) ──
// Short-term price action is what actually predicts next-day moves
function calcTechnicalScore(data) {
  let s = 0;
  const h = data.history || [];
  const q = data.quote || {};
  if (h.length < 10) return 8; // neutral default for insufficient data

  const currentPrice = q.regularMarketPrice || h[h.length - 1]?.close || 0;

  // ── RSI (14-period) — identify overbought/oversold ──
  let rsi = 50; // default neutral
  if (h.length >= 15) {
    let gains = 0, losses = 0;
    for (let i = h.length - 14; i < h.length; i++) {
      const change = (h[i].close || 0) - (h[i-1]?.close || 0);
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss > 0) {
      const rs = avgGain / avgLoss;
      rsi = 100 - (100 / (1 + rs));
    } else {
      rsi = 100;
    }
  }

  // RSI scoring — sweet spot is 40-60 (not overbought, not oversold)
  if (rsi >= 30 && rsi <= 45) s += 6;        // Oversold bounce potential
  else if (rsi > 45 && rsi <= 55) s += 5;    // Neutral — good entry
  else if (rsi > 55 && rsi <= 65) s += 4;    // Mild momentum — acceptable
  else if (rsi > 65 && rsi <= 70) s += 2;    // Getting overbought
  else if (rsi > 70) s += 0;                  // Overbought — no bonus
  else if (rsi < 30) s += 3;                  // Deeply oversold — risky but potential

  // ── Price vs 20-day SMA (trend health) ──
  const recent20 = h.slice(-20);
  if (recent20.length >= 10) {
    const sma = recent20.reduce((sum, d) => sum + (d.close || 0), 0) / recent20.length;
    if (currentPrice > 0 && sma > 0) {
      const ratio = currentPrice / sma;
      if (ratio > 0.97 && ratio <= 1.03) s += 5;    // Near SMA — healthy
      else if (ratio > 1.03 && ratio <= 1.06) s += 4; // Slightly above — momentum
      else if (ratio > 1.06 && ratio <= 1.10) s += 2; // Extended — risky
      else if (ratio > 1.10) s += 0;                   // Overextended — don't chase
      else if (ratio > 0.93 && ratio <= 0.97) s += 3;  // Slight pullback — potential
      else s += 1;                                       // Deep below SMA — weak
    }
  }

  // ── Volume buildup (anticipation signal) ──
  if (h.length >= 10) {
    const rv = h.slice(-5).map(d => d.volume || 0);
    const ov = h.slice(-10, -5).map(d => d.volume || 0);
    const avgRecent = rv.reduce((a, b) => a + b, 0) / rv.length;
    const avgOlder = ov.reduce((a, b) => a + b, 0) / ov.length;
    if (avgOlder > 0) {
      const vRatio = avgRecent / avgOlder;
      if (vRatio > 1.5 && vRatio <= 2.5) s += 6;  // Healthy volume increase
      else if (vRatio > 1.2 && vRatio <= 1.5) s += 4;
      else if (vRatio > 1.0 && vRatio <= 1.2) s += 3;
      else if (vRatio > 2.5) s += 2;                // Spike — could be exhaustion
      else s += 1;                                    // Declining volume
    }
  }

  // ── 5-day trend + pullback pattern ──
  if (h.length >= 5) {
    const f = h[h.length - 5], l = h[h.length - 1];
    if (f?.close > 0 && l?.close) {
      const ret = (l.close - f.close) / f.close;
      // Moderate uptrend is ideal (not too fast, not down)
      if (ret > 0.01 && ret <= 0.04) s += 5;     // Steady uptrend — best
      else if (ret > 0.04 && ret <= 0.08) s += 3; // Fast uptrend — riskier
      else if (ret >= -0.01 && ret <= 0.01) s += 4; // Consolidation — could break out
      else if (ret >= -0.04 && ret < -0.01) s += 2; // Mild pullback
      else if (ret > 0.08) s += 1;                   // Rocket — likely to pull back
      else s += 0;                                     // Strong downtrend — avoid
    }
  }

  // ── Volatility contraction (Bollinger squeeze = breakout coming) ──
  if (h.length >= 20) {
    const closes = h.slice(-20).map(d => d.close || 0);
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / closes.length;
    const stdDev = Math.sqrt(variance);
    const bbWidth = mean > 0 ? (stdDev * 2) / mean * 100 : 0; // as percentage

    if (bbWidth < 3) s += 3;        // Very tight — breakout imminent
    else if (bbWidth < 5) s += 2;   // Moderate squeeze
    else if (bbWidth < 8) s += 1;   // Normal
    // Wide bands = no bonus
  }

  return Math.min(25, s);
}

// ── News Score (0-10, reduced from 15) ──
function calcNewsScore(data) {
  let s = 0;
  const news = data.news || [];

  if (news.length >= 8) s += 3;
  else if (news.length >= 4) s += 2;
  else if (news.length >= 1) s += 1;

  if (news.length > 0) {
    const avg = news.reduce((sum, n) => sum + (n.sentiment || 0), 0) / news.length;
    if (avg > 0.4) s += 7;
    else if (avg > 0.2) s += 5;
    else if (avg > 0.05) s += 3;
    else if (avg > -0.05) s += 2;
    else if (avg > -0.2) s += 1;
    else s -= 1; // Negative news = penalty
  }

  return Math.max(0, Math.min(10, s));
}

// ── Social Score (0-5, minimal — worst predictor) ──
function calcSocialScore(data) {
  let s = 0;
  const r = data.reddit || { mentions: 0, sentiment: 0 };
  const st = data.stocktwits || { total: 0, sentiment: 0 };

  // Only reward STRONG social signals, not noise
  if (r.mentions >= 15 && r.sentiment > 0.3) s += 2;
  else if (r.mentions >= 8 && r.sentiment > 0.2) s += 1;

  if (st.total >= 20 && st.sentiment > 0.3) s += 2;
  else if (st.total >= 10 && st.sentiment > 0.2) s += 1;

  // PENALTY for hype without substance (high mentions, low sentiment)
  if (r.mentions >= 15 && r.sentiment < 0) s -= 1;

  return Math.max(0, Math.min(5, s));
}

// ── Overextension Penalty (-15 to 0) — NEW ──
// Stocks that already pumped today should NOT be recommended
function calcOverextensionPenalty(data) {
  let penalty = 0;
  const q = data.quote || {};
  const change = q.regularMarketChangePercent || 0;
  const h = data.history || [];

  // Today's move penalty
  if (change > 10) penalty -= 10;        // Already up 10%+ — way too late
  else if (change > 6) penalty -= 6;     // Already up 6%+ — too late
  else if (change > 4) penalty -= 3;     // Already up 4%+ — risky entry
  else if (change < -8) penalty -= 5;    // Crashed — don't catch falling knife
  else if (change < -5) penalty -= 2;    // Significant drop — caution

  // Multi-day overextension: if up >15% in 5 days, mean reversion is likely
  if (h.length >= 5) {
    const fiveAgo = h[h.length - 5]?.close || 0;
    const latest = h[h.length - 1]?.close || 0;
    if (fiveAgo > 0) {
      const fiveDayReturn = ((latest - fiveAgo) / fiveAgo) * 100;
      if (fiveDayReturn > 20) penalty -= 5;
      else if (fiveDayReturn > 15) penalty -= 3;
      else if (fiveDayReturn > 10) penalty -= 1;
    }
  }

  return Math.max(-15, penalty);
}

// ── Post-Earnings Drift (PEAD) Bonus ──
function calcPEADBonus(data) {
  const eh = data.earningsHistory || {};
  if (!data.hasEarningsToday && !data.hasEarningsTomorrow) {
    const catalysts = data.catalysts || [];
    const earningsCat = catalysts.find(c => c.type === 'earnings');
    if (earningsCat && earningsCat.daysAway >= 0) return 0;
  }

  if (eh.recentSurprises && eh.recentSurprises.length > 0) {
    const latest = eh.recentSurprises[0];
    if (latest.surprisePct > 10) return 5;
    if (latest.surprisePct > 5) return 3;
    if (latest.surprisePct > 0) return 1;
    if (latest.surprisePct < -10) return -3;
    if (latest.surprisePct < -5) return -2;
  }

  return 0;
}

// ── Liquidity Quality Bonus (0-5) — NEW ──
// Higher liquidity = more reliable signals, less manipulation
function calcLiquidityBonus(data) {
  const q = data.quote || {};
  const volume = q.regularMarketVolume || 0;
  const marketCap = q.marketCap || 0;

  let bonus = 0;

  // Volume-based
  if (volume >= 5000000) bonus += 2;       // Very liquid
  else if (volume >= 1000000) bonus += 1;  // Adequate

  // Market cap-based (larger = more predictable)
  if (marketCap >= 10e9) bonus += 3;        // Large cap — most predictable
  else if (marketCap >= 2e9) bonus += 2;    // Mid cap
  else if (marketCap >= 500e6) bonus += 1;  // Small cap
  // Micro/nano cap = no bonus (unreliable)

  return Math.min(5, bonus);
}

export function calculateScore(stockData) {
  try {
    const catalyst = calcCatalystScore(stockData);
    const earningsQuality = calcEarningsQualityScore(stockData);
    const revision = calcRevisionScore(stockData);
    const social = calcSocialScore(stockData);
    const news = calcNewsScore(stockData);
    const technical = calcTechnicalScore(stockData);
    const pead = calcPEADBonus(stockData);
    const overextension = calcOverextensionPenalty(stockData);
    const liquidity = calcLiquidityBonus(stockData);

    const baseScore = catalyst + earningsQuality + revision + social + news + technical + liquidity;
    const totalScore = Math.max(0, Math.min(100, baseScore + pead + overextension));

    return {
      totalScore,
      breakdown: {
        catalyst,
        earningsQuality,
        revision,
        social,
        news,
        technical,
        pead,
        overextension,
        liquidity
      },
      confidence: totalScore >= 70 ? 'HIGH' : totalScore >= 50 ? 'MEDIUM' : 'LOW',
      probability: Math.round(50 + (totalScore / 100) * 45)
    };
  } catch (err) {
    return {
      totalScore: 0,
      breakdown: { catalyst: 0, earningsQuality: 0, revision: 0, social: 0, news: 0, technical: 0, pead: 0, overextension: 0, liquidity: 0 },
      confidence: 'LOW',
      probability: 50
    };
  }
}
