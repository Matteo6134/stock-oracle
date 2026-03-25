import { useState, useEffect, useCallback } from 'react'
import { Target, RefreshCw, Brain, TrendingUp, TrendingDown, Zap, ChevronRight } from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

const STRATEGY_LABELS = {
  edge_detection: 'Edge',
  arbitrage: 'Arb',
  cross_platform_arb: 'Cross-Arb',
  cross_platform_edge: 'Cross-Edge',
  longshot_sell: 'Longshot',
  safe_bet: 'Safe',
  conditional_chain: 'Chain',
  whale_follow: 'Whale',
  resolution_snipe: 'Snipe',
  momentum: 'Momentum',
}

const QUALITY_GATES = {
  safe_bet: { minConf: 6, minEdge: 2 },
  arbitrage: { minConf: 5, minEdge: 3 },
  cross_platform_arb: { minConf: 5, minEdge: 3 },
  cross_platform_edge: { minConf: 6, minEdge: 5 },
  conditional_chain: { minConf: 7, minEdge: 8 },
  whale_follow: { minConf: 6, minEdge: 2 },
  longshot_sell: { minConf: 7, minEdge: 10 },
  edge_detection: { minConf: 6, minEdge: 8 },
  resolution_snipe: { minConf: 7, minEdge: 5 },
  momentum: { minConf: 7, minEdge: 8 },
}

// ── Confidence Bar (matches GemsPage's GemScoreBar) ──
function ConfBar({ value, max = 10 }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100)
  const color =
    pct >= 80 ? 'bg-green-500' :
    pct >= 60 ? 'bg-yellow-500' :
    pct >= 40 ? 'bg-orange-500' :
    'bg-gray-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-bold text-gray-300 w-8 text-right">{value}/{max}</span>
    </div>
  )
}

// ── Pick Card (matches GemsPage GemCard style) ──
function PickCard({ pick }) {
  const isYes = pick.action === 'BET_YES'
  const edge = Math.abs(pick.edge || 0)
  const conf = pick.confidence || 0
  const question = (pick.question || '').replace(/^\[(ARB|CHAIN|WHALE)\]\s*/, '').slice(0, 100)
  const strategy = STRATEGY_LABELS[pick.strategy] || pick.strategy || 'Edge'

  const t = QUALITY_GATES[pick.strategy] || QUALITY_GATES.edge_detection
  const bought = conf >= t.minConf && edge >= t.minEdge

  const marketPrice = Math.round((pick.marketYesPrice || 0.5) * 100)
  const claudePrice = Math.round((pick.realProbability || 0.5) * 100)

  return (
    <div className={`bg-gray-900 rounded-2xl p-4 border border-gray-800 ${bought ? 'ring-1 ring-green-500/20' : ''}`}>
      {/* Top: question + status */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-white font-semibold text-sm leading-tight mb-1.5">{question}</div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isYes ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              {isYes ? 'YES' : 'NO'}
            </span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/15 text-purple-400">
              {strategy}
            </span>
            {bought
              ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/15 text-green-400">Invested</span>
              : <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-700/50 text-gray-400">Watching</span>
            }
          </div>
        </div>
      </div>

      {/* Edge + probabilities */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center gap-1">
          <Zap size={12} className="text-yellow-400" />
          <span className={`text-sm font-bold ${edge >= 15 ? 'text-green-400' : edge >= 8 ? 'text-yellow-400' : 'text-gray-400'}`}>
            +{edge}% edge
          </span>
        </div>
        <span className="text-gray-600">|</span>
        <span className="text-[10px] text-gray-500">Market: {marketPrice}c</span>
        <span className="text-[10px] text-gray-500">Claude: {claudePrice}%</span>
      </div>

      {/* Confidence bar */}
      <ConfBar value={conf} />

      {/* Thesis */}
      {pick.thesis && (
        <p className="text-[11px] text-gray-400 leading-relaxed mt-3 line-clamp-2">{pick.thesis}</p>
      )}
    </div>
  )
}

export default function PolyDashboard() {
  const [picks, setPicks] = useState([])
  const [loading, setLoading] = useState(true)
  const [lastScan, setLastScan] = useState(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`${API_BASE}/api/poly/brain`)
      if (res.ok) {
        const d = await res.json()
        setPicks(d.picks || [])
        setLastScan(d.lastScanTime || null)
      }
    } catch {} finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // Separate bought vs watching
  const boughtPicks = picks.filter(p => {
    const t = QUALITY_GATES[p.strategy] || QUALITY_GATES.edge_detection
    return (p.confidence || 0) >= t.minConf && Math.abs(p.edge || 0) >= t.minEdge
  })
  const watchingPicks = picks.filter(p => {
    const t = QUALITY_GATES[p.strategy] || QUALITY_GATES.edge_detection
    return !((p.confidence || 0) >= t.minConf && Math.abs(p.edge || 0) >= t.minEdge)
  })

  return (
    <div className="max-w-lg mx-auto px-4 pt-4 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Brain size={20} className="text-purple-400" />
            Claude's Picks
          </h1>
          <p className="text-gray-500 text-xs mt-0.5">
            {lastScan ? `Last scan: ${new Date(lastScan).toLocaleTimeString()}` : 'AI scans every 15 min'}
          </p>
        </div>
        <button onClick={fetchData} disabled={loading} className="p-2.5 bg-gray-900 border border-gray-800 rounded-2xl text-gray-500 hover:text-purple-400 transition-all active:scale-95 disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Invested picks */}
      {boughtPicks.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={14} className="text-green-400" />
            <span className="text-sm font-bold text-white uppercase tracking-wider">Invested ({boughtPicks.length})</span>
          </div>
          <div className="space-y-3">
            {boughtPicks.map((pick, i) => (
              <PickCard key={pick.marketId || i} pick={pick} />
            ))}
          </div>
        </div>
      )}

      {/* Watching picks */}
      {watchingPicks.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Target size={14} className="text-gray-400" />
            <span className="text-sm font-bold text-white uppercase tracking-wider">Watching ({watchingPicks.length})</span>
          </div>
          <div className="space-y-3">
            {watchingPicks.slice(0, 10).map((pick, i) => (
              <PickCard key={pick.marketId || i} pick={pick} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {picks.length === 0 && !loading && (
        <div className="bg-gray-900 rounded-2xl p-8 border border-gray-800 text-center">
          <Brain size={32} className="text-gray-700 mx-auto mb-2" />
          <p className="text-gray-500 text-sm">No picks yet</p>
          <p className="text-gray-600 text-xs mt-1">Claude scans Polymarket every 15 min for mispriced events</p>
        </div>
      )}
    </div>
  )
}
