import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { DollarSign, TrendingUp, TrendingDown, Target, Clock, CheckCircle, XCircle, Loader2, RefreshCw, Trash2, Bell, BellOff, AlertTriangle, Sun, Moon, Sunrise, Sunset } from 'lucide-react'
import { sendLocalNotification, isNotificationEnabled } from '../lib/notifications'
import { useToast } from '../components/Toast'

const API = import.meta.env.VITE_API_URL || ''
const STORAGE_KEY = 'paper_trades'
const MARKET_NOTIF_KEY = 'market_notif_state'
const POLL_INTERVAL = 60_000 // 1 min price refresh

function loadTrades() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

function saveTrades(trades) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trades))
}

function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function formatPct(n) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}%`
}

// ── Market Hours (US Eastern) ──
function getMarketSession() {
  const now = new Date()
  const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  const ny = new Date(nyStr)
  const hr = ny.getHours()
  const min = ny.getMinutes()
  const totalMin = hr * 60 + min
  const day = ny.getDay() // 0=Sun, 6=Sat

  // Weekend
  if (day === 0 || day === 6) {
    return {
      session: 'CLOSED',
      label: 'Weekend — Market Closed',
      icon: Moon,
      color: 'text-oracle-muted',
      bg: 'bg-white/5 border-oracle-border',
      canTrade: false,
      nextEvent: day === 6 ? 'Opens Monday 9:30 AM ET' : 'Opens Tomorrow 9:30 AM ET',
      nyTime: ny
    }
  }

  // Premarket: 4:00 AM - 9:29 AM ET
  if (totalMin >= 240 && totalMin < 570) {
    const minsToOpen = 570 - totalMin
    return {
      session: 'PRE',
      label: 'Pre-Market',
      icon: Sunrise,
      color: 'text-oracle-yellow',
      bg: 'bg-oracle-yellow/10 border-oracle-yellow/30',
      canTrade: false,
      nextEvent: `Market opens in ${Math.floor(minsToOpen / 60)}h ${minsToOpen % 60}m`,
      nyTime: ny
    }
  }

  // Regular: 9:30 AM - 3:59 PM ET
  if (totalMin >= 570 && totalMin < 960) {
    const minsToClose = 960 - totalMin
    return {
      session: 'REGULAR',
      label: 'Market Open',
      icon: Sun,
      color: 'text-oracle-green',
      bg: 'bg-oracle-green/10 border-oracle-green/30',
      canTrade: true,
      nextEvent: `Closes in ${Math.floor(minsToClose / 60)}h ${minsToClose % 60}m`,
      nyTime: ny
    }
  }

  // After hours: 4:00 PM - 7:59 PM ET
  if (totalMin >= 960 && totalMin < 1200) {
    return {
      session: 'POST',
      label: 'After Hours',
      icon: Sunset,
      color: 'text-oracle-purple',
      bg: 'bg-oracle-purple/10 border-oracle-purple/30',
      canTrade: false,
      nextEvent: 'Opens tomorrow 9:30 AM ET',
      nyTime: ny
    }
  }

  // Closed: 8:00 PM - 3:59 AM ET
  return {
    session: 'CLOSED',
    label: 'Market Closed',
    icon: Moon,
    color: 'text-oracle-muted',
    bg: 'bg-white/5 border-oracle-border',
    canTrade: false,
    nextEvent: totalMin < 240 ? 'Pre-market starts at 4:00 AM ET' : 'Opens tomorrow 9:30 AM ET',
    nyTime: ny
  }
}

// ── Market event notifications ──
function checkMarketNotifications(session) {
  if (!isNotificationEnabled()) return

  try {
    const state = JSON.parse(localStorage.getItem(MARKET_NOTIF_KEY) || '{}')
    const today = new Date().toISOString().slice(0, 10)

    // Reset daily flags
    if (state.date !== today) {
      state.date = today
      state.preMarketNotified = false
      state.openNotified = false
      state.closeWarningNotified = false
      state.closeNotified = false
      state.afterHoursNotified = false
    }

    const ny = session.nyTime
    const hr = ny.getHours()
    const min = ny.getMinutes()
    const totalMin = hr * 60 + min

    // Pre-market opens (4:00 AM ET)
    if (totalMin >= 240 && totalMin < 245 && !state.preMarketNotified) {
      sendLocalNotification('Pre-Market Open', 'Pre-market trading has started. Check early movers.', '/paper')
      state.preMarketNotified = true
    }

    // Market opens (9:30 AM ET)
    if (totalMin >= 570 && totalMin < 575 && !state.openNotified) {
      sendLocalNotification('Market Open', 'US market is now open. Check your picks.', '/paper')
      state.openNotified = true
    }

    // 15 min before close warning (3:45 PM ET)
    if (totalMin >= 945 && totalMin < 950 && !state.closeWarningNotified) {
      sendLocalNotification('Market Closing Soon', 'Market closes in 15 minutes. Review open positions.', '/paper')
      state.closeWarningNotified = true
    }

    // Market close (4:00 PM ET)
    if (totalMin >= 960 && totalMin < 965 && !state.closeNotified) {
      sendLocalNotification('Market Closed', 'Regular hours ended. After-hours trading active.', '/paper')
      state.closeNotified = true
    }

    // After hours active (4:05 PM ET)
    if (totalMin >= 965 && totalMin < 970 && !state.afterHoursNotified) {
      sendLocalNotification('After Hours Active', 'After-hours prices updating. No new paper trades.', '/paper')
      state.afterHoursNotified = true
    }

    localStorage.setItem(MARKET_NOTIF_KEY, JSON.stringify(state))
  } catch { /* silent */ }
}

export default function PaperTradingPage() {
  const navigate = useNavigate()
  const { success: toastSuccess, error: toastError, warning: toastWarning } = useToast()
  const [trades, setTrades] = useState(loadTrades)
  const [predictions, setPredictions] = useState([])
  const [loading, setLoading] = useState(true)
  const [investAmount, setInvestAmountState] = useState(() => {
    try { return parseInt(localStorage.getItem('paper_invest_amount')) || 1000 } catch { return 1000 }
  })
  const setInvestAmount = (amt) => {
    setInvestAmountState(amt)
    localStorage.setItem('paper_invest_amount', String(amt))
  }
  const [marketSession, setMarketSession] = useState(getMarketSession)
  const [confirmCancel, setConfirmCancel] = useState(null) // trade id to confirm cancel
  const pollRef = useRef(null)

  // Update market session every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      const session = getMarketSession()
      setMarketSession(session)
      checkMarketNotifications(session)
    }, 30_000)
    return () => clearInterval(interval)
  }, [])

  // Load predictions for quick-add
  useEffect(() => {
    fetch(`${API}/api/predictions`).then(r => r.json()).then(d => {
      setPredictions(d.predictions || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Poll live prices for open trades (works during ALL sessions for display)
  const updatePrices = useCallback(async () => {
    const openTrades = trades.filter(t => t.status === 'open')
    if (openTrades.length === 0) return

    const symbols = [...new Set(openTrades.map(t => t.symbol))].join(',')
    try {
      const res = await fetch(`${API}/api/prices?symbols=${symbols}`)
      const data = await res.json()
      if (!data.prices) return

      const now = Date.now()
      const session = getMarketSession()

      setTrades(prev => {
        const updated = prev.map(t => {
          if (t.status !== 'open') return t
          const priceData = data.prices[t.symbol]
          if (!priceData) return t

          // Use session-appropriate price
          const mktState = priceData.marketState || session.session
          let currentPrice = priceData.price || priceData.regularPrice || t.currentPrice
          let sessionPrice = null
          let sessionLabel = null

          if (mktState === 'PRE' && priceData.preMarketPrice) {
            sessionPrice = priceData.preMarketPrice
            sessionLabel = `Pre: $${priceData.preMarketPrice.toFixed(2)} (${priceData.preMarketChange >= 0 ? '+' : ''}${(priceData.preMarketChange || 0).toFixed(2)}%)`
          } else if ((mktState === 'POST' || mktState === 'CLOSED') && priceData.postMarketPrice) {
            sessionPrice = priceData.postMarketPrice
            sessionLabel = `AH: $${priceData.postMarketPrice.toFixed(2)} (${priceData.postMarketChange >= 0 ? '+' : ''}${(priceData.postMarketChange || 0).toFixed(2)}%)`
          }

          const pl = ((currentPrice - t.entryPrice) / t.entryPrice) * 100
          const plDollar = (currentPrice - t.entryPrice) * t.shares

          // TRAILING STOP: only during regular hours
          let trailingStop = t.trailingStop || t.stopLoss
          const highWaterMark = Math.max(t.highWaterMark || t.entryPrice, currentPrice)

          if (currentPrice > t.entryPrice && session.session === 'REGULAR') {
            const maxGain = highWaterMark - t.entryPrice
            const trailedLevel = t.entryPrice + maxGain * 0.5
            if (trailedLevel > trailingStop) {
              trailingStop = Math.round(trailedLevel * 100) / 100
            }
          }

          // Check if target or stop hit — ONLY during regular market hours
          let newStatus = 'open'
          let exitReason = null
          let exitPrice = null

          if (session.session === 'REGULAR') {
            if (currentPrice >= t.targetPrice) {
              newStatus = 'won'
              exitPrice = t.targetPrice
              exitReason = 'Target hit'
              if (isNotificationEnabled()) {
                sendLocalNotification(
                  `${t.symbol} HIT TARGET`,
                  `$${currentPrice.toFixed(2)} | P/L: +${pl.toFixed(1)}%`,
                  '/paper'
                )
              }
            } else if (currentPrice <= trailingStop) {
              newStatus = pl > 0 ? 'won' : 'lost'
              exitPrice = trailingStop
              exitReason = trailingStop > t.stopLoss ? 'Trailing stop (profit locked)' : 'Stop loss triggered'
              if (isNotificationEnabled()) {
                sendLocalNotification(
                  `${t.symbol} ${pl > 0 ? 'TRAILING STOP' : 'STOP HIT'}`,
                  `$${currentPrice.toFixed(2)} | P/L: ${formatPct(pl)}`,
                  '/paper'
                )
              }
            }

            // Auto-close at market close (3:55 PM ET — 5 min buffer)
            const nyNow = session.nyTime
            const totalMin = nyNow.getHours() * 60 + nyNow.getMinutes()
            if (totalMin >= 955 && t.autoCloseEOD && newStatus === 'open') {
              newStatus = pl > 0 ? 'won' : 'lost'
              exitPrice = currentPrice
              exitReason = 'Market closing — auto-exit'
            }
          }

          return {
            ...t,
            currentPrice,
            sessionPrice,
            sessionLabel,
            marketState: mktState,
            pl: Math.round(pl * 100) / 100,
            plDollar: Math.round(plDollar * 100) / 100,
            trailingStop,
            highWaterMark,
            lastUpdate: now,
            ...(newStatus !== 'open' ? { status: newStatus, exitPrice, exitReason, closedAt: new Date().toISOString() } : {})
          }
        })
        saveTrades(updated)
        return updated
      })
    } catch (err) {
      console.error('Price update failed:', err)
    }
  }, [trades])

  // Start polling
  useEffect(() => {
    updatePrices()
    pollRef.current = setInterval(updatePrices, POLL_INTERVAL)
    return () => clearInterval(pollRef.current)
  }, [updatePrices])

  // Add a paper trade from prediction (dynamic position sizing)
  const addTrade = (stock) => {
    if (!marketSession.canTrade) return // Block trades outside market hours

    // Dynamic position sizing based on confidence + market regime
    const sizeMultiplier = stock.positionSizing?.sizeMultiplier || (
      stock.confidence === 'HIGH' ? 1.0 :
      stock.confidence === 'MEDIUM' ? 0.7 : 0.4
    )
    const adjustedInvest = Math.round(investAmount * sizeMultiplier)
    const shares = Math.floor(adjustedInvest / stock.price)
    if (shares <= 0) return

    // PEAD drift: don't auto-close at EOD if stock is in post-earnings drift
    const holdOvernight = stock.peadDrift === true

    const newTrade = {
      id: Date.now(),
      symbol: stock.symbol,
      companyName: stock.companyName,
      entryPrice: stock.price,
      targetPrice: stock.tradeSetup?.targetPrice || stock.price * 1.03,
      stopLoss: stock.tradeSetup?.stopLoss || stock.price * 0.97,
      conservativeTarget: stock.tradeSetup?.conservativeTarget || null,
      aggressiveTarget: stock.tradeSetup?.aggressiveTarget || null,
      shares,
      invested: Math.round(shares * stock.price * 100) / 100,
      sizeMultiplier,
      sizeReason: stock.positionSizing?.reason || `${stock.confidence} confidence`,
      score: stock.score,
      confidence: stock.confidence,
      currentPrice: stock.price,
      pl: 0,
      plDollar: 0,
      status: 'open',
      exitPrice: null,
      exitReason: null,
      autoCloseEOD: !holdOvernight,
      peadDrift: holdOvernight,
      openedAt: new Date().toISOString(),
      closedAt: null,
      lastUpdate: Date.now()
    }

    const updated = [newTrade, ...trades]
    setTrades(updated)
    saveTrades(updated)
    toastSuccess(`${stock.symbol} — ${shares} shares @ $${stock.price.toFixed(2)}`)
  }

  // Cancel/remove a single trade (open or closed)
  const cancelTrade = (id) => {
    setTrades(prev => {
      const trade = prev.find(t => t.id === id)
      if (!trade) return prev

      // If open, close it as cancelled first
      if (trade.status === 'open') {
        const updated = prev.map(t => {
          if (t.id !== id) return t
          return {
            ...t,
            status: t.pl > 0 ? 'won' : 'lost',
            exitPrice: t.currentPrice,
            exitReason: '✖ Cancelled',
            closedAt: new Date().toISOString()
          }
        })
        saveTrades(updated)
        return updated
      }

      // If already closed, remove entirely
      const updated = prev.filter(t => t.id !== id)
      saveTrades(updated)
      return updated
    })
    setConfirmCancel(null)
  }

  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const clearClosed = () => {
    const count = trades.filter(t => t.status !== 'open').length
    const updated = trades.filter(t => t.status === 'open')
    setTrades(updated)
    saveTrades(updated)
    setConfirmClearAll(false)
    toastSuccess(`Cleared ${count} closed trade${count !== 1 ? 's' : ''}`)
  }

  const manualClose = (id) => {
    if (!marketSession.canTrade && marketSession.session !== 'POST') return

    const trade = trades.find(t => t.id === id)
    const updated = trades.map(t => {
      if (t.id !== id || t.status !== 'open') return t
      return {
        ...t,
        status: t.pl > 0 ? 'won' : 'lost',
        exitPrice: t.currentPrice,
        exitReason: marketSession.session === 'POST' ? 'Manual close (after hours)' : 'Manual close',
        closedAt: new Date().toISOString()
      }
    })
    setTrades(updated)
    saveTrades(updated)
    if (trade) {
      const pl = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100
      if (pl >= 0) toastSuccess(`${trade.symbol} closed +${pl.toFixed(1)}%`)
      else toastWarning(`${trade.symbol} closed ${pl.toFixed(1)}%`)
    }
  }

  // Stats
  const openTrades = trades.filter(t => t.status === 'open')
  const closedTrades = trades.filter(t => t.status !== 'open')
  const wins = closedTrades.filter(t => t.status === 'won').length
  const losses = closedTrades.filter(t => t.status === 'lost').length
  const totalPl = closedTrades.reduce((s, t) => s + (t.plDollar || 0), 0)
  const winRate = closedTrades.length > 0 ? Math.round((wins / closedTrades.length) * 100) : null
  const openPl = openTrades.reduce((s, t) => s + (t.plDollar || 0), 0)

  const SessionIcon = marketSession.icon

  return (
    <div className="px-4 pb-24 pt-2 max-w-lg mx-auto">
      <h1 className="text-lg font-bold text-oracle-text mb-1">Paper Trading</h1>
      <p className="text-xs text-oracle-muted mb-3">Simulate trades with virtual money. Track if targets get hit.</p>

      {/* Market Session Banner */}
      <div className={`p-2.5 rounded-xl border flex items-center gap-2 mb-4 ${marketSession.bg}`}>
        <SessionIcon size={16} className={marketSession.color} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold ${marketSession.color}`}>{marketSession.label}</span>
            <span className="text-[10px] text-oracle-muted">
              {new Date().toLocaleTimeString('en-US', {
                timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true
              })} ET
              {' / '}
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} local
            </span>
          </div>
          <p className="text-[10px] text-oracle-muted/70">{marketSession.nextEvent}</p>
        </div>
        {!marketSession.canTrade && (
          <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-oracle-red/15 text-oracle-red font-bold">
            NO TRADING
          </span>
        )}
      </div>

      {/* Portfolio Stats */}
      <div className="glass-card p-3 mb-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-[10px] text-oracle-muted">Open P/L</div>
            <div className={`text-sm font-bold ${openPl >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {formatMoney(openPl)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-oracle-muted">Closed P/L</div>
            <div className={`text-sm font-bold ${totalPl >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {formatMoney(totalPl)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-oracle-muted">Win Rate</div>
            <div className={`text-sm font-bold ${winRate !== null && winRate >= 50 ? 'text-oracle-green' : winRate !== null ? 'text-oracle-red' : 'text-oracle-muted'}`}>
              {winRate !== null ? `${winRate}%` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-oracle-muted">W / L</div>
            <div className="text-sm font-bold text-oracle-text">{wins} / {losses}</div>
          </div>
        </div>
      </div>

      {/* Investment Amount */}
      <div className="glass-card p-3 mb-4">
        <div className="text-[10px] text-oracle-muted font-medium mb-2">Investment per trade</div>
        <div className="flex gap-2">
          {[500, 1000, 2000, 5000].map(amt => (
            <button
              key={amt}
              onClick={() => setInvestAmount(amt)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                investAmount === amt
                  ? 'bg-oracle-accent/20 text-oracle-accent border border-oracle-accent/40'
                  : 'glass-inner text-oracle-muted hover:text-oracle-text'
              }`}
            >
              ${amt.toLocaleString()}
            </button>
          ))}
        </div>
      </div>

      {/* Quick Add from Predictions */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs text-oracle-muted font-medium">Today's Picks — Tap to simulate</h2>
          {loading && <Loader2 size={12} className="animate-spin text-oracle-muted" />}
        </div>

        {/* Market closed warning */}
        {!marketSession.canTrade && predictions.length > 0 && (
          <div className="flex items-center gap-1.5 p-2 rounded-lg bg-oracle-yellow/10 border border-oracle-yellow/20 mb-2">
            <AlertTriangle size={12} className="text-oracle-yellow shrink-0" />
            <span className="text-[10px] text-oracle-yellow">
              {marketSession.session === 'PRE'
                ? 'Pre-market — trading disabled. Prices shown are pre-market prices.'
                : marketSession.session === 'POST'
                ? 'After hours — trading disabled. After-hours prices shown.'
                : 'Market closed — you can view picks but can\'t open new trades.'}
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          {predictions.slice(0, 6).map(stock => {
            const alreadyAdded = trades.some(t => t.symbol === stock.symbol && t.status === 'open')
            const disabled = alreadyAdded || !marketSession.canTrade
            return (
              <button
                key={stock.symbol}
                onClick={() => !disabled && addTrade(stock)}
                disabled={disabled}
                className={`w-full glass-card p-2.5 flex items-center justify-between transition-all ${
                  disabled ? 'opacity-40' : 'hover:bg-white/[0.03] active:scale-[0.98]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-oracle-text font-bold text-sm">{stock.symbol}</span>
                  <span className="text-oracle-muted text-[10px] truncate max-w-[120px]">{stock.companyName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-oracle-text text-xs font-mono">${stock.price?.toFixed(2)}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    stock.score >= 70 ? 'bg-oracle-green/15 text-oracle-green'
                    : stock.score >= 50 ? 'bg-oracle-yellow/15 text-oracle-yellow'
                    : 'bg-oracle-red/15 text-oracle-red'
                  }`}>{stock.score}</span>
                  {alreadyAdded ? (
                    <CheckCircle size={14} className="text-oracle-green" />
                  ) : !marketSession.canTrade ? (
                    <Clock size={14} className="text-oracle-muted" />
                  ) : (
                    <DollarSign size={14} className="text-oracle-accent" />
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Open Trades */}
      {openTrades.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs text-oracle-muted font-medium">Open Positions ({openTrades.length})</h2>
            <button onClick={updatePrices} className="text-oracle-accent">
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="space-y-2">
            {openTrades.map(t => (
              <div key={t.id} className="glass-card p-3 border-l-4 border-l-oracle-accent">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-oracle-text font-bold text-sm">{t.symbol}</span>
                    <span className={`text-xs font-bold ${t.pl >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
                      {formatPct(t.pl)} ({formatMoney(t.plDollar)})
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {marketSession.canTrade || marketSession.session === 'POST' ? (
                      <button onClick={() => manualClose(t.id)} className="text-[9px] px-1.5 py-0.5 rounded bg-oracle-yellow/15 text-oracle-yellow border border-oracle-yellow/30 font-bold">
                        SELL
                      </button>
                    ) : null}
                    {confirmCancel === t.id ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => cancelTrade(t.id)} className="text-[8px] px-1.5 py-0.5 rounded bg-oracle-red/20 text-oracle-red border border-oracle-red/30 font-bold">
                          CONFIRM
                        </button>
                        <button onClick={() => setConfirmCancel(null)} className="text-[8px] px-1 py-0.5 text-oracle-muted">
                          NO
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmCancel(t.id)} className="text-oracle-muted hover:text-oracle-red">
                        <XCircle size={13} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Pre/Post market price indicator */}
                {t.sessionLabel && marketSession.session !== 'REGULAR' && (
                  <div className={`text-[9px] mb-1.5 px-2 py-0.5 rounded-full inline-block ${
                    marketSession.session === 'PRE'
                      ? 'bg-oracle-yellow/10 text-oracle-yellow'
                      : 'bg-oracle-purple/10 text-oracle-purple'
                  }`}>
                    {t.sessionLabel}
                  </div>
                )}

                {/* Price ladder */}
                <div className="relative h-6 rounded-full bg-oracle-border/20 overflow-hidden mb-1.5">
                  {(() => {
                    const effectiveStop = t.trailingStop || t.stopLoss
                    const range = t.targetPrice - effectiveStop
                    if (range <= 0) return null
                    return (
                      <>
                        {/* Stop zone */}
                        <div className="absolute left-0 top-0 bottom-0 bg-oracle-red/20 rounded-l-full"
                          style={{ width: `${Math.max(5, ((t.entryPrice - effectiveStop) / range) * 100)}%` }} />
                        {/* Target zone */}
                        <div className="absolute right-0 top-0 bottom-0 bg-oracle-green/20 rounded-r-full"
                          style={{ width: `${Math.max(5, ((t.targetPrice - t.entryPrice) / range) * 100)}%` }} />
                        {/* Trailing stop marker (yellow line when active) */}
                        {t.trailingStop && t.trailingStop > t.stopLoss && (
                          <div className="absolute top-0 bottom-0 w-0.5 bg-oracle-yellow rounded-full z-10"
                            style={{
                              left: `${Math.max(1, Math.min(99, ((t.trailingStop - effectiveStop) / range) * 100))}%`
                            }} />
                        )}
                        {/* Current price marker */}
                        <div className="absolute top-0 bottom-0 w-1 bg-oracle-accent rounded-full transition-all duration-500 z-20"
                          style={{
                            left: `${Math.max(2, Math.min(98, ((t.currentPrice - effectiveStop) / range) * 100))}%`
                          }} />
                      </>
                    )
                  })()}
                </div>

                <div className="flex justify-between text-[9px]">
                  <span className="text-oracle-red font-mono">
                    {t.trailingStop && t.trailingStop > t.stopLoss ? '🔒' : 'SL'} ${(t.trailingStop || t.stopLoss)?.toFixed(2)}
                  </span>
                  <span className="text-oracle-muted font-mono">
                    Entry ${t.entryPrice?.toFixed(2)} → Now ${t.currentPrice?.toFixed(2)}
                  </span>
                  <span className="text-oracle-green font-mono">TP ${t.targetPrice?.toFixed(2)}</span>
                </div>
                {t.trailingStop && t.trailingStop > t.stopLoss && (
                  <div className="text-[8px] text-oracle-green/60 mt-0.5">
                    Trailing stop active — original SL was ${t.stopLoss?.toFixed(2)}
                  </div>
                )}

                <div className="flex justify-between items-center text-[9px] text-oracle-muted mt-1">
                  <span>
                    {t.shares} shares x {formatMoney(t.invested)}
                    {t.sizeMultiplier && t.sizeMultiplier < 1.0 && (
                      <span className="ml-1 text-oracle-yellow">({Math.round(t.sizeMultiplier * 100)}%)</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    {t.peadDrift && <span className="text-oracle-accent font-semibold">PEAD</span>}
                    {new Date(t.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Closed Trades */}
      {closedTrades.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs text-oracle-muted font-medium">Closed ({closedTrades.length})</h2>
            {confirmClearAll ? (
              <div className="flex items-center gap-1.5">
                <button onClick={clearClosed} className="text-[10px] px-1.5 py-0.5 rounded bg-oracle-red/20 text-oracle-red border border-oracle-red/30 font-bold">DELETE ALL</button>
                <button onClick={() => setConfirmClearAll(false)} className="text-[10px] text-oracle-muted">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmClearAll(true)} className="text-[10px] text-oracle-muted hover:text-oracle-red">Clear all</button>
            )}
          </div>
          <div className="space-y-1.5">
            {closedTrades.map(t => (
              <div key={t.id} className={`glass-card p-2.5 border-l-4 ${
                t.status === 'won' ? 'border-l-oracle-green' : 'border-l-oracle-red'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {t.status === 'won' ? <CheckCircle size={12} className="text-oracle-green" /> : <XCircle size={12} className="text-oracle-red" />}
                    <span className="text-oracle-text font-bold text-xs">{t.symbol}</span>
                    <span className={`text-xs font-bold ${t.status === 'won' ? 'text-oracle-green' : 'text-oracle-red'}`}>
                      {formatPct(t.pl)} ({formatMoney(t.plDollar)})
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-oracle-muted">{t.exitReason}</span>
                    <button onClick={() => cancelTrade(t.id)} className="text-oracle-muted/40 hover:text-oracle-red">
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
                <div className="text-[9px] text-oracle-muted mt-0.5">
                  ${t.entryPrice?.toFixed(2)} → ${t.exitPrice?.toFixed(2)} • {t.shares} shares
                  {t.closedAt && ` • ${new Date(t.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {trades.length === 0 && !loading && (
        <div className="text-center py-12">
          <DollarSign size={32} className="mx-auto text-oracle-muted/30 mb-3" />
          <p className="text-oracle-muted text-sm">No paper trades yet</p>
          <p className="text-oracle-muted/60 text-xs mt-1">
            {marketSession.canTrade
              ? 'Tap a pick above to start simulating'
              : `Market is ${marketSession.session === 'PRE' ? 'in pre-market' : marketSession.session === 'POST' ? 'in after hours' : 'closed'}. Come back during market hours (9:30 AM - 4:00 PM ET) to trade.`
            }
          </p>
        </div>
      )}
    </div>
  )
}
