import { useState, useEffect, useRef, useCallback } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || ''

/**
 * Hook: Subscribe to Server-Sent Events for real-time data.
 * Returns live prices, gem updates, and mover alerts.
 */
export function useSSE() {
  const [prices, setPrices] = useState({})
  const [lastUpdate, setLastUpdate] = useState(null)
  const [connected, setConnected] = useState(false)
  const [gemsAlert, setGemsAlert] = useState(null)
  const [moversAlert, setMoversAlert] = useState(null)
  const eventSourceRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)

  const connect = useCallback(() => {
    if (eventSourceRef.current) return

    try {
      const es = new EventSource(`${API_BASE}/api/stream`)
      eventSourceRef.current = es

      es.onopen = () => {
        setConnected(true)
        console.log('[SSE] Connected')
      }

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          switch (data.type) {
            case 'prices':
              setPrices(prev => ({ ...prev, ...data.prices }))
              setLastUpdate(data.timestamp)
              break
            case 'gems_update':
              setGemsAlert(data)
              break
            case 'movers_update':
              setMoversAlert(data)
              break
            case 'connected':
              // Initial connection ack
              break
          }
        } catch { /* ignore parse errors */ }
      }

      es.onerror = () => {
        setConnected(false)
        es.close()
        eventSourceRef.current = null
        // Reconnect after 5s
        reconnectTimeoutRef.current = setTimeout(connect, 5000)
      }
    } catch {
      // SSE not supported or URL issue
      setConnected(false)
    }
  }, [])

  useEffect(() => {
    // Only connect if tab is visible
    if (document.visibilityState === 'visible') {
      connect()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!eventSourceRef.current) connect()
      } else {
        // Disconnect when tab hidden to save resources
        if (eventSourceRef.current) {
          eventSourceRef.current.close()
          eventSourceRef.current = null
          setConnected(false)
        }
      }
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
    }
  }, [connect])

  // Clear alerts after 30s
  useEffect(() => {
    if (!gemsAlert) return
    const t = setTimeout(() => setGemsAlert(null), 30000)
    return () => clearTimeout(t)
  }, [gemsAlert])

  useEffect(() => {
    if (!moversAlert) return
    const t = setTimeout(() => setMoversAlert(null), 30000)
    return () => clearTimeout(t)
  }, [moversAlert])

  return { prices, lastUpdate, connected, gemsAlert, moversAlert }
}

/**
 * Apply SSE live prices to a stock object.
 * Merges fresh prices into existing stock data.
 */
export function applyLivePrice(stock, ssePrices) {
  if (!stock?.symbol || !ssePrices) return stock
  const fresh = ssePrices[stock.symbol]
  if (!fresh) return stock
  return {
    ...stock,
    price: fresh.price ?? stock.price,
    change: fresh.change ?? stock.change,
  }
}
