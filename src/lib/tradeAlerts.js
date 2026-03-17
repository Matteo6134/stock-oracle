/**
 * Smart Trade Alert System
 *
 * Monitors predictions in real-time during market hours and sends
 * actionable "BUY NOW" push notifications with:
 * - Which stock to buy and why
 * - How much to invest (based on user setting)
 * - Entry price, target price, stop loss
 * - When to exit
 *
 * Alert triggers:
 * 1. HIGH-CONFIDENCE ENTRY: Score >= 70 + entry signal "enter" + R:R >= 1.5
 * 2. DIP BUY OPPORTUNITY: Good stock pulled back to better entry
 * 3. MOMENTUM BREAKOUT: Stock breaking resistance with volume
 * 4. EARNINGS BEAT: After-hours/pre-market earnings beat detected
 * 5. TAKE PROFIT: Open paper trade approaching target
 * 6. EXIT NOW: Conditions changed, close position
 */

import { sendLocalNotification, isNotificationEnabled } from './notifications'

const ALERT_STATE_KEY = 'trade_alert_state'
const INVEST_KEY = 'paper_invest_amount'

function getAlertState() {
  try {
    return JSON.parse(localStorage.getItem(ALERT_STATE_KEY) || '{}')
  } catch { return {} }
}

function saveAlertState(state) {
  localStorage.setItem(ALERT_STATE_KEY, JSON.stringify(state))
}

function getInvestAmount() {
  // Read from paper trading page setting, default $1000
  try {
    return parseInt(localStorage.getItem(INVEST_KEY)) || 1000
  } catch { return 1000 }
}

// Check if we're in market hours (US Eastern)
function isMarketOpen() {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const hr = ny.getHours()
  const min = ny.getMinutes()
  const totalMin = hr * 60 + min
  const day = ny.getDay()
  if (day === 0 || day === 6) return false
  return totalMin >= 570 && totalMin < 960 // 9:30 AM - 4:00 PM ET
}

function isPreMarket() {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const hr = ny.getHours()
  const min = ny.getMinutes()
  const totalMin = hr * 60 + min
  const day = ny.getDay()
  if (day === 0 || day === 6) return false
  return totalMin >= 240 && totalMin < 570 // 4:00 AM - 9:29 AM ET
}

// Was this stock already alerted recently? (cooldown per stock)
function wasRecentlyAlerted(state, symbol, type, cooldownMs = 30 * 60 * 1000) {
  const key = `${symbol}_${type}`
  const lastAlert = state[key]
  if (!lastAlert) return false
  return Date.now() - lastAlert < cooldownMs
}

function markAlerted(state, symbol, type) {
  state[`${symbol}_${type}`] = Date.now()
  return state
}

/**
 * Main alert check — call this with fresh prediction data
 * @param {Array} predictions - Today's scored predictions from /api/predictions
 * @param {Array} openTrades - Current open paper trades
 */
