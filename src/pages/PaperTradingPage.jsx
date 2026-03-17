import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { DollarSign, TrendingUp, TrendingDown, Target, Clock, CheckCircle, XCircle, Loader2, RefreshCw, Trash2 } from 'lucide-react'

const API = import.meta.env.VITE_API_URL || ''
const STORAGE_KEY = 'paper_trades'
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

export default function PaperTradingPage() {
  const navigate = useNavigate()
  const [trades, setTrades] = useState(loadTrades)
  const [predictions, setPredictions] = useState([])
  const [loading, setLoading] = useState(true)
  const [investAmount, setInvestAmount] = useState(1000)
  const pollRef = useRef(null)

  // Load predictions for quick-add
  useEffect(() => {
    fetch(`${API}/api/predictions`).then(r => r.json()).then(d => {
      setPredictions(d.predictions || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Poll live prices for open trades
  const updatePrices = useCallback(async () => {
    const openTrades = trades.filter(t => t.status === 'open')
    if (openTrades.length === 0) return

    const symbols = [...new Set(openTrades.map(t => t.symbol))].join(',')
    try {
      const res = await fetch(`${API}/api/prices?symbols=${symbols}`)
      const data = await res.json()
      if (!data.prices) return

      const now = Date.now()
      setTrades(prev => {
        const updated = prev.map(t => {
          if (t.status !== 'open') return t
          const priceData = data.prices[t.symbol]
          if (!priceData?.price) return t

          const currentPrice = priceData.price
          const pl = ((currentPrice - t.entryPrice) / t.entryPrice) * 100
          const plDollar = (currentPrice - t.entryPrice) * t.shares

          // Check if target or stop hit
          let newStatus = 'open'
          let exitReason = null
          let exitPrice = null

          if (currentPrice >= t.targetPrice) {
            newStatus = 'won'
            exitPrice = t.targetPrice
            exitReason = 'Target hit!'
          } else if (currentPrice <= t.stopLoss) {
            newStatus = 'lost'
            exitPrice = t.stopLoss
            exitReason = 'Stop loss triggered'
          }

          // Check end of day (4 PM ET) — auto-close
          const nyTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false
          }).format(new Date())
          const [hr, min] = nyTime.split(':').map(Number)
          const isMarketClosed = hr >= 16 || hr < 9 || (hr === 9 && min < 30)

          if (isMarketClosed && t.autoCloseEOD && newStatus === 'open') {
            newStatus = pl > 0 ? 'won' : 'lost'
            exitPrice = currentPrice
            exitReason = 'Market closed — auto-exit'
          }

          return {
            ...t,
            currentPrice,
            pl: Math.round(pl * 100) / 100,
            plDollar: Math.round(plDollar * 100) / 100,
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

  // Add a paper trade from prediction
  const addTrade = (stock) => {
    const shares = Math.floor(investAmount / stock.price)
    if (shares <= 0) return

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
      score: stock.score,
      confidence: stock.confidence,
      currentPrice: stock.price,
      pl: 0,
      plDollar: 0,
      status: 'open', // open | won | lost
      exitPrice: null,
      exitReason: null,
      autoCloseEOD: true,
      openedAt: new Date().toISOString(),
      closedAt: null,
      lastUpdate: Date.now()
    }

    const updated = [newTrade, ...trades]
    setTrades(updated)
    saveTrades(updated)
  }

  const removeTrade = (id) => {
    const updated = trades.filter(t => t.id !== id)
    setTrades(updated)
    saveTrades(updated)
  }

  const clearClosed = () => {
    const updated = trades.filter(t => t.status === 'open')
    setTrades(updated)
    saveTrades(updated)
  }

  const manualClose = (id) => {
    const updated = trades.map(t => {
      if (t.id !== id || t.status !== 'open') return t
      return {
        ...t,
        status: t.pl > 0 ? 'won' : 'lost',
        exitPrice: t.currentPrice,
        exitReason: 'Manual close',
        closedAt: new Date().toISOString()
      }
    })
    setTrades(updated)
    saveTrades(updated)
  }

  // Stats
  const openTrades = trades.filter(t => t.status === 'open')
  const closedTrades = trades.filter(t => t.status !== 'open')
  const wins = closedTrades.filter(t => t.status === 'won').length
  const losses = closedTrades.filter(t => t.status === 'lost').length
  const totalPl = closedTrades.reduce((s, t) => s + (t.plDollar || 0), 0)
  const winRate = closedTrades.length > 0 ? Math.round((wins / closedTrades.length) * 100) : null
  const openPl = openTrades.reduce((s, t) => s + (t.plDollar || 0), 0)

  return (
    <div className="px-4 pb-24 pt-2 max-w-lg mx-auto">
      <h1 className="text-lg font-bold text-oracle-text mb-1">Paper Trading</h1>
      <p className="text-xs text-oracle-muted mb-4">Simulate trades with virtual money. Track if targets get hit.</p>

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
        <div className="space-y-1.5">
          {predictions.slice(0, 6).map(stock => {
            const alreadyAdded = trades.some(t => t.symbol === stock.symbol && t.status === 'open')
            return (
              <button
                key={stock.symbol}
                onClick={() => !alreadyAdded && addTrade(stock)}
                disabled={alreadyAdded}
                className={`w-full glass-card p-2.5 flex items-center justify-between transition-all ${
                  alreadyAdded ? 'opacity-40' : 'hover:bg-white/[0.03] active:scale-[0.98]'
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
                    <button onClick={() => manualClose(t.id)} className="text-[9px] px-1.5 py-0.5 rounded bg-oracle-yellow/15 text-oracle-yellow border border-oracle-yellow/30 font-bold">
                      SELL
                    </button>
                    <button onClick={() => removeTrade(t.id)} className="text-oracle-muted hover:text-oracle-red">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* Price ladder */}
                <div className="relative h-6 rounded-full bg-oracle-border/20 overflow-hidden mb-1.5">
                  {/* Stop zone */}
                  <div className="absolute left-0 top-0 bottom-0 bg-oracle-red/20 rounded-l-full"
                    style={{ width: `${Math.max(5, ((t.entryPrice - t.stopLoss) / (t.targetPrice - t.stopLoss)) * 100)}%` }} />
                  {/* Target zone */}
                  <div className="absolute right-0 top-0 bottom-0 bg-oracle-green/20 rounded-r-full"
                    style={{ width: `${Math.max(5, ((t.targetPrice - t.entryPrice) / (t.targetPrice - t.stopLoss)) * 100)}%` }} />
                  {/* Current price marker */}
                  <div className="absolute top-0 bottom-0 w-1 bg-oracle-accent rounded-full transition-all duration-500"
                    style={{
                      left: `${Math.max(2, Math.min(98, ((t.currentPrice - t.stopLoss) / (t.targetPrice - t.stopLoss)) * 100))}%`
                    }} />
                </div>

                <div className="flex justify-between text-[9px]">
                  <span className="text-oracle-red font-mono">SL ${t.stopLoss?.toFixed(2)}</span>
                  <span className="text-oracle-muted font-mono">
                    Entry ${t.entryPrice?.toFixed(2)} → Now ${t.currentPrice?.toFixed(2)}
                  </span>
                  <span className="text-oracle-green font-mono">TP ${t.targetPrice?.toFixed(2)}</span>
                </div>

                <div className="flex justify-between text-[9px] text-oracle-muted mt-1">
                  <span>{t.shares} shares × {formatMoney(t.invested)}</span>
                  <span>{new Date(t.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
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
            <button onClick={clearClosed} className="text-[10px] text-oracle-muted hover:text-oracle-red">Clear</button>
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
                  <span className="text-[9px] text-oracle-muted">{t.exitReason}</span>
                </div>
                <div className="text-[9px] text-oracle-muted mt-0.5">
                  ${t.entryPrice?.toFixed(2)} → ${t.exitPrice?.toFixed(2)} • {t.shares} shares
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
          <p className="text-oracle-muted/60 text-xs mt-1">Tap a pick above to start simulating</p>
        </div>
      )}
    </div>
  )
}
