/**
 * ENHANCED Prediction Scoring Engine v2
 *
 * Scores stocks based on UPCOMING events, historical earnings quality,
 * analyst revision momentum, and technical setup.
 *
 * Categories (rebalanced for accuracy):
 * - Catalyst Score (0-20): Upcoming earnings, events, analyst targets
 * - Earnings Quality (0-20): Beat streak, SUE, avg surprise — strongest predictor
 * - Revision Momentum (0-15): Analyst estimate revisions (direction + velocity)
 * - Social Score (0-10): Reddit + StockTwits buzz before the event
 * - News Score (0-15): News coverage and sentiment heading into event
 * - Technical Score (0-20): Momentum, volume buildup, setup quality
 *
 * Total: 100 points
 */

// ── Catalyst Score (0-20) ──
// Upcoming events that drive price moves
function calcCatalystScore(data) {
  let s = 0;
  const catalysts = data.catalysts || [];

  // Earnings proximity
  if (data.hasEarningsToday) s += 15;
  else if (data.hasEarningsTomorrow) s += 13;
  else {
    const earningsCat = catalysts.find(c => c.type === 'earnings');
    if (earningsCat) {
      if (earningsCat.daysAway <= 2) s += 10;
      else if (earningsCat.daysAway <= 5) s += 6;
      else s += 3;
    }
  }

  // Analyst consensus: strong buy ratings
  const analyst = catalysts.find(c => c.type === 'analyst');
  if (analyst) {
    if (analyst.buyPercentage >= 0.8) s += 5;
    else if (analyst.buyPercentage >= 0.6) s += 3;
    else if (analyst.buyPercentage >= 0.4) s += 1;
  }

  // Target price upside
  const target = catalysts.find(c => c.type === 'target_price');
  if (target) {
    if (target.upside >= 30) s += 3;
    else if (target.upside >= 20) s += 2;
    else if (target.upside >= 10) s += 1;
  }

  // Ex-dividend date
  const dividend = catalysts.find(c => c.type === 'dividend');
  if (dividend && dividend.daysAway <= 3) s += 2;

  // Positive EPS expectations
  const q = data.quote || {};
  if (q.epsForward > 0 && q.epsTrailingTwelveMonths > 0 && q.epsForward > q.epsTrailingTwelveMonths) s += 2;

  return Math.min(20, s);
}

// ── Earnings Quality Score (0-20) — NEW, STRONGEST PREDICTOR ──
// Historical earnings surprise pattern: beat streak, SUE, avg surprise
function calcEarningsQualityScore(data) {
  let s = 0;
  const eh = data.earningsHistory || {};

  // EPS Beat Streak (0-10)
  // Companies that consistently beat have ~70% chance of beating again
  if (eh.beatStreak >= 4) s += 10;       // 4+ consecutive beats = very reliable
  else if (eh.beatStreak >= 3) s += 8;   // 3 beats
  else if (eh.beatStreak >= 2) s += 6;   // 2 beats
  else if (eh.beatStreak >= 1) s += 3;   // 1 recent beat
  // 0 beats = no bonus

  // SUE — Standardized Unexpected Earnings (0-5)
  // Higher SUE = stronger post-earnings drift
  if (eh.sue >= 2.0) s += 5;             // Very strong surprise pattern
  else if (eh.sue >= 1.0) s += 4;        // Strong
  else if (eh.sue >= 0.5) s += 3;        // Moderate
  else if (eh.sue > 0) s += 1;           // Slightly positive
  else if (eh.sue < -1.0) s -= 3;        // Consistent misser — penalty

  // Average Surprise Magnitude (0-5)
  // Large average surprise = market consistently underestimates
  if (eh.avgSurprise >= 15) s += 5;      // Massive avg surprise
  else if (eh.avgSurprise >= 8) s += 4;
  else if (eh.avgSurprise >= 3) s += 3;
  else if (eh.avgSurprise > 0) s += 1;
  else if (eh.avgSurprise < -5) s -= 2;  // Consistent misses

  return Math.max(0, Math.min(20, s));
}

// ── Revision Momentum Score (0-15) — NEW, 2nd STRONGEST PREDICTOR ──
// Direction and velocity of analyst estimate revisions in last 30 days
function calcRevisionScore(data) {
  let s = 0;
  const eh = data.earningsHistory || {};
  const momentum = eh.revisionMomentum || 0;

  // Revision direction (0-10)
  // Upward revisions in last 30 days are the single best predictor of earnings beats
  if (momentum >= 0.5) s += 10;          // Strong upward revisions
  else if (momentum >= 0.2) s += 8;      // Moderate upward
  else if (momentum >= 0.05) s += 5;     // Slight upward
  else if (momentum >= -0.05) s += 3;    // Flat (neutral)
  else if (momentum >= -0.2) s += 1;     // Slight downward
  // Strong downward = 0

  // Bonus: Upward revisions + beat streak = convergence signal
  if (momentum > 0.1 && (eh.beatStreak || 0) >= 2) s += 5;

  return Math.min(15, s);
}

