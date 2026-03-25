import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Diamond, RefreshCw, TrendingUp, TrendingDown, Zap,
  Flame, Clock, AlertTriangle, ChevronRight, BarChart3
} from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

// ── Signal display labels ──
const SIGNAL_LABELS = {
  unusual_volume: 'Unusual Vol',
  multi_day_accumulation: 'Accumulation',
  smart_money: 'Smart Money',
  early_momentum: 'Early Momo',
  momentum_acceleration: 'Momo Accel',
  short_squeeze_loading: 'Squeeze',
  bb_squeeze: 'BB Squeeze',
  volume_contraction: 'Vol Dry-Up',
  near_52w_high: '52W High',
  earnings_tomorrow: 'Earnings',
  low_float_volume: 'Low Float',
  sector_lag: 'Sector Lag',
  oversold_bounce: 'Oversold',
  bull_flag: 'Bull Flag',
  golden_cross: 'Golden Cross',
  price_compression: 'Coiling',
  insider_buying: 'Insider Buy',
  bullish_options: 'Bull Options',
  unusual_options_volume: 'Options Surge',
  institutions_accumulating: 'Institutions',
}

// ── Urgency config ──
const URGENCY_CONFIG = {
  IMMINENT: {
    label: 'IMMINENT',
    bg: 'bg-red-500/20',
    text: 'text-red-400',
    border: 'border-red-500/40',
    ring: 'ring-red-500/30',
    pulse: true,
    dot: 'bg-red-500',
  },
  SOON: {
    label: 'SOON',
    bg: 'bg-orange-500/20',
    text: 'text-orange-400',
    border: 'border-orange-500/40',
    ring: 'ring-orange-500/20',
    pulse: false,
    dot: 'bg-orange-500',
  },
  BUILDING: {
    label: 'BUILDING',
    bg: 'bg-gray-500/15',
    text: 'text-gray-400',
    border: 'border-gray-500/30',
    ring: 'ring-gray-500/10',
    pulse: false,
    dot: 'bg-gray-500',
  },
}

// ── Gem Score Bar ──
function GemScoreBar({ score }) {
  const pct = Math.min(Math.max(score || 0, 0), 100)
  const color =
    pct >= 70 ? 'bg-green-500' :
    pct >= 50 ? 'bg-yellow-500' :
    pct >= 30 ? 'bg-orange-500' :
    'bg-gray-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-bold text-gray-300 w-8 text-right">{Math.round(pct)}</span>
    </div>
  )
}

