/**
 * ENHANCED Prediction Scoring Engine v4.0
 *
 * KEY CHANGES from v3.1:
 * 1. Volume/Price Divergence Detection — bearish divergence = avoid, bullish divergence = opportunity
 * 2. Mean Reversion Bonus — quality stocks that crash on market panic get bonus points
 * 3. VIX Regime Adjustment — scores adjusted based on market fear level
 * 4. Extended PEAD — stocks that beat earnings keep drifting for 5+ days
 * 5. Gap Fade Intelligence — large gaps get tighter targets
 *
 * Categories (rebalanced):
 * - Catalyst Score (0-12): Reduced — earnings alone don't predict direction
 * - Earnings Quality (0-25): INCREASED — strongest predictor of beats
 * - Revision Momentum (0-18): INCREASED — 2nd strongest predictor
 * - Technical Setup (0-28): INCREASED — now includes divergence detection (+3)
 * - News Score (0-10): Reduced — mostly noise
 * - Social Score (0-5): Minimal — worst predictor
 * - Pre/Post Market Score (-8 to +8): Overnight/pre-market intelligence
 * - Mean Reversion Bonus (0-8): NEW — quality crash-buy opportunities
 * - Overextension Penalty (-15 to 0): punish already-pumped stocks
 * - PEAD Bonus (±7): Extended post-earnings drift (was ±5)
 * - VIX Adjustment (-10 to 0): Dampens scores in high-fear environments
 *
 * Total: ~100 points max (soft cap via clamp)
 */

// ── Catalyst Score (0-12, reduced from 20) ──
function calcCatalystScore(data) {
  let s = 0;
  const catalysts = data.catalysts || [];

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

  const analyst = catalysts.find(c => c.type === 'analyst');
  if (analyst) {
    if (analyst.buyPercentage >= 0.85) s += 3;
    else if (analyst.buyPercentage >= 0.7) s += 2;
    else if (analyst.buyPercentage >= 0.5) s += 1;
  }

  const q = data.quote || {};
  if (q.epsForward > 0 && q.epsTrailingTwelveMonths > 0 && q.epsForward > q.epsTrailingTwelveMonths) s += 1;

  return Math.min(12, s);
}

// ── Earnings Quality Score (0-25) — STRONGEST PREDICTOR ──
function calcEarningsQualityScore(data) {
  let s = 0;
  const eh = data.earningsHistory || {};

  if (eh.beatStreak >= 4) s += 12;
  else if (eh.beatStreak >= 3) s += 10;
  else if (eh.beatStreak >= 2) s += 7;
  else if (eh.beatStreak >= 1) s += 4;

  if (eh.sue >= 2.0) s += 7;
  else if (eh.sue >= 1.0) s += 5;
  else if (eh.sue >= 0.5) s += 3;
  else if (eh.sue > 0) s += 1;
  else if (eh.sue < -1.0) s -= 4;

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

  if (momentum >= 0.5) s += 12;
  else if (momentum >= 0.2) s += 10;
  else if (momentum >= 0.05) s += 6;
  else if (momentum >= -0.05) s += 3;
  else if (momentum >= -0.2) s += 1;

  if (momentum > 0.1 && (eh.beatStreak || 0) >= 2) s += 6;

  return Math.min(18, s);
}

