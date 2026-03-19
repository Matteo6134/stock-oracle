/**
 * Wishlist Alert Monitor
 *
 * Checks the user's wishlist stocks against:
 * - Tomorrow Movers (buy_today, buy_today_or_tomorrow setups)
 * - Short Squeeze candidates
 * - Watch setups (coiled springs, accumulation)
 *
 * Sends push notifications with clear, actionable messages.
 * Each alert has a 4-hour cooldown to avoid spamming.
 */

import { sendLocalNotification, isNotificationEnabled } from './notifications'
import { getWishlist } from './wishlist'

const ALERT_STATE_KEY = 'wishlist_alert_state'
const ALERT_COOLDOWN = 4 * 60 * 60 * 1000 // 4 hours

function getState() {
  try { return JSON.parse(localStorage.getItem(ALERT_STATE_KEY) || '{}') } catch { return {} }
}

function saveState(s) {
  localStorage.setItem(ALERT_STATE_KEY, JSON.stringify(s))
}

function wasAlerted(state, symbol, type) {
  const key = `${symbol}_${type}`
  return state[key] && Date.now() - state[key] < ALERT_COOLDOWN
}

function markAlerted(state, symbol, type) {
  state[`${symbol}_${type}`] = Date.now()
}

/**
 * Check wishlist stocks and fire push notifications if any have entered
 * an important category (buy today, squeeze, watch setup).
 */
export async function checkWishlistAlerts() {
  if (!isNotificationEnabled()) return

  const wishlist = getWishlist()
  if (wishlist.length === 0) return

  const state = getState()
  const today = new Date().toISOString().slice(0, 10)

  // Reset state daily
  if (state._date !== today) {
    Object.keys(state).forEach(k => { if (k !== '_date') delete state[k] })
    state._date = today
  }

  try {
    const res = await fetch('/api/wishlist-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: wishlist }),
    })
    if (!res.ok) return
    const data = await res.json()

    for (const stock of (data.stocks || [])) {
      const sym = stock.symbol
      const name = stock.companyName || sym
      const price = stock.price ? `$${stock.price.toFixed(2)}` : ''
      const chg = stock.changePct ? `(${stock.changePct > 0 ? '+' : ''}${stock.changePct}%)` : ''

      // BUY TODAY — highest priority
      const isBuyToday = stock.alerts?.some(a => a.type === 'buy_today')
      if (isBuyToday && !wasAlerted(state, sym, 'buy_today')) {
        sendLocalNotification(
          `${sym} — BUY TODAY`,
          `${name} is in today's top Buy Tomorrow setups!\n${price} ${chg}\nOpen the app now for full analysis.`,
          `/stock/${sym}`
        )
        markAlerted(state, sym, 'buy_today')
      }

      // SQUEEZE LOADING — second priority
      const isSqueeze = stock.alerts?.some(a => a.type === 'squeeze')
      if (isSqueeze && !wasAlerted(state, sym, 'squeeze')) {
        sendLocalNotification(
          `${sym} — SQUEEZE LOADING`,
          `${name} has very high short interest — a squeeze could be building.\n${price} ${chg}\nShorts are trapped, watch for the pop.`,
          `/stock/${sym}`
        )
        markAlerted(state, sym, 'squeeze')
      }

      // WATCH SETUP — informational
      const isWatch = stock.alerts?.some(a => a.type === 'watch')
      if (isWatch && !isBuyToday && !wasAlerted(state, sym, 'watch')) {
        sendLocalNotification(
          `${sym} — Setup Forming`,
          `${name} is showing a breakout setup.\n${price} ${chg}\nWatch for confirmation before buying.`,
          `/stock/${sym}`
        )
        markAlerted(state, sym, 'watch')
      }
    }
  } catch {
    // Silent — don't break the app
  }

  saveState(state)
}