// ── Urgency Badge ──
function UrgencyBadge({ urgency }) {
  const config = URGENCY_CONFIG[urgency] || URGENCY_CONFIG.BUILDING
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black tracking-wider border ${config.bg} ${config.text} ${config.border} ${config.pulse ? 'animate-pulse' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? 'animate-ping' : ''}`} />
      {config.label}
    </span>
  )
}

// ── Signal Pill ──
function SignalPill({ signal }) {
  const label = SIGNAL_LABELS[signal] || signal.replace(/_/g, ' ')
  return (
    <span className="inline-flex px-2 py-0.5 rounded-full text-[9px] font-semibold bg-white/5 text-gray-400 border border-gray-700/50">
      {label}
    </span>
  )
}

// ── Explosion Prediction ──
function ExplosionLine({ gem }) {
  const pred = gem.explosionPrediction || gem.prediction || {}
  const targetPrice = pred.targetPrice || pred.target
  const probability = pred.probability || pred.confidence || 0
  const timeframe = pred.timeframe || pred.horizon || ''
  const pctGain = pred.percentGain || pred.expectedGain || pred.pctGain || 0

  if (!targetPrice && !pctGain) return null

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <Zap size={14} className="text-yellow-400" />
      <span className="text-green-400 font-bold">
        +{typeof pctGain === 'number' ? pctGain.toFixed(0) : pctGain}%
      </span>
      {timeframe && <span className="text-gray-500">in {timeframe}</span>}
      {probability > 0 && (
        <span className="text-gray-500">
          · <span className="text-yellow-400 font-semibold">{Math.round(probability)}%</span> prob
        </span>
      )}
      {targetPrice && (
        <span className="text-gray-500">
          → <span className="text-green-400 font-semibold">${typeof targetPrice === 'number' ? targetPrice.toFixed(2) : targetPrice}</span>
        </span>
      )}
    </div>
  )
}

// ── Gem Card ──
function GemCard({ gem, onClick }) {
  const price = gem.price || gem.currentPrice || 0
  const change = gem.changePct || gem.changePercent || 0
  const isUp = change >= 0
  const score = gem.gemScore || gem.score || gem.setupScore || 0
  const urgency = deriveUrgency(gem)
  const signals = gem.signals || gem.catalysts || []
  const consensus = gem.agentConsensus || gem.consensus || ''
  const urgencyConfig = URGENCY_CONFIG[urgency] || URGENCY_CONFIG.BUILDING

  return (
    <div
      className={`bg-gray-900 rounded-2xl p-4 border border-gray-800 cursor-pointer hover:bg-gray-900/80 hover:border-gray-700 transition-all active:scale-[0.99] ${urgencyConfig.ring ? `ring-1 ${urgencyConfig.ring}` : ''}`}
      onClick={() => onClick(gem.symbol)}
    >
      {/* Top row: symbol + price + urgency */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-black text-lg tracking-tight">{gem.symbol}</span>
            <UrgencyBadge urgency={urgency} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-white font-bold text-2xl">${price.toFixed(2)}</span>
            <span className={`text-sm font-bold flex items-center gap-0.5 ${isUp ? 'text-green-400' : 'text-red-400'}`}>
              {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {isUp ? '+' : ''}{change.toFixed(2)}%
            </span>
          </div>
        </div>
        <ChevronRight size={18} className="text-gray-600 mt-2" />
      </div>

      {/* Explosion prediction */}
      <div className="mb-3">
        <ExplosionLine gem={gem} />
      </div>

      {/* Signals */}
      {signals.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {signals.slice(0, 4).map((s, i) => (
            <SignalPill key={i} signal={typeof s === 'string' ? s : s.name || s.signal || ''} />
          ))}
          {signals.length > 4 && (
            <span className="text-[9px] text-gray-500 self-center">+{signals.length - 4} more</span>
          )}
        </div>
      )}

      {/* Agent consensus */}
      {consensus && (
        <p className="text-[11px] text-gray-400 leading-relaxed mb-3 line-clamp-2">{consensus}</p>
      )}

      {/* Gem Score Bar */}
      <GemScoreBar score={score} />
    </div>
  )
}

// ── Derive urgency from gem data ──
function deriveUrgency(gem) {
  if (gem.urgency) return gem.urgency.toUpperCase()
  if (gem.timing === 'buy_today' || gem.timing === 'buy_today_or_tomorrow') return 'IMMINENT'
  const score = gem.gemScore || gem.score || gem.setupScore || 0
  if (score >= 70) return 'IMMINENT'
  if (score >= 45) return 'SOON'
  return 'BUILDING'
}

// ── Main Page ──
export default function GemsPage() {
  const navigate = useNavigate()
  const [gems, setGems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const refreshTimer = useRef(null)

  const fetchGems = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/tomorrow`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // API may return { gems: [...] } or { predictions: [...] } or array directly
      const raw = data.gems || data.predictions || data.stocks || (Array.isArray(data) ? data : [])
      // Sort by gem score descending
      const sorted = [...raw].sort((a, b) => {
        const scoreA = a.gemScore || a.score || a.setupScore || 0
        const scoreB = b.gemScore || b.score || b.setupScore || 0
        return scoreB - scoreA
      })
      setGems(sorted)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + auto-refresh every 60s
  useEffect(() => {
    fetchGems(true)
    refreshTimer.current = setInterval(() => fetchGems(false), 60_000)
    return () => clearInterval(refreshTimer.current)
  }, [fetchGems])

  const handleGemClick = (symbol) => {
    navigate(`/stock/${symbol}`)
  }

  // Stats
  const imminentCount = gems.filter(g => deriveUrgency(g) === 'IMMINENT').length
  const totalGems = gems.length

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-black text-white flex items-center gap-2">
            <Diamond className="text-purple-400" size={24} />
            Explosion Gems
          </h1>
          <p className="text-gray-500 text-xs mt-0.5">
            AI-detected stocks about to explode
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-gray-600 text-[9px] flex items-center gap-1">
              <Clock size={8} />
              {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => fetchGems(true)}
            disabled={loading}
            className="p-2.5 bg-gray-900 border border-gray-800 rounded-xl text-gray-400 hover:text-purple-400 hover:border-purple-500/50 transition-all active:scale-95 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Stats strip */}
      {!loading && gems.length > 0 && (
        <div className="flex gap-3 mb-4">
          <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <p className="text-3xl font-black text-white">{totalGems}</p>
            <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Gems Found</p>
          </div>
          <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <p className="text-3xl font-black text-red-400">{imminentCount}</p>
            <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Imminent</p>
          </div>
          <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <p className="text-3xl font-black text-green-400">
              {gems[0] ? Math.round(gems[0].gemScore || gems[0].score || gems[0].setupScore || 0) : 0}
            </p>
            <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Top Score</p>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-gray-900 rounded-2xl p-4 border border-gray-800 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="h-5 w-14 bg-gray-800 rounded" />
                <div className="h-4 w-20 bg-gray-800 rounded-full" />
              </div>
              <div className="h-8 w-24 bg-gray-800 rounded mb-3" />
              <div className="h-3 w-full bg-gray-800 rounded mb-2" />
              <div className="h-2 w-full bg-gray-800 rounded-full" />
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 text-center">
          <AlertTriangle size={28} className="text-red-400 mx-auto mb-2" />
          <p className="text-red-400 text-sm font-semibold mb-1">Failed to load gems</p>
          <p className="text-gray-500 text-xs mb-3">{error}</p>
          <button
            onClick={() => fetchGems(true)}
            className="px-4 py-2 bg-red-500/20 text-red-400 rounded-xl text-xs font-semibold hover:bg-red-500/30 transition-all"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && gems.length === 0 && (
        <div className="py-16 text-center">
          <Diamond size={48} className="text-gray-700 mx-auto mb-4" />
          <p className="text-white text-sm font-semibold mb-1">No gems detected</p>
          <p className="text-gray-500 text-xs max-w-xs mx-auto">
            The scanner hasn't found any explosion candidates right now. Check back soon — markets are always moving.
          </p>
        </div>
      )}

      {/* Gem Cards */}
      {!loading && !error && gems.length > 0 && (
        <div className="space-y-3">
          {gems.map((gem) => (
            <GemCard
              key={gem.symbol}
              gem={gem}
              onClick={handleGemClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}