// ── Technical Setup Score (0-28, INCREASED — now includes divergence) ──
function calcTechnicalScore(data) {
  let s = 0;
  const h = data.history || [];
  const q = data.quote || {};
  if (h.length < 10) return 8;

  const currentPrice = q.regularMarketPrice || h[h.length - 1]?.close || 0;

  // ── RSI (14-period) ──
  let rsi = 50;
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

  if (rsi >= 30 && rsi <= 45) s += 6;
  else if (rsi > 45 && rsi <= 55) s += 5;
  else if (rsi > 55 && rsi <= 65) s += 4;
  else if (rsi > 65 && rsi <= 70) s += 2;
  else if (rsi > 70) s += 0;
  else if (rsi < 30) s += 3;

  // ── Price vs 20-day SMA ──
  const recent20 = h.slice(-20);
  if (recent20.length >= 10) {
    const sma = recent20.reduce((sum, d) => sum + (d.close || 0), 0) / recent20.length;
    if (currentPrice > 0 && sma > 0) {
      const ratio = currentPrice / sma;
      if (ratio > 0.97 && ratio <= 1.03) s += 5;
      else if (ratio > 1.03 && ratio <= 1.06) s += 4;
      else if (ratio > 1.06 && ratio <= 1.10) s += 2;
      else if (ratio > 1.10) s += 0;
      else if (ratio > 0.93 && ratio <= 0.97) s += 3;
      else s += 1;
    }
  }

  // ── Volume buildup ──
  if (h.length >= 10) {
    const rv = h.slice(-5).map(d => d.volume || 0);
    const ov = h.slice(-10, -5).map(d => d.volume || 0);
    const avgRecent = rv.reduce((a, b) => a + b, 0) / rv.length;
    const avgOlder = ov.reduce((a, b) => a + b, 0) / ov.length;
    if (avgOlder > 0) {
      const vRatio = avgRecent / avgOlder;
      if (vRatio > 1.5 && vRatio <= 2.5) s += 6;
      else if (vRatio > 1.2 && vRatio <= 1.5) s += 4;
      else if (vRatio > 1.0 && vRatio <= 1.2) s += 3;
      else if (vRatio > 2.5) s += 2;
      else s += 1;
    }
  }

  // ── 5-day trend ──
  if (h.length >= 5) {
    const f = h[h.length - 5], l = h[h.length - 1];
    if (f?.close > 0 && l?.close) {
      const ret = (l.close - f.close) / f.close;
      if (ret > 0.01 && ret <= 0.04) s += 5;
      else if (ret > 0.04 && ret <= 0.08) s += 3;
      else if (ret >= -0.01 && ret <= 0.01) s += 4;
      else if (ret >= -0.04 && ret < -0.01) s += 2;
      else if (ret > 0.08) s += 1;
      else s += 0;
    }
  }

  // ── Bollinger squeeze ──
  if (h.length >= 20) {
    const closes = h.slice(-20).map(d => d.close || 0);
    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / closes.length;
    const stdDev = Math.sqrt(variance);
    const bbWidth = mean > 0 ? (stdDev * 2) / mean * 100 : 0;

    if (bbWidth < 3) s += 3;
    else if (bbWidth < 5) s += 2;
    else if (bbWidth < 8) s += 1;
  }

  // ── NEW: Volume/Price Divergence Detection (-2 to +3) ──
  // Bearish divergence: price making new highs but volume declining = weak rally
  // Bullish divergence: price making new lows but volume declining = selling exhaustion
  if (h.length >= 10) {
    const recent5 = h.slice(-5);
    const prev5 = h.slice(-10, -5);

    const recentHighs = recent5.map(d => d.high || 0);
    const prevHighs = prev5.map(d => d.high || 0);
    const recentAvgVol = recent5.reduce((sum, d) => sum + (d.volume || 0), 0) / recent5.length;
    const prevAvgVol = prev5.reduce((sum, d) => sum + (d.volume || 0), 0) / prev5.length;

    const recentMaxHigh = Math.max(...recentHighs);
    const prevMaxHigh = Math.max(...prevHighs);
    const recentMinLow = Math.min(...recent5.map(d => d.low || Infinity).filter(v => v > 0 && v < Infinity));
    const prevMinLow = Math.min(...prev5.map(d => d.low || Infinity).filter(v => v > 0 && v < Infinity));

    if (prevAvgVol > 0) {
      const volChange = recentAvgVol / prevAvgVol;

      // Bearish divergence: higher highs + lower volume = weak, likely to reverse
      if (recentMaxHigh > prevMaxHigh * 1.01 && volChange < 0.75) {
        s -= 2; // Price up but volume dying — bearish divergence
      }
      // Bullish divergence: lower lows + lower volume = selling exhaustion, bounce likely
      else if (recentMinLow < prevMinLow * 0.99 && volChange < 0.7) {
        s += 3; // Price down but selling pressure fading — bullish divergence
      }
      // Volume confirmation: price up + volume up = strong
      else if (recentMaxHigh > prevMaxHigh && volChange > 1.3) {
        s += 2; // Confirmed breakout with volume
      }
    }
  }

  return Math.min(28, s);
}

// ── News Score (0-10) ──
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
    else s -= 1;
  }

  return Math.max(0, Math.min(10, s));
}

// ── Social Score (0-5) ──
function calcSocialScore(data) {
  let s = 0;
  const r = data.reddit || { mentions: 0, sentiment: 0 };
  const st = data.stocktwits || { total: 0, sentiment: 0 };

  if (r.mentions >= 15 && r.sentiment > 0.3) s += 2;
  else if (r.mentions >= 8 && r.sentiment > 0.2) s += 1;

  if (st.total >= 20 && st.sentiment > 0.3) s += 2;
  else if (st.total >= 10 && st.sentiment > 0.2) s += 1;

  if (r.mentions >= 15 && r.sentiment < 0) s -= 1;

  return Math.max(0, Math.min(5, s));
}

