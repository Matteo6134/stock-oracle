/**
 * FORWARD-LOOKING Prediction Scoring Engine
 *
 * Scores stocks based on UPCOMING events and catalysts so user can
 * position BEFORE the move, not after.
 *
 * Categories:
 * - Catalyst Score (0-30): Upcoming earnings, events, analyst targets
 * - Social Score (0-20): Reddit + StockTwits buzz before the event
 * - News Score (0-25): News coverage and sentiment heading into event
 * - Technical Score (0-25): Momentum, volume buildup, setup quality
 */

function calcCatalystScore(data) {
  let s = 0;
  const catalysts = data.catalysts || [];

  // Earnings TODAY = massive catalyst (+20)
  if (data.hasEarningsToday) s += 20;
  // Earnings TOMORROW = great setup window (+18)
  else if (data.hasEarningsTomorrow) s += 18;
  // Earnings within 7 days
  else {
    const earningsCat = catalysts.find(c => c.type === 'earnings');
    if (earningsCat) {
      if (earningsCat.daysAway <= 2) s += 15;
      else if (earningsCat.daysAway <= 5) s += 10;
      else s += 5;
    }
  }

  // Analyst consensus: strong buy ratings
  const analyst = catalysts.find(c => c.type === 'analyst');
  if (analyst) {
    if (analyst.buyPercentage >= 0.8) s += 8;      // 80%+ buy = strong
    else if (analyst.buyPercentage >= 0.6) s += 5;  // 60%+ buy
    else if (analyst.buyPercentage >= 0.4) s += 2;
  }

  // Target price upside
  const target = catalysts.find(c => c.type === 'target_price');
  if (target) {
    if (target.upside >= 30) s += 5;
    else if (target.upside >= 20) s += 3;
    else if (target.upside >= 10) s += 2;
  }

  // Ex-dividend date (income play)
  const dividend = catalysts.find(c => c.type === 'dividend');
  if (dividend && dividend.daysAway <= 3) s += 3;

  // Positive EPS expectations
  const q = data.quote || {};
  if (q.epsForward > 0) s += 2;
  if (q.epsTrailingTwelveMonths > 0 && q.epsForward > q.epsTrailingTwelveMonths) s += 2; // growing EPS

  return Math.min(30, s);
}

function calcSocialScore(data) {
  let s = 0;
  const r = data.reddit || { mentions: 0, sentiment: 0 };
  const st = data.stocktwits || { total: 0, sentiment: 0 };

  // Reddit: buzz before event = people are watching
  if (r.mentions >= 15) s += 8; else if (r.mentions >= 8) s += 6;
  else if (r.mentions >= 3) s += 4; else if (r.mentions >= 1) s += 2;

  // Reddit sentiment
  if (r.sentiment > 0.4) s += 4; else if (r.sentiment > 0.1) s += 2;
  else if (r.sentiment < -0.3) s -= 2; // negative buzz = bad sign

  // StockTwits volume
  if (st.total >= 20) s += 4; else if (st.total >= 10) s += 3;
  else if (st.total >= 3) s += 2; else if (st.total >= 1) s += 1;

  // StockTwits sentiment
  if (st.sentiment > 0.4) s += 4; else if (st.sentiment > 0.1) s += 2;
  else if (st.sentiment < -0.3) s -= 2;

  return Math.max(0, Math.min(20, s));
}

function calcNewsScore(data) {
  let s = 0;
  const news = data.news || [];

  // Volume of coverage
  if (news.length >= 12) s += 8; else if (news.length >= 8) s += 6;
  else if (news.length >= 4) s += 4; else if (news.length >= 1) s += 2;

  // Sentiment of coverage
  if (news.length > 0) {
    const avg = news.reduce((sum, n) => sum + (n.sentiment || 0), 0) / news.length;
    if (avg > 0.4) s += 17; else if (avg > 0.2) s += 12;
    else if (avg > 0.05) s += 8; else if (avg > -0.05) s += 5;
    else if (avg > -0.2) s += 2; // slightly negative
    // Very negative news = 0 bonus
  }

  return Math.min(25, s);
}

function calcTechnicalScore(data) {
  let s = 0;
  const h = data.history || [];
  const q = data.quote || {};
  if (h.length < 5) return 10;

  // Price vs 20-day SMA (momentum into event)
  const recent = h.slice(-20);
  if (recent.length >= 10) {
    const sma = recent.reduce((sum, d) => sum + (d.close || 0), 0) / recent.length;
    const price = q.regularMarketPrice || h[h.length - 1]?.close || 0;
    if (price > 0 && sma > 0) {
      const ratio = price / sma;
      if (ratio > 1.05) s += 8;      // Strong uptrend
      else if (ratio > 1.02) s += 7;
      else if (ratio > 1.0) s += 6;  // Slightly above = good setup
      else if (ratio > 0.97) s += 4; // Near SMA = potential bounce
      else if (ratio > 0.93) s += 2;
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
      if (vRatio > 2.0) s += 10;      // Major volume spike = big anticipation
      else if (vRatio > 1.5) s += 8;
      else if (vRatio > 1.2) s += 5;
      else if (vRatio > 1.0) s += 3;
      else s += 1;
    }
  }

  // 5-day trend direction
  if (h.length >= 5) {
    const f = h[h.length - 5], l = h[h.length - 1];
    if (f?.close > 0 && l?.close) {
      const ret = (l.close - f.close) / f.close;
      if (ret > 0.05) s += 7;
      else if (ret > 0.02) s += 5;
      else if (ret > 0) s += 3;
      else if (ret > -0.02) s += 2;
    }
  }

  return Math.min(25, s);
}

export function calculateScore(stockData) {
  try {
    const catalyst = calcCatalystScore(stockData);
    const social = calcSocialScore(stockData);
    const news = calcNewsScore(stockData);
    const technical = calcTechnicalScore(stockData);
    const totalScore = catalyst + social + news + technical;

    return {
      totalScore,
      breakdown: { earnings: catalyst, social, news, technical },
      confidence: totalScore >= 70 ? 'HIGH' : totalScore >= 45 ? 'MEDIUM' : 'LOW',
      probability: Math.round(55 + (totalScore / 100) * 40)
    };
  } catch (err) {
    return { totalScore: 0, breakdown: { earnings: 0, social: 0, news: 0, technical: 0 }, confidence: 'LOW', probability: 55 };
  }
}