export function checkSmartAlerts(predictions, openTrades = []) {
  if (!isNotificationEnabled()) return
  if (!predictions || predictions.length === 0) return

  const state = getAlertState()
  const today = new Date().toISOString().slice(0, 10)

  // Reset state daily
  if (state._date !== today) {
    Object.keys(state).forEach(k => { if (k !== '_date') delete state[k] })
    state._date = today
  }

  const investAmount = getInvestAmount()
  const openSymbols = new Set((openTrades || []).filter(t => t.status === 'open').map(t => t.symbol))

  // ═══════════════════════════════════════
  // 1. HIGH-CONFIDENCE BUY ALERTS (market hours only)
  // ═══════════════════════════════════════
  if (isMarketOpen()) {
    predictions.forEach((stock, idx) => {
      if (openSymbols.has(stock.symbol)) return // Already holding
      if (wasRecentlyAlerted(state, stock.symbol, 'buy')) return

      const score = stock.score || 0
      const rr = stock.tradeSetup?.riskReward || 0
      const entry = stock.entrySignal
      const confidence = stock.confidence
      const target = stock.tradeSetup?.targetPrice
      const stop = stock.tradeSetup?.stopLoss
      const price = stock.price

      if (!target || !stop || !price) return

      const shares = Math.floor(investAmount / price)
      if (shares <= 0) return

      const potentialProfit = ((target - price) / price * 100).toFixed(1)
      const riskPct = ((price - stop) / price * 100).toFixed(1)

      // HIGH confidence + good entry + strong R:R
      if (score >= 70 && entry === 'enter' && rr >= 1.5 && confidence === 'HIGH') {
        sendLocalNotification(
          `🚀 BUY ${stock.symbol} NOW — Score ${score}`,
          `$${price.toFixed(2)} → Target $${target.toFixed(2)} (+${potentialProfit}%)\n` +
          `Invest $${investAmount} (${shares} shares) | Stop $${stop.toFixed(2)} (-${riskPct}%)\n` +
          `R:R ${rr}x | ${stock.tradeSetup?.riskLabel || ''}`,
          `/stock/${stock.symbol}`
        )
        markAlerted(state, stock.symbol, 'buy')
      }
      // MEDIUM confidence but very strong R:R (>= 2.0) — worth a look
      else if (score >= 55 && entry === 'enter' && rr >= 2.0 && idx < 5) {
        sendLocalNotification(
          `📊 Consider ${stock.symbol} — Score ${score}`,
          `$${price.toFixed(2)} → Target $${target.toFixed(2)} (+${potentialProfit}%)\n` +
          `R:R ${rr}x — strong risk/reward. Invest $${investAmount} (${shares} shares)\n` +
          `Stop at $${stop.toFixed(2)} (-${riskPct}%)`,
          `/stock/${stock.symbol}`
        )
        markAlerted(state, stock.symbol, 'buy')
      }
    })
  }

  // ═══════════════════════════════════════
  // 2. DIP BUY ALERTS (stock dropped to better entry during the day)
  // ═══════════════════════════════════════
  if (isMarketOpen()) {
    predictions.forEach(stock => {
      if (openSymbols.has(stock.symbol)) return
      if (wasRecentlyAlerted(state, stock.symbol, 'dip')) return
      if (stock.score < 60) return

      const change = stock.change || 0
      const entry = stock.entrySignal
      const target = stock.tradeSetup?.targetPrice
      const price = stock.price

      if (!target || !price) return

      // Stock was rated good but dipped intraday — even better entry now
      if (change <= -1.5 && change >= -5 && entry !== 'too_late' && stock.score >= 60) {
        const newUpside = ((target - price) / price * 100).toFixed(1)
        const shares = Math.floor(investAmount / price)

        sendLocalNotification(
          `💰 DIP BUY: ${stock.symbol} down ${change.toFixed(1)}%`,
          `Now $${price.toFixed(2)} (dipped!) → Target $${target.toFixed(2)} (+${newUpside}%)\n` +
          `Score ${stock.score} — better entry than earlier. ${shares} shares for $${investAmount}`,
          `/stock/${stock.symbol}`
        )
        markAlerted(state, stock.symbol, 'dip')
      }
    })
  }

  // ═══════════════════════════════════════
  // 3. PRE-MARKET EARNINGS ALERT
  // ═══════════════════════════════════════
  if (isPreMarket()) {
    predictions.forEach(stock => {
      if (wasRecentlyAlerted(state, stock.symbol, 'premarket')) return

      // Earnings beat detected pre-market
      if (stock.earningsResult?.isReported && stock.earningsResult?.sentiment === 'bullish') {
        const reaction = stock.earningsResult.reaction || 0
        if (reaction >= 2) {
          sendLocalNotification(
            `✅ ${stock.symbol} BEAT EARNINGS (+${reaction.toFixed(1)}%)`,
            `${stock.earningsResult.status} — ${stock.earningsResult.summary}\n` +
            `Score ${stock.score}. Watch for entry at market open 9:30 AM ET.`,
            `/stock/${stock.symbol}`
          )
          markAlerted(state, stock.symbol, 'premarket')
        }
      }

      // Pre-market gap alert for top picks
      if (stock.preMarketPrice && stock.price && stock.score >= 65) {
        const gap = ((stock.preMarketPrice - stock.price) / stock.price * 100)
        if (gap >= 1 && gap <= 3 && !wasRecentlyAlerted(state, stock.symbol, 'pregap')) {
          sendLocalNotification(
            `🌅 ${stock.symbol} gapping up +${gap.toFixed(1)}% pre-market`,
            `Pre: $${stock.preMarketPrice.toFixed(2)} | Score ${stock.score}\n` +
            `Positive pre-market momentum. Watch for entry at open.`,
            `/stock/${stock.symbol}`
          )
          markAlerted(state, stock.symbol, 'pregap')
        }
      }
    })
  }

  // ═══════════════════════════════════════
  // 4. TAKE PROFIT / EXIT ALERTS (for open paper trades)
  // ═══════════════════════════════════════
  if (isMarketOpen() && openTrades && openTrades.length > 0) {
    openTrades.forEach(trade => {
      if (trade.status !== 'open') return
      if (!trade.currentPrice) return

      const pl = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100
      const price = trade.currentPrice

      // Approaching target (within 1%)
      if (trade.targetPrice && price >= trade.targetPrice * 0.99 && !wasRecentlyAlerted(state, trade.symbol, 'near_target')) {
        sendLocalNotification(
          `🎯 ${trade.symbol} NEAR TARGET — Take Profit?`,
          `Now $${price.toFixed(2)} (target $${trade.targetPrice.toFixed(2)})\n` +
          `P/L: +${pl.toFixed(1)}% (+${trade.plDollar?.toFixed(2) || '?'})\n` +
          `Consider selling now or let trailing stop protect gains.`,
          `/stock/${trade.symbol}`
        )
        markAlerted(state, trade.symbol, 'near_target')
      }

      // Significant profit (>3%) — remind to consider taking some off
      if (pl >= 3 && !wasRecentlyAlerted(state, trade.symbol, 'profit_3pct', 60 * 60 * 1000)) {
        sendLocalNotification(
          `📈 ${trade.symbol} +${pl.toFixed(1)}% — Lock Profits?`,
          `$${trade.entryPrice.toFixed(2)} → $${price.toFixed(2)} | +$${trade.plDollar?.toFixed(2) || '?'}\n` +
          `Trailing stop at $${(trade.trailingStop || trade.stopLoss)?.toFixed(2)}. Consider partial sell.`,
          `/stock/${trade.symbol}`
        )
        markAlerted(state, trade.symbol, 'profit_3pct')
      }

      // DANGER — losing >2% and approaching stop
      if (pl <= -2 && price <= trade.stopLoss * 1.02 && !wasRecentlyAlerted(state, trade.symbol, 'danger')) {
        sendLocalNotification(
          `⚠️ ${trade.symbol} DANGER — Near Stop Loss`,
          `Now $${price.toFixed(2)} | Stop $${trade.stopLoss.toFixed(2)}\n` +
          `P/L: ${pl.toFixed(1)}% ($${trade.plDollar?.toFixed(2) || '?'})\n` +
          `Consider selling manually if thesis is broken.`,
          `/stock/${trade.symbol}`
        )
        markAlerted(state, trade.symbol, 'danger')
      }
    })
  }

  saveAlertState(state)
}

