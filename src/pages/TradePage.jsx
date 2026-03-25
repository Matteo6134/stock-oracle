import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DollarSign, TrendingUp, TrendingDown, RefreshCw,
  CheckCircle, XCircle, Clock, BarChart3, Target,
  AlertTriangle, Wallet, Bot, ChevronRight
} from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

function formatMoney(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(n || 0)
}

function formatPct(n) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${(n || 0).toFixed(2)}%`
}

// ── P&L Summary Card ──
function PnLSummary({ trades }) {
  const wins = trades.filter(t => (t.pnl || t.profit || 0) > 0)
  const losses = trades.filter(t => (t.pnl || t.profit || 0) < 0)
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || t.profit || 0), 0)
  const winRate = trades.length > 0 ? ((wins.length / trades.length) * 100) : 0

  return (
    <div className="grid grid-cols-2 gap-3 mb-4">
      {/* Total P&L */}
      <div className="col-span-2 bg-gray-900 border border-gray-800 rounded-2xl p-4 text-center">
        <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1">Total P&L</p>
        <p className={`text-4xl font-black ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {formatMoney(totalPnl)}
        </p>
      </div>

      {/* Win Rate */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-3 text-center">
        <p className="text-3xl font-black text-white">{winRate.toFixed(0)}%</p>
        <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Win Rate</p>
      </div>

      {/* W / L */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-3 text-center">
        <p className="text-3xl font-black">
          <span className="text-green-400">{wins.length}</span>
          <span className="text-gray-600 mx-1">/</span>
          <span className="text-red-400">{losses.length}</span>
        </p>
        <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Wins / Losses</p>
      </div>
    </div>
  )
}

