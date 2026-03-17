// PWA Notification Manager for Stock Oracle
// Uses browser Notification API — works on iOS Safari 16.4+ when added to Home Screen

const NOTIFICATION_PERMISSION_KEY = 'notif_enabled'

export function isNotificationSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator
}

export function isNotificationEnabled() {
  return localStorage.getItem(NOTIFICATION_PERMISSION_KEY) === 'true' && Notification.permission === 'granted'
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) return false

  try {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      localStorage.setItem(NOTIFICATION_PERMISSION_KEY, 'true')

      // Register service worker
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.register('/sw.js')
      }

      // Send a test notification
      new Notification('Stock Oracle', {
        body: 'Notifications enabled! You\'ll get alerts when targets are hit.',
        icon: '/icon-192.png'
      })

      return true
    }
    return false
  } catch (err) {
    console.error('Notification permission error:', err)
    return false
  }
}

export function disableNotifications() {
  localStorage.setItem(NOTIFICATION_PERMISSION_KEY, 'false')
}

// Send a local notification (no server needed)
export function sendLocalNotification(title, body, url = '/') {
  if (!isNotificationEnabled()) return

  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      // Use SW for background notifications
      navigator.serviceWorker.ready.then(registration => {
        registration.showNotification(title, {
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          vibrate: [100, 50, 100],
          data: { url },
          requireInteraction: true
        })
      })
    } else {
      // Fallback to basic notification
      new Notification(title, { body, icon: '/icon-192.png' })
    }
  } catch (err) {
    console.error('Notification send error:', err)
  }
}

// Check paper trades and send alerts when target/stop hit
export function checkTradeAlerts(trades) {
  if (!isNotificationEnabled()) return

  trades.forEach(trade => {
    if (trade.status !== 'open') return
    if (!trade.currentPrice || !trade.lastNotified) return

    // Skip if we already notified for this trade in the last 5 min
    if (trade.lastNotified && Date.now() - trade.lastNotified < 300000) return

    const pl = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100

    if (trade.currentPrice >= trade.targetPrice) {
      sendLocalNotification(
        `🎯 ${trade.symbol} HIT TARGET!`,
        `${trade.symbol} reached $${trade.currentPrice.toFixed(2)} (target: $${trade.targetPrice.toFixed(2)}). P/L: +${pl.toFixed(1)}%`,
        `/stock/${trade.symbol}`
      )
    } else if (trade.currentPrice <= trade.stopLoss) {
      sendLocalNotification(
        `🛑 ${trade.symbol} STOP HIT`,
        `${trade.symbol} dropped to $${trade.currentPrice.toFixed(2)} (stop: $${trade.stopLoss.toFixed(2)}). P/L: ${pl.toFixed(1)}%`,
        `/stock/${trade.symbol}`
      )
    } else if (pl >= 2) {
      // Alert when significantly positive
      sendLocalNotification(
        `📈 ${trade.symbol} +${pl.toFixed(1)}%`,
        `${trade.symbol} is up to $${trade.currentPrice.toFixed(2)}. Consider taking profit.`,
        `/stock/${trade.symbol}`
      )
    }
  })
}
