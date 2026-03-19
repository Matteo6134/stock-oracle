import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap, TrendingUp, Activity, Target, RefreshCw,
  ArrowUpRight, ArrowDownRight, Clock, AlertTriangle, Flame
} from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

const TABS = [
  { id: 'premarket', label: 'Pre-Market', icon: Zap },
  { id: 'squeeze', label: 'Squeeze', icon: Flame },
  { id: 'breakouts', label: 'Breakouts', icon: Activity },
  { id: 'strength', label: 'Rel Strength', icon: Target },
]

const SIGNAL_COLORS = {
  'Gap Up Momentum': 'bg-oracle-green/15 text-oracle-green border-oracle-green/30',
  'Explosive Gap': 'bg-orange-500/15 text-orange-400 border-orange-400/30',
  'Volume Spike': 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/30',
  'Low Float Runner': 'bg-purple-500/15 text-purple-400 border-purple-400/30',
  'Bounce Play': 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30',
}

function SkeletonCards({ count = 6 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                <div className="skeleton-shimmer h-5 w-14 rounded" />
                <div className="skeleton-shimmer h-4 w-28 rounded" />
              </div>
              <div className="flex items-center gap-2 mb-2">
                <div className="skeleton-shimmer h-5 w-16 rounded-full" />
                <div className="skeleton-shimmer h-4 w-20 rounded" />
              </div>
              <div className="skeleton-shimmer h-1.5 w-full rounded-full" />
            </div>
            <div className="flex flex-col items-end gap-2 ml-4">
              <div className="skeleton-shimmer h-8 w-16 rounded" />
              <div className="skeleton-shimmer h-4 w-12 rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ icon: Icon, title, subtitle }) {
  return (
    <div className="py-12 text-center">
      <Icon size={40} className="text-oracle-muted/40 mx-auto mb-3" />
      <p className="text-oracle-muted text-sm font-medium">{title}</p>
      <p className="text-oracle-muted/60 text-xs mt-1">{subtitle}</p>
    </div>
  )
}

function SignalBadge({ signal }) {
  const colors = SIGNAL_COLORS[signal] || 'bg-white/5 text-oracle-muted border-oracle-border'
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${colors}`}>
      {signal}
    </span>
  )
}

const SIGNAL_LABELS = {
  'gap_up_explosive': 'Explosive Gap',
  'gap_up_momentum': 'Gap Up Momentum',
  'gap_down_bounce': 'Bounce Play',
  'volume_spike': 'Volume Spike',
  'low_float_runner': 'Low Float Runner',
}

function PreMarketCard({ stock }) {
  const navigate = useNavigate()
  const { symbol, companyName, currentPrice, preMarketPrice, signals = [] } = stock
  const gapPct = stock.gapPct ?? 0
  const volumeRatio = stock.volumeRatio ?? 0
  const isUp = gapPct >= 0
  const allSignals = signals.map(s => SIGNAL_LABELS[s] || s)

  return (
    <div
      onClick={() => navigate(`/stock/${symbol}`)}
      className="glass-card p-3.5 cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-oracle-text font-bold text-sm">{symbol}</span>
            {companyName && companyName !== symbol && (
              <span className="text-oracle-muted text-xs truncate">{companyName}</span>
            )}
          </div>
          <div className="flex items-center gap-3 mb-2">
            {currentPrice != null && (
              <span className="text-oracle-muted text-xs">${Number(currentPrice).toFixed(2)}</span>
            )}
            {preMarketPrice != null && (
              <span className="text-oracle-accent text-xs">
                PM: ${Number(preMarketPrice).toFixed(2)}
              </span>
            )}
          </div>
          {allSignals.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {allSignals.map((s, i) => (
                <SignalBadge key={i} signal={s} />
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end shrink-0">
          <div className={`flex items-center gap-0.5 text-lg font-bold ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {isUp ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}
            {Math.abs(gapPct).toFixed(1)}%
          </div>
          {volumeRatio > 0 && (
            <div className="flex items-center gap-1 mt-1">
              <Activity size={10} className="text-oracle-accent" />
              <span className="text-oracle-muted text-[10px]">{volumeRatio.toFixed(1)}x vol</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const SQUEEZE_TYPE_STYLES = {
  moass: { label: 'MOASS', color: 'text-oracle-red', bg: 'bg-oracle-red/15', border: 'border-oracle-red/30', icon: '💥' },
  short_squeeze: { label: 'Short Squeeze', color: 'text-orange-400', bg: 'bg-orange-400/15', border: 'border-orange-400/30', icon: '🔥' },
  gamma_squeeze: { label: 'Gamma Squeeze', color: 'text-oracle-purple', bg: 'bg-oracle-purple/15', border: 'border-oracle-purple/30', icon: '⚡' },
  squeeze_watch: { label: 'Squeeze Watch', color: 'text-oracle-yellow', bg: 'bg-oracle-yellow/15', border: 'border-oracle-yellow/30', icon: '👀' },
}

function SqueezeCard({ stock }) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const {
    symbol,
    shortPercentOfFloat,
    shortRatio,
    floatShares,
    squeezePotential,
  } = stock
  const siFloat = shortPercentOfFloat ?? 0
  const siRatio = shortRatio ?? 0
  const siShares = floatShares ?? 0
  const siPotential = squeezePotential ?? 0
  const squeezeScore = Math.min(100, siPotential / 5)
  const scoreWidth = Math.min(squeezeScore, 100)
  const scoreColor = squeezeScore >= 80
    ? 'bg-oracle-red'
    : squeezeScore >= 60
      ? 'bg-orange-500'
      : squeezeScore >= 40
        ? 'bg-oracle-yellow'
        : 'bg-oracle-accent'

  const sqType = stock.squeezeType || 'squeeze_watch'
  const style = SQUEEZE_TYPE_STYLES[sqType] || SQUEEZE_TYPE_STYLES.squeeze_watch
  const targets = stock.targets
  const probability = stock.probability ?? 0
  const currentPrice = stock.price ?? 0

  return (
    <div className="glass-card p-3.5 cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]">
      <div onClick={() => navigate(`/stock/${symbol}`)}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-oracle-text font-bold text-sm">{symbol}</span>
              <span className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold ${style.bg} ${style.color} border ${style.border}`}>
                {style.icon} {style.label}
              </span>
            </div>
            {currentPrice > 0 && <span className="text-oracle-muted text-[10px]">${currentPrice}</span>}
          </div>
          <div className="text-right shrink-0">
            <div className="text-oracle-text font-bold text-sm">{siFloat.toFixed(1)}%</div>
            <div className="text-oracle-muted text-[10px]">short of float</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-2.5 text-xs">
          <div className="glass-inner rounded-lg p-2">
            <div className="text-oracle-muted text-[10px] mb-0.5">Days to Cover</div>
            <div className="text-oracle-text font-semibold">{siRatio.toFixed(1)}d</div>
          </div>
          <div className="glass-inner rounded-lg p-2">
            <div className="text-oracle-muted text-[10px] mb-0.5">Float</div>
            <div className="text-oracle-text font-semibold">
              {siShares >= 1e9 ? `${(siShares / 1e9).toFixed(1)}B`
                : siShares >= 1e6 ? `${(siShares / 1e6).toFixed(1)}M`
                : siShares >= 1e3 ? `${(siShares / 1e3).toFixed(0)}K`
                : siShares > 0 ? siShares.toLocaleString() : 'N/A'}
            </div>
          </div>
          <div className="glass-inner rounded-lg p-2">
            <div className="text-oracle-muted text-[10px] mb-0.5">Probability</div>
            <div className={`font-semibold ${probability >= 30 ? 'text-oracle-green' : 'text-oracle-yellow'}`}>{probability}%</div>
          </div>
        </div>

        {/* Price targets */}
        {targets && currentPrice > 0 && (
          <div className="mb-2.5">
            <div className="text-oracle-muted text-[10px] mb-1 font-medium">Squeeze Price Targets</div>
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              <div className="glass-inner rounded-lg p-1.5 text-center">
                <div className="text-oracle-yellow text-[9px]">Conservative</div>
                <div className="text-oracle-text font-bold">${targets.conservative}</div>
                <div className="text-oracle-green text-[9px]">+{targets.conservativeGain}%</div>
              </div>
              <div className="glass-inner rounded-lg p-1.5 text-center border border-oracle-accent/20">
                <div className="text-oracle-accent text-[9px]">Moderate</div>
                <div className="text-oracle-text font-bold">${targets.moderate}</div>
                <div className="text-oracle-green text-[9px]">+{targets.moderateGain}%</div>
              </div>
              <div className="glass-inner rounded-lg p-1.5 text-center">
                <div className="text-oracle-red text-[9px]">Extreme</div>
                <div className="text-oracle-text font-bold">${targets.extreme}</div>
                <div className="text-oracle-green text-[9px]">+{targets.extremeGain}%</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Squeeze score bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-oracle-muted text-[10px] font-medium">Squeeze Score</span>
          <span className="text-oracle-text text-xs font-bold">{squeezeScore.toFixed(0)}/100</span>
        </div>
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${scoreColor}`} style={{ width: `${scoreWidth}%` }} />
        </div>
      </div>

      {/* Expand for explanation */}
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
        className="w-full mt-2 py-2 px-3 glass-inner rounded-lg flex items-center justify-center gap-1.5 text-oracle-accent text-xs font-semibold hover:bg-white/[0.05] transition-all active:scale-[0.98]"
      >
        <AlertTriangle size={12} />
        {expanded ? 'Hide explanation' : 'Why is this a squeeze?'}
      </button>

      {expanded && stock.explanation && (
        <div className="mt-2 p-3 glass-inner rounded-lg border border-oracle-accent/20">
          <p className="text-xs text-oracle-muted leading-relaxed">{stock.explanation}</p>
        </div>
      )}
    </div>
  )
}

function BreakoutCard({ stock }) {
  const navigate = useNavigate()
  const { symbol } = stock
  const bbWidth = stock.bbWidth ?? 0
  const volumeContraction = stock.volumeContraction ?? 0
  const rangeContraction = stock.rangeContraction ?? 0
  const lastClose = stock.lastClose ?? 0
  const squeezeStrength = stock.squeezeStrength ?? 0
  const coilLevel = Math.min(100, Math.max(0, (1 - bbWidth / 0.15) * 100))
  const coilColor = coilLevel >= 75
    ? 'text-oracle-green'
    : coilLevel >= 50
      ? 'text-oracle-yellow'
      : 'text-oracle-muted'

  return (
    <div
      onClick={() => navigate(`/stock/${symbol}`)}
      className="glass-card p-3.5 cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]"
    >
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-oracle-text font-bold text-sm">{symbol}</span>
            {lastClose > 0 && (
              <span className="text-oracle-muted text-[10px]">${lastClose.toFixed(2)}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-center shrink-0">
          <div className={`font-bold text-sm ${coilColor}`}>
            <Activity size={20} className="mx-auto mb-0.5" />
          </div>
          <span className={`text-[10px] font-semibold ${coilColor}`}>
            {coilLevel >= 75 ? 'Tight' : coilLevel >= 50 ? 'Coiling' : 'Loose'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="glass-inner rounded-lg p-2 text-center">
          <div className="text-oracle-muted text-[10px] mb-0.5">BB Width</div>
          <div className="text-oracle-text font-semibold">{(bbWidth * 100).toFixed(1)}%</div>
        </div>
        <div className="glass-inner rounded-lg p-2 text-center">
          <div className="text-oracle-muted text-[10px] mb-0.5">Vol Ratio</div>
          <div className="text-oracle-text font-semibold">{(volumeContraction * 100).toFixed(0)}%</div>
        </div>
        <div className="glass-inner rounded-lg p-2 text-center">
          <div className="text-oracle-muted text-[10px] mb-0.5">Range</div>
          <div className="text-oracle-text font-semibold">{(rangeContraction * 100).toFixed(0)}%</div>
        </div>
      </div>

      <div className="mt-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-oracle-muted text-[10px] font-medium">Coiled Spring</span>
          <span className={`text-xs font-bold ${coilColor}`}>{coilLevel.toFixed(0)}%</span>
        </div>
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${coilLevel >= 75 ? 'bg-oracle-green' : coilLevel >= 50 ? 'bg-oracle-yellow' : 'bg-oracle-muted'}`}
            style={{ width: `${coilLevel}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function RelativeStrengthCard({ stock }) {
  const navigate = useNavigate()
  const { symbol, companyName } = stock
  const gapPct = stock.gapPct ?? 0
  const relativeStrengthScore = stock.relativeStrengthScore ?? 0
  // RS score is typically 0-20 range, normalize to 0-100
  const rsNormalized = Math.min(100, relativeStrengthScore * 5)
  const rsColor = rsNormalized >= 70
    ? 'text-oracle-green'
    : rsNormalized >= 40
      ? 'text-oracle-yellow'
      : 'text-oracle-red'
  const stockChange = gapPct
  const spyChange = gapPct - relativeStrengthScore // derive SPY from the difference
  const maxBar = Math.max(Math.abs(stockChange), Math.abs(spyChange), 0.01)

  return (
    <div
      onClick={() => navigate(`/stock/${symbol}`)}
      className="glass-card p-3.5 cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]"
    >
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-oracle-text font-bold text-sm">{symbol}</span>
            <span className={`text-xs font-bold ${rsColor}`}>RS {rsNormalized.toFixed(0)}</span>
          </div>
          {companyName && companyName !== symbol && <p className="text-oracle-muted text-xs truncate mt-0.5">{companyName}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {stockChange >= spyChange ? (
            <ArrowUpRight size={16} className="text-oracle-green" />
          ) : (
            <ArrowDownRight size={16} className="text-oracle-red" />
          )}
          <span className={`text-sm font-bold ${stockChange >= spyChange ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {stockChange >= 0 ? '+' : ''}{stockChange.toFixed(2)}%
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-oracle-muted text-[10px]">{symbol}</span>
            <span className={`text-[10px] font-semibold ${stockChange >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {stockChange >= 0 ? '+' : ''}{stockChange.toFixed(2)}%
            </span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden flex">
            {stockChange >= 0 ? (
              <div
                className="h-full rounded-full bg-oracle-green transition-all duration-500"
                style={{ width: `${(stockChange / maxBar) * 50 + 50}%` }}
              />
            ) : (
              <>
                <div style={{ width: `${50 + (stockChange / maxBar) * 50}%` }} />
                <div
                  className="h-full rounded-full bg-oracle-red transition-all duration-500"
                  style={{ width: `${Math.abs(stockChange / maxBar) * 50}%` }}
                />
              </>
            )}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-oracle-muted text-[10px]">SPY</span>
            <span className={`text-[10px] font-semibold ${spyChange >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {spyChange >= 0 ? '+' : ''}{spyChange.toFixed(2)}%
            </span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden flex">
            {spyChange >= 0 ? (
              <div
                className="h-full rounded-full bg-oracle-accent/60 transition-all duration-500"
                style={{ width: `${(spyChange / maxBar) * 50 + 50}%` }}
              />
            ) : (
              <>
                <div style={{ width: `${50 + (spyChange / maxBar) * 50}%` }} />
                <div
                  className="h-full rounded-full bg-oracle-red/60 transition-all duration-500"
                  style={{ width: `${Math.abs(spyChange / maxBar) * 50}%` }}
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-oracle-muted text-[10px]">Relative Strength Score</span>
        <span className={`text-xs font-bold ${rsColor}`}>{rsNormalized.toFixed(0)}/100</span>
      </div>
    </div>
  )
}

function StatsPill({ value, label, color = 'text-oracle-accent' }) {
  return (
    <div className="glass-inner rounded-lg px-2.5 py-1.5 text-center">
      <div className={`text-sm font-bold ${color}`}>{value}</div>
      <div className="text-oracle-muted text-[9px]">{label}</div>
    </div>
  )
}

const REGIME_STYLES = {
  bull: { label: 'Bull', color: 'text-oracle-green', bg: 'bg-oracle-green/10 border-oracle-green/30' },
  cautious_bull: { label: 'Cautious Bull', color: 'text-oracle-yellow', bg: 'bg-oracle-yellow/10 border-oracle-yellow/30' },
  neutral: { label: 'Neutral', color: 'text-oracle-muted', bg: 'bg-white/5 border-oracle-border' },
  cautious_bear: { label: 'Cautious Bear', color: 'text-oracle-yellow', bg: 'bg-oracle-yellow/10 border-oracle-yellow/30' },
  bear: { label: 'Bear', color: 'text-oracle-red', bg: 'bg-oracle-red/10 border-oracle-red/30' },
  fear: { label: 'Fear', color: 'text-oracle-red', bg: 'bg-oracle-red/20 border-oracle-red/50' },
}

export default function MoversPage() {
  const [activeTab, setActiveTab] = useState('premarket')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastScan, setLastScan] = useState(null)
  const touchStartY = useRef(0)
  const [pulling, setPulling] = useState(false)
  const containerRef = useRef(null)

  const fetchMovers = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/api/movers`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const json = await res.json()
      setData(json)
      setLastScan(new Date())
    } catch (err) {
      setError(err.message || 'Failed to fetch movers')
    } finally {
      setLoading(false)
      setPulling(false)
    }
  }, [])

  useEffect(() => {
    fetchMovers()
    const interval = setInterval(() => fetchMovers(false), 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchMovers])

  const handleTouchStart = useCallback((e) => {
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY
    }
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      const diff = e.touches[0].clientY - touchStartY.current
      if (diff > 60) setPulling(true)
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (pulling) {
      fetchMovers(true)
    }
  }, [pulling, fetchMovers])

  const premarket = data?.premarketMovers || []
  const squeeze = data?.squeezeCandidates || []
  const breakouts = data?.breakoutSetups || []
  const strength = data?.relativeStrength || []
  const regime = data?.marketRegime || null
  const stats = data?.stats || {}

  const gapsUp = stats.gapUps || premarket.filter(s => (s.gapPct || 0) > 0).length
  const volumeSpikes = stats.volumeSpikes || premarket.filter(s => (s.volumeRatio || 0) > 2).length
  const squeezeCount = stats.squeezeSetups || squeeze.length

  const regimeStyle = regime
    ? (REGIME_STYLES[regime.regime || regime.level || regime] || REGIME_STYLES.neutral)
    : null

  return (
    <div
      ref={containerRef}
      className="max-w-lg mx-auto px-4 pt-1 pb-6"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull to refresh indicator */}
      {pulling && (
        <div className="flex items-center justify-center py-3 text-oracle-accent">
          <RefreshCw size={16} className="animate-spin mr-2" />
          <span className="text-xs font-medium">Release to refresh</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Zap className="text-oracle-accent" size={22} />
            Movers Scanner
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            {lastScan && (
              <span className="text-oracle-muted text-[10px] flex items-center gap-1">
                <Clock size={9} />
                {lastScan.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {regimeStyle && (
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${regimeStyle.bg} ${regimeStyle.color}`}>
                {regimeStyle.label}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => fetchMovers(true)}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Stats summary */}
      {!loading && data && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <StatsPill value={gapsUp} label="Gaps Up" color="text-oracle-green" />
          <StatsPill value={volumeSpikes} label="Vol Spikes" color="text-oracle-accent" />
          <StatsPill value={squeezeCount} label="Squeeze" color="text-orange-400" />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto scrollbar-hide -mx-1 px-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-200 border ${
              activeTab === id
                ? 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/40'
                : 'bg-white/[0.02] text-oracle-muted border-transparent hover:bg-white/[0.05] hover:text-oracle-text'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="p-4 glass-card border-l-4 border-l-oracle-red mb-4">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Failed to load movers</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button
            onClick={() => fetchMovers(true)}
            className="px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && <SkeletonCards count={6} />}

      {/* Pre-Market Movers */}
      {!loading && activeTab === 'premarket' && (
        <div className="space-y-2 tab-content" key="premarket">
          {premarket.length > 0 ? (
            premarket.map((stock, i) => (
              <div key={stock.symbol || i} className="card-animate"><PreMarketCard stock={stock} /></div>
            ))
          ) : (
            <EmptyState
              icon={Zap}
              title="No pre-market movers"
              subtitle="Check back when pre-market opens (4 AM ET / 10 AM CET)"
            />
          )}
        </div>
      )}

      {/* Squeeze Setups */}
      {!loading && activeTab === 'squeeze' && (
        <div className="space-y-2 tab-content" key="squeeze">
          {squeeze.length > 0 ? (
            squeeze.map((stock, i) => (
              <div key={stock.symbol || i} className="card-animate"><SqueezeCard stock={stock} /></div>
            ))
          ) : (
            <EmptyState
              icon={Flame}
              title="No squeeze setups detected"
              subtitle="Short squeeze candidates will appear when conditions align"
            />
          )}
        </div>
      )}

      {/* Breakouts */}
      {!loading && activeTab === 'breakouts' && (
        <div className="space-y-2 tab-content" key="breakouts">
          {breakouts.length > 0 ? (
            breakouts.map((stock, i) => (
              <div key={stock.symbol || i} className="card-animate"><BreakoutCard stock={stock} /></div>
            ))
          ) : (
            <EmptyState
              icon={Activity}
              title="No breakout setups found"
              subtitle="Volatility contraction patterns will show up here"
            />
          )}
        </div>
      )}

      {/* Relative Strength */}
      {!loading && activeTab === 'strength' && (
        <div className="space-y-2 tab-content" key="strength">
          {strength.length > 0 ? (
            strength.map((stock, i) => (
              <div key={stock.symbol || i} className="card-animate"><RelativeStrengthCard stock={stock} /></div>
            ))
          ) : (
            <EmptyState
              icon={Target}
              title="No relative strength leaders"
              subtitle="Stocks outperforming SPY will appear during market hours"
            />
          )}
        </div>
      )}
    </div>
  )
}