// ── Open Position Card ──
function PositionCard({ position, onClick }) {
  const pnl = position.unrealizedPL || position.unrealized_pl || position.pnl || 0
  const isUp = pnl >= 0
  const qty = position.qty || position.quantity || 0
  const avgEntry = position.avgEntryPrice || position.avg_entry_price || position.entryPrice || 0
  const currentPrice = position.currentPrice || position.current_price || position.marketValue / qty || 0

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-2xl p-4 cursor-pointer hover:bg-gray-900/80 hover:border-gray-700 transition-all active:scale-[0.99]"
      onClick={() => onClick(position.symbol)}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-black text-base">{position.symbol}</span>
            <span className="text-gray-500 text-[10px]">{qty} shares</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>Entry ${avgEntry > 0 ? avgEntry.toFixed(2) : '?'}</span>
            {currentPrice > 0 && <span>Now ${currentPrice.toFixed(2)}</span>}
          </div>
        </div>
        <div className="text-right">
          <p className={`text-lg font-black ${isUp ? 'text-green-400' : 'text-red-400'}`}>
            {formatMoney(pnl)}
          </p>
          <p className={`text-xs font-semibold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
            {isUp ? <TrendingUp size={10} className="inline mr-0.5" /> : <TrendingDown size={10} className="inline mr-0.5" />}
            {avgEntry > 0 ? formatPct(((currentPrice - avgEntry) / avgEntry) * 100) : '—'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Trade History Card ──
function TradeCard({ trade }) {
  const pnl = trade.pnl || trade.profit || trade.realizedPL || 0
  const isWin = pnl > 0
  const entryPrice = trade.entryPrice || trade.entry_price || trade.avgEntry || 0
  const exitPrice = trade.exitPrice || trade.exit_price || trade.avgExit || 0
  const symbol = trade.symbol || trade.ticker || ''
  const date = trade.closedAt || trade.closed_at || trade.date || trade.timestamp || ''

  return (
    <div className={`bg-gray-900 border rounded-2xl p-3 ${isWin ? 'border-green-500/20' : 'border-red-500/20'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isWin
            ? <CheckCircle size={16} className="text-green-400" />
            : <XCircle size={16} className="text-red-400" />
          }
          <span className="text-white font-bold text-sm">{symbol}</span>
          {date && (
            <span className="text-gray-600 text-[10px]">
              {new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
        <span className={`text-sm font-black ${isWin ? 'text-green-400' : 'text-red-400'}`}>
          {formatMoney(pnl)}
        </span>
      </div>
      {(entryPrice > 0 || exitPrice > 0) && (
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-gray-500 ml-6">
          {entryPrice > 0 && <span>${entryPrice.toFixed(2)}</span>}
          {entryPrice > 0 && exitPrice > 0 && <span className="text-gray-700">→</span>}
          {exitPrice > 0 && <span>${exitPrice.toFixed(2)}</span>}
          {entryPrice > 0 && exitPrice > 0 && (
            <span className={isWin ? 'text-green-400' : 'text-red-400'}>
              ({formatPct(((exitPrice - entryPrice) / entryPrice) * 100)})
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Not Configured State ──
function SetupPrompt() {
  return (
    <div className="py-16 text-center">
      <Wallet size={48} className="text-gray-700 mx-auto mb-4" />
      <p className="text-white text-sm font-semibold mb-1">Auto-Trade Not Configured</p>
      <p className="text-gray-500 text-xs max-w-xs mx-auto mb-4">
        Connect Alpaca paper trading to enable auto-trade. Set ALPACA_API_KEY and ALPACA_SECRET_KEY in your .env file.
      </p>
    </div>
  )
}

// ── Main Page ──
export default function TradePage() {
  const navigate = useNavigate()
  const [trades, setTrades] = useState([])
  const [positions, setPositions] = useState([])
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const refreshTimer = useRef(null)

  const fetchData = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true)
    setError(null)
    try {
      const [logRes, configRes] = await Promise.all([
        fetch(`${API_BASE}/api/auto-trade/log`).catch(() => null),
        fetch(`${API_BASE}/api/auto-trade/config`).catch(() => null),
      ])

      // Check if auto-trade is configured
      if (logRes && logRes.status === 404 && configRes && configRes.status === 404) {
        setNotConfigured(true)
        setLoading(false)
        return
      }

      if (logRes && logRes.ok) {
        const logData = await logRes.json()
        const tradeList = logData.trades || logData.log || logData.history || (Array.isArray(logData) ? logData : [])
        setTrades(tradeList)

        // Extract open positions from the log data if provided
        const pos = logData.positions || logData.openPositions || []
        if (pos.length > 0) setPositions(pos)
      }

      if (configRes && configRes.ok) {
        const cfgData = await configRes.json()
        setConfig(cfgData)
      }

      // Also try to get positions from Alpaca endpoint
      try {
        const posRes = await fetch(`${API_BASE}/api/alpaca/positions`)
        if (posRes.ok) {
          const posData = await posRes.json()
          const posList = posData.positions || (Array.isArray(posData) ? posData : [])
          if (posList.length > 0) setPositions(posList)
        }
      } catch {
        // Silent — positions may not be available
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(true)
    refreshTimer.current = setInterval(() => fetchData(false), 60_000)
    return () => clearInterval(refreshTimer.current)
  }, [fetchData])

  if (notConfigured) {
    return (
      <div className="max-w-lg mx-auto px-4 pt-1 pb-8">
        <h1 className="text-2xl font-black text-white flex items-center gap-2 mb-4">
          <Bot className="text-blue-400" size={24} />
          Auto-Trade
        </h1>
        <SetupPrompt />
      </div>
    )
  }

  // Separate closed trades (for P&L) from entries
  const closedTrades = trades.filter(t => {
    const pnl = t.pnl || t.profit || t.realizedPL || 0
    return pnl !== 0 || t.exitPrice || t.exit_price || t.status === 'closed'
  })

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-black text-white flex items-center gap-2">
            <Bot className="text-blue-400" size={24} />
            Auto-Trade
          </h1>
          <p className="text-gray-500 text-xs mt-0.5">
            {config?.enabled !== false ? 'Bot is trading' : 'Bot is paused'}
          </p>
        </div>
        <button
          onClick={() => fetchData(true)}
          disabled={loading}
          className="p-2.5 bg-gray-900 border border-gray-800 rounded-xl text-gray-400 hover:text-blue-400 hover:border-blue-500/50 transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-gray-900 rounded-2xl p-4 border border-gray-800 animate-pulse">
              <div className="h-8 w-24 bg-gray-800 rounded mb-2" />
              <div className="h-3 w-full bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 text-center mb-4">
          <AlertTriangle size={28} className="text-red-400 mx-auto mb-2" />
          <p className="text-red-400 text-sm font-semibold">{error}</p>
          <button
            onClick={() => fetchData(true)}
            className="mt-2 px-4 py-2 bg-red-500/20 text-red-400 rounded-xl text-xs font-semibold hover:bg-red-500/30 transition-all"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* P&L Summary */}
          <PnLSummary trades={closedTrades} />

          {/* Open Positions */}
          {positions.length > 0 && (
            <div className="mb-5">
              <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Target size={12} />
                Open Positions ({positions.length})
              </h2>
              <div className="space-y-2">
                {positions.map((pos) => (
                  <PositionCard
                    key={pos.symbol || pos.asset_id}
                    position={pos}
                    onClick={(sym) => navigate(`/stock/${sym}`)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Recent Trades */}
          {closedTrades.length > 0 && (
            <div>
              <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <BarChart3 size={12} />
                Recent Trades
              </h2>
              <div className="space-y-2">
                {closedTrades.slice(0, 20).map((trade, i) => (
                  <TradeCard key={trade.id || i} trade={trade} />
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {closedTrades.length === 0 && positions.length === 0 && (
            <div className="py-12 text-center">
              <DollarSign size={48} className="text-gray-700 mx-auto mb-4" />
              <p className="text-white text-sm font-semibold mb-1">No trades yet</p>
              <p className="text-gray-500 text-xs">
                The auto-trader will execute trades when gems hit the right entry points.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