// ── Pre/Post Market Intelligence Score (-8 to +8) ──
function calcPrePostMarketScore(data) {
  let s = 0;
  const q = data.quote || {};
  const h = data.history || [];

  const prePrice = q.preMarketPrice;
  const postPrice = q.postMarketPrice;
  const regPrice = q.regularMarketPrice;
  const prevClose = h.length > 0 ? h[h.length - 1]?.close : null;

  if (prePrice && prevClose && prevClose > 0) {
    const preGapPct = ((prePrice - prevClose) / prevClose) * 100;
    if (preGapPct >= 0.5 && preGapPct <= 2) s += 4;
    else if (preGapPct > 2 && preGapPct <= 4) s += 2;
    else if (preGapPct > 4 && preGapPct <= 8) s -= 2;
    else if (preGapPct > 8) s -= 6;
    else if (preGapPct <= -0.5 && preGapPct >= -2) s += 1;
    else if (preGapPct < -2 && preGapPct >= -5) s -= 2;
    else if (preGapPct < -5) s -= 5;
  }

  if (postPrice && regPrice && regPrice > 0) {
    const ahChangePct = ((postPrice - regPrice) / regPrice) * 100;
    if (ahChangePct > 3 && (data.hasEarningsToday || data.hasEarningsTomorrow)) {
      s += 3;
    } else if (ahChangePct < -3 && (data.hasEarningsToday || data.hasEarningsTomorrow)) {
      s -= 4;
    } else if (ahChangePct > 2) {
      s += 1;
    } else if (ahChangePct < -2) {
      s -= 1;
    }
  }

  if (prePrice && postPrice && regPrice && regPrice > 0 && prevClose && prevClose > 0) {
    const preDirection = prePrice > prevClose ? 1 : -1;
    const ahDirection = postPrice > regPrice ? 1 : -1;
    if (preDirection === 1 && ahDirection === 1) s += 1;
    else if (preDirection === -1 && ahDirection === -1) s -= 1;
  }

  return Math.max(-8, Math.min(8, s));
}