/**
 * Generate the "why" explanation for a stock alert
 * Used when user taps notification and sees the detail page
 */
export function getAlertReason(stock) {
  if (!stock) return null

  const reasons = []
  const b = stock.breakdown || {}

  if (b.earningsQuality >= 15) reasons.push('Strong earnings history (consistent beats)')
  if (b.revision >= 12) reasons.push('Analysts raising estimates')
  if (b.technical >= 18) reasons.push('Technical setup is ideal (RSI, trend, volume)')
  if (b.catalyst >= 8) reasons.push('Upcoming earnings catalyst')
  if (b.prePostMarket >= 3) reasons.push('Positive pre-market activity')
  if (b.liquidity >= 4) reasons.push('High liquidity (safer)')

  if (stock.tradeSetup?.riskReward >= 2.0) reasons.push(`Excellent risk/reward (${stock.tradeSetup.riskReward}x)`)
  if (stock.earningsQuality?.beatStreak >= 3) reasons.push(`${stock.earningsQuality.beatStreak} quarter beat streak`)
  if (stock.entrySignal === 'enter') reasons.push('Entry timing is good (not overextended)')

  // Negatives
  if (b.overextension < -3) reasons.push('⚠️ Already extended — smaller position recommended')
  if (b.prePostMarket < -3) reasons.push('⚠️ Negative overnight sentiment')

  return {
    reasons,
    summary: reasons.slice(0, 3).join(' • '),
    investAmount: getInvestAmount(),
    shares: stock.price ? Math.floor(getInvestAmount() / stock.price) : 0
  }
}
