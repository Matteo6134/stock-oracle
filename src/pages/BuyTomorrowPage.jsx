import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Crosshair, TrendingUp, Activity, Flame, RefreshCw,
  ArrowUpRight, ArrowDownRight, Clock, AlertTriangle,
  Zap, ShieldCheck, Eye, BarChart3, Star
} from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || ''

const TABS = [
  { id: 'top', label: 'Top Picks', icon: Star },
  { id: 'accumulation', label: 'Stealth Buy', icon: Eye },
  { id: 'coiled', label: 'Coiled Springs', icon: Activity },
  { id: 'runners', label: 'Early Runners', icon: Zap },
  { id: 'bounces', label: 'Bounces', icon: TrendingUp },
]

const SIGNAL_INFO = {
  'unusual_volume': { label: 'Stealth Buying', color: 'bg-purple-500/15 text-purple-400 border-purple-400/30', icon: Eye },
  'early_momentum': { label: 'Early Runner', color: 'bg-oracle-green/15 text-oracle-green border-oracle-green/30', icon: Zap },
  'short_squeeze_loading': { label: 'Squeeze Loading', color: 'bg-orange-500/15 text-orange-400 border-orange-400/30', icon: Flame },
  'bb_squeeze': { label: 'BB Squeeze', color: 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/30', icon: Activity },
  'volume_contraction': { label: 'Vol Drying Up', color: 'bg-slate-400/15 text-slate-300 border-slate-400/30', icon: BarChart3 },
  'earnings_tomorrow': { label: 'Earnings', color: 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30', icon: Star },
  'low_float_volume': { label: 'Low Float', color: 'bg-pink-500/15 text-pink-400 border-pink-400/30', icon: Zap },
  'sector_lag': { label: 'Sector Lag', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-400/30', icon: TrendingUp },
  'oversold_bounce': { label: 'Oversold', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-400/30', icon: ArrowUpRight },
  'bull_flag': { label: 'Bull Flag', color: 'bg-oracle-green/15 text-oracle-green border-oracle-green/30', icon: TrendingUp },
  'golden_cross': { label: 'Golden Cross', color: 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30', icon: Star },
}

const TIMING_STYLES = {
  'buy_today': { label: 'BUY TODAY', bg: 'bg-oracle-green/20', color: 'text-oracle-green', border: 'border-oracle-green/40' },
  'buy_today_or_tomorrow': { label: 'BUY TODAY/TOMORROW', bg: 'bg-oracle-accent/20', color: 'text-oracle-accent', border: 'border-oracle-accent/40' },
  'watch_for_breakout': { label: 'WATCH FOR BREAKOUT', bg: 'bg-oracle-yellow/20', color: 'text-oracle-yellow', border: 'border-oracle-yellow/40' },
  'watchlist': { label: 'ADD TO WATCHLIST', bg: 'bg-white/5', color: 'text-oracle-muted', border: 'border-oracle-border' },
}

const RISK_STYLES = {
  'high_conviction': { label: 'High Conviction', color: 'text-oracle-green' },
  'moderate': { label: 'Moderate', color: 'text-oracle-yellow' },
  'speculative': { label: 'Speculative', color: 'text-oracle-muted' },
}

function SkeletonCards({ count = 5 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass-card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="skeleton-shimmer h-5 w-14 rounded" />
              <div className="skeleton-shimmer h-4 w-28 rounded" />
            </div>
            <div className="skeleton-shimmer h-5 w-20 rounded-full" />
          </div>
          <div className="flex gap-1.5 mb-3">
            <div className="skeleton-shimmer h-5 w-20 rounded-full" />
            <div className="skeleton-shimmer h-5 w-16 rounded-full" />
          </div>
          <div className="skeleton-shimmer h-2 w-full rounded-full" />
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
  const info = SIGNAL_INFO[signal] || { label: signal, color: 'bg-white/5 text-oracle-muted border-oracle-border' }
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${info.color}`}>
      {info.label}
    </span>
  )
}

function TimingBadge({ timing }) {
  const style = TIMING_STYLES[timing] || TIMING_STYLES.watchlist
  return (
    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${style.bg} ${style.color} ${style.border}`}>
      {style.label}
    </span>
  )
}

function SetupScoreBar({ score, max = 60 }) {
  const pct = Math.min(100, (score / max) * 100)
  const color = pct >= 60 ? 'bg-oracle-green' : pct >= 40 ? 'bg-oracle-yellow' : 'bg-oracle-accent'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-oracle-muted font-mono w-6 text-right">{score}</span>
    </div>
  )
}

// ── Main Setup Card ──
function SetupCard({ stock }) {
  const navigate = useNavigate()
  const isUp = stock.changePct >= 0
  const riskStyle = RISK_STYLES[stock.risk] || RISK_STYLES.speculative

  const formatFloat = (f) => {
    if (!f || f <= 0) return null
    if (f >= 1_000_000_000) return `${(f / 1_000_000_000).toFixed(1)}B`
    if (f >= 1_000_000) return `${(f / 1_000_000).toFixed(1)}M`
    return `${(f / 1000).toFixed(0)}K`
  }

  const formatVol = (v) => {
    if (!v) return '?'
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1000) return `${(v / 1000).toFixed(0)}K`
    return v.toString()
  }

  return (
    <div
      onClick={() => navigate(`/stock/${stock.symbol}`)}
      className="glass-card p-4 cursor-pointer hover:bg-white/[0.03] active:scale-[0.98] transition-all duration-300"
    >
      {/* Top row: Symbol, company, timing */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-oracle-text font-bold text-sm">{stock.symbol}</span>
            <span className={`text-xs font-semibold ${riskStyle.color}`}>{riskStyle.label}</span>
          </div>
          <p className="text-oracle-muted text-[11px] truncate pr-2">{stock.companyName}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-oracle-text font-bold text-base">${stock.price}</span>
          <span className={`text-xs font-semibold flex items-center gap-0.5 ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {isUp ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
            {isUp ? '+' : ''}{stock.changePct}%
          </span>
        </div>
      </div>

      {/* Timing badge */}
      <div className="mb-2.5">
        <TimingBadge timing={stock.timing} />
      </div>

      {/* Signal badges */}
      <div className="flex flex-wrap gap-1 mb-2.5">
        {stock.signals.map((sig, i) => (
          <SignalBadge key={i} signal={sig} />
        ))}
      </div>

      {/* Setup details */}
      <div className="grid grid-cols-3 gap-2 mb-2.5">
        <div className="glass-inner rounded-lg p-1.5 text-center">
          <p className="text-[9px] text-oracle-muted uppercase">Volume</p>
          <p className="text-xs font-bold text-oracle-text">{stock.volumeRatio}x</p>
        </div>
        {stock.floatShares > 0 && (
          <div className="glass-inner rounded-lg p-1.5 text-center">
            <p className="text-[9px] text-oracle-muted uppercase">Float</p>
            <p className="text-xs font-bold text-oracle-text">{formatFloat(stock.floatShares)}</p>
          </div>
        )}
        <div className="glass-inner rounded-lg p-1.5 text-center">
          <p className="text-[9px] text-oracle-muted uppercase">Vol</p>
          <p className="text-xs font-bold text-oracle-text">{formatVol(stock.volume)}</p>
        </div>
      </div>

      {/* Detail chips from details object */}
      {stock.details && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {stock.details.shortPercentOfFloat && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-300">
              SI: {stock.details.shortPercentOfFloat.toFixed(1)}%
            </span>
          )}
          {stock.details.daysToCover > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-300">
              DTC: {stock.details.daysToCover.toFixed(1)}d
            </span>
          )}
          {stock.details.floatCategory && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-300">
              {stock.details.floatCategory} float
            </span>
          )}
          {stock.details.sectorName && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300">
              {stock.details.sectorName} +{stock.details.sectorChange}%
            </span>
          )}
          {stock.details.earningsTomorrow && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-oracle-yellow/15 text-oracle-yellow font-bold">
              Earnings Tomorrow
            </span>
          )}
          {stock.details.distanceFrom50MA && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300">
              {stock.details.distanceFrom50MA}% from 50MA
            </span>
          )}
        </div>
      )}

      {/* Score bar */}
      <SetupScoreBar score={stock.setupScore} />
    </div>
  )
}

function StatsPill({ value, label, color }) {
  return (
    <div className="glass-inner rounded-xl p-2 text-center">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-[9px] text-oracle-muted uppercase tracking-wider">{label}</p>
    </div>
  )
}

// ── Main Page ──
export default function BuyTomorrowPage() {
  const [activeTab, setActiveTab] = useState('top')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastScan, setLastScan] = useState(null)
  const touchStartY = useRef(0)
  const [pulling, setPulling] = useState(false)
  const containerRef = useRef(null)

  const fetchData = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true)
      setError(null)
      const res = await fetch(`${API_BASE}/api/tomorrow-movers`)
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const json = await res.json()
      setData(json)
      setLastScan(new Date())
    } catch (err) {
      setError(err.message || 'Failed to scan')
    } finally {
      setLoading(false)
      setPulling(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(() => fetchData(false), 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchData])

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
    if (pulling) fetchData(true)
  }, [pulling, fetchData])

  const stats = data?.stats || {}
  const topPicks = data?.topPicks || []
  const accumulation = data?.accumulation || []
  const coiled = data?.coiledSprings || []
  const runners = data?.earlyRunners || []
  const bounces = data?.bounces || []

  const getActiveList = () => {
    switch (activeTab) {
      case 'top': return topPicks
      case 'accumulation': return accumulation
      case 'coiled': return coiled
      case 'runners': return runners
      case 'bounces': return bounces
      default: return []
    }
  }

  const getEmptyInfo = () => {
    switch (activeTab) {
      case 'top': return { icon: Star, title: 'No high-conviction setups', subtitle: 'Check during market hours for best results (9:30 AM - 4 PM ET)' }
      case 'accumulation': return { icon: Eye, title: 'No stealth buying detected', subtitle: 'Unusual volume patterns will appear here' }
      case 'coiled': return { icon: Activity, title: 'No coiled springs found', subtitle: 'BB squeeze + short squeeze setups appear here' }
      case 'runners': return { icon: Zap, title: 'No early runners', subtitle: 'Stocks starting to move with momentum will show here' }
      case 'bounces': return { icon: TrendingUp, title: 'No bounce setups', subtitle: 'Oversold and sector lag plays appear here' }
      default: return { icon: Star, title: 'No data', subtitle: '' }
    }
  }

  const activeList = getActiveList()
  const emptyInfo = getEmptyInfo()

  return (
    <div
      ref={containerRef}
      className="max-w-lg mx-auto px-4 pt-1 pb-6"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull to refresh */}
      {pulling && (
        <div className="flex items-center justify-center py-3 text-oracle-accent">
          <RefreshCw size={16} className="animate-spin mr-2" />
          <span className="text-xs font-medium">Release to refresh</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Crosshair className="text-oracle-green" size={22} />
            Buy Tomorrow
          </h1>
          <p className="text-oracle-muted text-[10px] mt-0.5">
            Stocks setting up for big moves — buy during market hours
          </p>
          {lastScan && (
            <span className="text-oracle-muted/50 text-[9px] flex items-center gap-1 mt-0.5">
              <Clock size={8} />
              Scanned {lastScan.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <button
          onClick={() => fetchData(true)}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* How it works banner */}
      <div className="glass-card p-3 mb-3 border-l-4 border-l-oracle-green">
        <div className="flex items-start gap-2">
          <ShieldCheck size={16} className="text-oracle-green mt-0.5 shrink-0" />
          <div>
            <p className="text-oracle-text text-[11px] font-semibold mb-0.5">Find movers BEFORE they move</p>
            <p className="text-oracle-muted text-[10px] leading-relaxed">
              These stocks show signals today that predict 10-50%+ moves in the next 1-3 days.
              Buy during regular market hours, hold for the move.
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      {!loading && data && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <StatsPill value={stats.setupsFound || 0} label="Setups" color="text-oracle-accent" />
          <StatsPill value={stats.highConviction || 0} label="High Conv." color="text-oracle-green" />
          <StatsPill value={stats.avgScore || 0} label="Avg Score" color="text-oracle-yellow" />
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
            <span className="text-sm font-medium">Scan failed</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button
            onClick={() => fetchData(true)}
            className="px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && <SkeletonCards />}

      {/* Cards */}
      {!loading && (
        <div className="space-y-2 tab-content" key={activeTab}>
          {activeList.length > 0 ? (
            activeList.map((stock, i) => (
              <div key={stock.symbol || i} className="card-animate">
                <SetupCard stock={stock} />
              </div>
            ))
          ) : (
            <EmptyState
              icon={emptyInfo.icon}
              title={emptyInfo.title}
              subtitle={emptyInfo.subtitle}
            />
          )}
        </div>
      )}

      {/* Footer legend */}
      {!loading && activeList.length > 0 && (
        <div className="mt-4 p-3 glass-inner rounded-xl space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-oracle-green/20 text-oracle-green border border-oracle-green/40">BUY TODAY</span>
            <span className="text-oracle-muted text-[10px]">act now during market hours</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-oracle-accent/20 text-oracle-accent border border-oracle-accent/40">BUY TODAY/TOMORROW</span>
            <span className="text-oracle-muted text-[10px]">flexible timing, both days work</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-oracle-yellow/20 text-oracle-yellow border border-oracle-yellow/40">WATCH FOR BREAKOUT</span>
            <span className="text-oracle-muted text-[10px]">wait for breakout confirmation first</span>
          </div>
          <p className="text-oracle-muted/50 text-[9px] text-center pt-0.5">Tap any stock for full analysis</p>
        </div>
      )}
    </div>
  )
}