// ── Overextension Penalty (-15 to 0) ──
function calcOverextensionPenalty(data) {
  let penalty = 0;
  const q = data.quote || {};
  const change = q.regularMarketChangePercent || 0;
  const h = data.history || [];

  if (change > 10) penalty -= 10;
  else if (change > 6) penalty -= 6;
  else if (change > 4) penalty -= 3;
  else if (change < -8) penalty -= 5;
  else if (change < -5) penalty -= 2;

  const prePrice = q.preMarketPrice;
  const prevClose = h.length > 0 ? h[h.length - 1]?.close : null;
  if (prePrice && prevClose && prevClose > 0) {
    const preGapPct = ((prePrice - prevClose) / prevClose) * 100;
    if (preGapPct > 8) penalty -= 4;
    else if (preGapPct > 5) penalty -= 2;
    else if (preGapPct > 3) penalty -= 1;
  }

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

// ── Post-Earnings Drift (PEAD) Bonus — EXTENDED (±7, was ±5) ──
// v4: Also awards drift bonus for stocks that beat earnings 1-5 days ago
function calcPEADBonus(data) {
  const eh = data.earningsHistory || {};

  // For stocks with earnings today/tomorrow: standard PEAD
  if (data.hasEarningsToday || data.hasEarningsTomorrow) {
    if (eh.recentSurprises && eh.recentSurprises.length > 0) {
      const latest = eh.recentSurprises[0];
      if (latest.surprisePct > 10) return 7;   // Big beat = strong drift (was 5)
      if (latest.surprisePct > 5) return 4;    // Solid beat (was 3)
      if (latest.surprisePct > 0) return 2;    // Small beat (was 1)
      if (latest.surprisePct < -10) return -4;
      if (latest.surprisePct < -5) return -2;
    }
    return 0;
  }

  // NEW: Extended PEAD for stocks that beat earnings recently (1-5 days ago)
  // Stocks continue to drift in the direction of the surprise for multiple days
  if (eh.recentSurprises && eh.recentSurprises.length > 0) {
    const latest = eh.recentSurprises[0];
    const reportDate = latest.reportDate ? new Date(latest.reportDate) : null;

    if (reportDate) {
      const daysSinceReport = Math.floor((Date.now() - reportDate.getTime()) / (1000 * 60 * 60 * 24));

      // Only apply for recent reports (within 5 trading days)
      if (daysSinceReport >= 1 && daysSinceReport <= 5) {
        const revisionMomentum = eh.revisionMomentum || 0;

        // Beat + analysts raising estimates = continued drift
        if (latest.surprisePct > 5 && revisionMomentum > 0) {
          const driftBonus = Math.max(1, 5 - daysSinceReport); // Decays over days: 4, 3, 2, 1, 1
          return driftBonus;
        }
        // Miss + analysts cutting = continued downward drift (penalty)
        if (latest.surprisePct < -5 && revisionMomentum < 0) {
          return -Math.max(1, 3 - daysSinceReport);
        }
      }
    }
  }

  return 0;
}

// ── Liquidity Quality Bonus (0-5) ──
function calcLiquidityBonus(data) {
  const q = data.quote || {};
  const volume = q.regularMarketVolume || 0;
  const marketCap = q.marketCap || 0;

  let bonus = 0;

  if (volume >= 5000000) bonus += 2;
  else if (volume >= 1000000) bonus += 1;

  if (marketCap >= 10e9) bonus += 3;
  else if (marketCap >= 2e9) bonus += 2;
  else if (marketCap >= 500e6) bonus += 1;

  return Math.min(5, bonus);
}

// ── NEW: Mean Reversion Bonus (0-8) ──
// Quality stocks that crash on broad market weakness = buy opportunity
// Only triggers if the stock has strong fundamentals (beat streak, good revisions)
function calcMeanReversionBonus(data) {
  const q = data.quote || {};
  const eh = data.earningsHistory || {};
  const change = q.regularMarketChangePercent || 0;
  const h = data.history || [];

  // Only applies to stocks that are DOWN significantly today
  if (change > -3) return 0;

  // Must have strong earnings fundamentals (not crashing for good reason)
  const beatStreak = eh.beatStreak || 0;
  const revisionMomentum = eh.revisionMomentum || 0;
  if (beatStreak < 2) return 0; // Needs at least 2-quarter beat streak

  // Check: is this a broad market sell-off or company-specific?
  // Use news sentiment — if news is specifically negative about THIS company, skip
  const news = data.news || [];
  if (news.length > 0) {
    const avgSentiment = news.reduce((sum, n) => sum + (n.sentiment || 0), 0) / news.length;
    // If news is strongly negative about this stock, it's company-specific — no mean reversion
    if (avgSentiment < -0.3) return 0;
  }

  let bonus = 0;

  // Down 5-8%: moderate mean reversion opportunity
  if (change <= -5 && change > -8) {
    bonus = 4;
  }
  // Down 3-5%: slight opportunity
  else if (change <= -3 && change > -5) {
    bonus = 2;
  }
  // Down >8%: strong opportunity but also risky
  else if (change <= -8) {
    bonus = 5;
  }

  // Bonus multiplier for very strong fundamentals
  if (beatStreak >= 4 && revisionMomentum > 0.1) bonus += 2;
  else if (beatStreak >= 3) bonus += 1;

  return Math.min(8, bonus);
}

// ── NEW: VIX Regime Adjustment (-10 to 0) ──
// In high-fear environments, even good setups underperform
// This dampens all scores proportionally to VIX level
function calcVIXAdjustment(data) {
  const vix = data.vix || 0;
  if (vix <= 0) return 0; // No VIX data available

  // VIX < 15: calm market, no adjustment
  if (vix < 15) return 0;

  // VIX 15-20: slightly elevated, minor penalty
  if (vix < 20) return -1;

  // VIX 20-25: elevated uncertainty
  if (vix < 25) return -3;

  // VIX 25-30: high fear
  if (vix < 30) return -5;

  // VIX 30-40: extreme fear
  if (vix < 40) return -8;

  // VIX 40+: panic mode
  return -10;
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
    const prePostMarket = calcPrePostMarketScore(stockData);
    const meanReversion = calcMeanReversionBonus(stockData);
    const vixAdj = calcVIXAdjustment(stockData);

    const baseScore = catalyst + earningsQuality + revision + social + news + technical + liquidity + meanReversion;
    const totalScore = Math.max(0, Math.min(100, baseScore + pead + overextension + prePostMarket + vixAdj));

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
        liquidity,
        prePostMarket,
        meanReversion,
        vixAdj
      },
      confidence: totalScore >= 70 ? 'HIGH' : totalScore >= 50 ? 'MEDIUM' : 'LOW',
      probability: Math.round(50 + (totalScore / 100) * 45)
    };
  } catch (err) {
    return {
      totalScore: 0,
      breakdown: { catalyst: 0, earningsQuality: 0, revision: 0, social: 0, news: 0, technical: 0, pead: 0, overextension: 0, liquidity: 0, prePostMarket: 0, meanReversion: 0, vixAdj: 0 },
      confidence: 'LOW',
      probability: 50
    };
  }
}