// ── Social Score (0-10, reduced from 20) ──
// Social buzz is noisy — reduced weight
function calcSocialScore(data) {
  let s = 0;
  const r = data.reddit || { mentions: 0, sentiment: 0 };
  const st = data.stocktwits || { total: 0, sentiment: 0 };

  // Reddit mentions
  if (r.mentions >= 15) s += 4; else if (r.mentions >= 8) s += 3;
  else if (r.mentions >= 3) s += 2; else if (r.mentions >= 1) s += 1;

  // Reddit sentiment
  if (r.sentiment > 0.4) s += 2; else if (r.sentiment > 0.1) s += 1;
  else if (r.sentiment < -0.3) s -= 1;

  // StockTwits volume
  if (st.total >= 20) s += 2; else if (st.total >= 10) s += 1;

  // StockTwits sentiment
  if (st.sentiment > 0.4) s += 2; else if (st.sentiment > 0.1) s += 1;
  else if (st.sentiment < -0.3) s -= 1;

  return Math.max(0, Math.min(10, s));
}

// ── News Score (0-15, reduced from 25) ──
function calcNewsScore(data) {
  let s = 0;
  const news = data.news || [];

  // Volume of coverage
  if (news.length >= 12) s += 5; else if (news.length >= 8) s += 4;
  else if (news.length >= 4) s += 3; else if (news.length >= 1) s += 1;

  // Sentiment of coverage
  if (news.length > 0) {
    const avg = news.reduce((sum, n) => sum + (n.sentiment || 0), 0) / news.length;
    if (avg > 0.4) s += 10;
    else if (avg > 0.2) s += 7;
    else if (avg > 0.05) s += 5;
    else if (avg > -0.05) s += 3;
    else if (avg > -0.2) s += 1;
  }

  return Math.min(15, s);
}

// ── Technical Score (0-20, reduced from 25) ──
function calcTechnicalScore(data) {
  let s = 0;
  const h = data.history || [];
  const q = data.quote || {};
  if (h.length < 5) return 8; // neutral default

  // Price vs 20-day SMA (momentum into event)
  const recent = h.slice(-20);
  if (recent.length >= 10) {
    const sma = recent.reduce((sum, d) => sum + (d.close || 0), 0) / recent.length;
    const price = q.regularMarketPrice || h[h.length - 1]?.close || 0;
    if (price > 0 && sma > 0) {
      const ratio = price / sma;
      if (ratio > 1.05) s += 6;
      else if (ratio > 1.02) s += 5;
      else if (ratio > 1.0) s += 4;
      else if (ratio > 0.97) s += 3;
      else if (ratio > 0.93) s += 1;
    }
  }

  // Volume buildup (increasing volume = anticipation)
  if (h.length >= 10) {
    const rv = h.slice(-5).map(d => d.volume || 0);
    const ov = h.slice(-10, -5).map(d => d.volume || 0);
    const avgRecent = rv.reduce((a, b) => a + b, 0) / rv.length;
    const avgOlder = ov.reduce((a, b) => a + b, 0) / ov.length;
    if (avgOlder > 0) {
      const vRatio = avgRecent / avgOlder;
      if (vRatio > 2.0) s += 8;
      else if (vRatio > 1.5) s += 6;
      else if (vRatio > 1.2) s += 4;
      else if (vRatio > 1.0) s += 2;
      else s += 1;
    }
  }

  // 5-day trend direction
  if (h.length >= 5) {
    const f = h[h.length - 5], l = h[h.length - 1];
    if (f?.close > 0 && l?.close) {
      const ret = (l.close - f.close) / f.close;
      if (ret > 0.05) s += 6;
      else if (ret > 0.02) s += 4;
      else if (ret > 0) s += 2;
      else if (ret > -0.02) s += 1;
    }
  }

  return Math.min(20, s);
}

// ── Post-Earnings Drift (PEAD) Bonus ──
// Stocks that recently reported positive surprise drift up for 1-3 weeks
function calcPEADBonus(data) {
  const eh = data.earningsHistory || {};
  // Only apply if stock reported recently (not upcoming)
  // and has a strong recent surprise
  if (!data.hasEarningsToday && !data.hasEarningsTomorrow) {
    const catalysts = data.catalysts || [];
    const earningsCat = catalysts.find(c => c.type === 'earnings');

    // If earnings are upcoming (not past), no PEAD
    if (earningsCat && earningsCat.daysAway >= 0) return 0;
  }

  // Check most recent surprise from history
  if (eh.recentSurprises && eh.recentSurprises.length > 0) {
    const latest = eh.recentSurprises[0]; // most recent quarter
    if (latest.surprisePct > 10) return 5;    // Big beat — strong drift expected
    if (latest.surprisePct > 5) return 3;     // Moderate beat
    if (latest.surprisePct > 0) return 1;     // Small beat
    if (latest.surprisePct < -10) return -3;  // Big miss — negative drift
    if (latest.surprisePct < -5) return -2;   // Moderate miss
  }

  return 0;
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

    const baseScore = catalyst + earningsQuality + revision + social + news + technical;
    const totalScore = Math.max(0, Math.min(100, baseScore + pead));

    return {
      totalScore,
      breakdown: {
        catalyst,
        earningsQuality,
        revision,
        social,
        news,
        technical,
        pead
      },
      confidence: totalScore >= 70 ? 'HIGH' : totalScore >= 45 ? 'MEDIUM' : 'LOW',
      probability: Math.round(55 + (totalScore / 100) * 40)
    };
  } catch (err) {
    return {
      totalScore: 0,
      breakdown: { catalyst: 0, earningsQuality: 0, revision: 0, social: 0, news: 0, technical: 0, pead: 0 },
      confidence: 'LOW',
      probability: 55
    };
  }
}
