import { useState, useEffect, useCallback } from 'react'
import { DollarSign, RefreshCw, TrendingUp, TrendingDown, Trophy, Target } from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

function GoalTracker({ portfolio }) {
  const pct = portfolio.goalPct || 0
  const barWidth = Math.min(100, pct)

  return (
    <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Goal: $1,400 to $400K</div>
        <div className="text-purple-400 text-xs font-bold">{pct.toFixed(2)}%</div>
      </div>
      <div className="h-3 bg-gray-800 rounded-full overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-purple-600 to-purple-400 transition-all"
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>$1,400</span>
        <span className="text-white font-bold">${portfolio.totalValue?.toLocaleString()}</span>
        <span>$400,000</span>
      </div>
    </div>
  )
}

function PositionCard({ pos }) {
  const unrealPnl = (pos.currentPrice - pos.entryPrice) * pos.shares
  const isUp = unrealPnl >= 0
  const pctChange = pos.entryPrice > 0 ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100) : 0

  return (
    <div className={`bg-gray-900 rounded-2xl p-4 border border-gray-800 border-l-4 ${isUp ? 'border-l-green-500' : 'border-l-red-500'}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-white text-sm font-semibold leading-tight">{pos.question}</div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${pos.outcome === 'Yes' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              {pos.outcome}
            </span>
            <span className="text-gray-500 text-[10px]">{Math.round(pos.entryPrice * 100)}c entry</span>
            <span className="text-gray-500 text-[10px]">{pos.shares} shares</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-lg font-black ${isUp ? 'text-green-400' : 'text-red-400'}`}>
            {isUp ? '+' : ''}${unrealPnl.toFixed(2)}
          </div>
          <div className={`text-[10px] font-bold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
            {isUp ? '+' : ''}{pctChange.toFixed(1)}%
          </div>
        </div>
      </div>
      {pos.claudeThesis && (
        <div className="text-[10px] text-gray-500 mt-1 leading-tight">
          {pos.claudeThesis.slice(0, 150)}
        </div>
      )}
    </div>
  )
}

function ClosedTradeCard({ trade }) {
  const won = trade.status === 'won'
  return (
    <div className={`bg-gray-900 rounded-2xl p-3 border border-gray-800 border-l-4 ${won ? 'border-l-green-500' : 'border-l-red-500'}`}>
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-gray-300 text-xs font-medium leading-tight truncate">{trade.question}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-bold ${won ? 'text-green-400' : 'text-red-400'}`}>
              {won ? 'WON' : 'LOST'}
            </span>
            <span className="text-gray-600 text-[10px]">${trade.amount}</span>
          </div>
        </div>
        <div className={`text-sm font-black ${won ? 'text-green-400' : 'text-red-400'}`}>
          {won ? '+' : ''}{trade.pnl?.toFixed(2) || '0'}
        </div>
      </div>
    </div>
  )
}

export default function PolyPortfolio() {
  const [portfolio, setPortfolio] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`${API_BASE}/api/poly/portfolio`)
      if (res.ok) setPortfolio(await res.json())
    } catch {} finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const p = portfolio || { totalValue: 1400, pnl: 0, pnlPct: 0, goalPct: 0.35, winRate: 0, tradeCount: 0, openPositions: [], closedPositions: [] }

  return (
    <div className="max-w-lg mx-auto px-4 pt-4 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <DollarSign size={20} className="text-purple-400" />
            Portfolio
          </h1>
          <p className="text-gray-500 text-xs mt-0.5">Simulated $1,400 starting capital</p>
        </div>
        <button onClick={fetchData} disabled={loading} className="p-2.5 bg-gray-900 border border-gray-800 rounded-2xl text-gray-500 hover:text-purple-400 transition-all active:scale-95 disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Goal Tracker */}
      <GoalTracker portfolio={p} />

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-2 mb-6">
        <div className="bg-gray-900 rounded-2xl p-3 border border-gray-800 text-center">
          <div className="text-purple-400 font-black text-lg">${p.totalValue?.toLocaleString()}</div>
          <div className="text-[9px] text-gray-500 uppercase font-bold">Value</div>
        </div>
        <div className="bg-gray-900 rounded-2xl p-3 border border-gray-800 text-center">
          <div className={`font-black text-lg ${p.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {p.pnl >= 0 ? '+' : ''}{p.pnlPct}%
          </div>
          <div className="text-[9px] text-gray-500 uppercase font-bold">P&L</div>
        </div>
        <div className="bg-gray-900 rounded-2xl p-3 border border-gray-800 text-center">
          <div className="text-white font-black text-lg">{p.tradeCount}</div>
          <div className="text-[9px] text-gray-500 uppercase font-bold">Trades</div>
        </div>
        <div className="bg-gray-900 rounded-2xl p-3 border border-gray-800 text-center">
          <div className="text-white font-black text-lg">{p.winRate}%</div>
          <div className="text-[9px] text-gray-500 uppercase font-bold">Win Rate</div>
        </div>
      </div>

      {/* Open Positions */}
      {p.openPositions?.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Target size={14} className="text-purple-400" />
            <span className="text-sm font-bold text-white uppercase tracking-wider">Open ({p.openPositions.length})</span>
          </div>
          <div className="space-y-2">
            {p.openPositions.map(pos => (
              <PositionCard key={pos.id} pos={pos} />
            ))}
          </div>
        </div>
      )}

      {p.openPositions?.length === 0 && !loading && (
        <div className="bg-gray-900 rounded-2xl p-8 border border-gray-800 text-center mb-6">
          <Target size={32} className="text-gray-700 mx-auto mb-2" />
          <p className="text-gray-500 text-sm">No open positions</p>
          <p className="text-gray-600 text-xs mt-1">Claude auto-bets every 15 min when edge is found</p>
        </div>
      )}

      {/* Closed Trades */}
      {p.closedPositions?.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Trophy size={14} className="text-yellow-400" />
            <span className="text-sm font-bold text-white uppercase tracking-wider">History ({p.closedPositions.length})</span>
          </div>
          <div className="space-y-2">
            {p.closedPositions.slice(0, 20).map(trade => (
              <ClosedTradeCard key={trade.id} trade={trade} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
