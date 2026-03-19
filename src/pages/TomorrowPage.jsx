import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays, AlertCircle, RefreshCw, Zap, ShoppingCart, Clock,
  Diamond, Activity, TrendingUp, TrendingDown, Flame, Eye, Target,
  ArrowUpRight, ArrowDownRight, ChevronRight, BarChart3, Timer
} from 'lucide-react'
import LoadingSkeleton from '../components/LoadingSkeleton'

const API_BASE = import.meta.env.VITE_API_URL || ''

// ── Signal labels for display ──
const SIGNAL_LABELS = {
  unusual_volume: 'Unusual Volume',
  multi_day_accumulation: 'Multi-Day Accumulation',
  smart_money: 'Smart Money',
  early_momentum: 'Early Momentum',
  momentum_acceleration: 'Momentum Accelerating',
  short_squeeze_loading: 'Squeeze Loading',
  bb_squeeze: 'BB Squeeze',
  volume_contraction: 'Volume Dry-Up',
  near_52w_high: 'Near 52W High',
  earnings_tomorrow: 'Earnings Tomorrow',
  low_float_volume: 'Low Float + Volume',
  sector_lag: 'Sector Lag',
  oversold_bounce: 'Oversold Bounce',
  bull_flag: 'Bull Flag',
  golden_cross: 'Golden Cross',
  price_compression: 'Price Coiling',
}

const SIGNAL_COLORS = {
  unusual_volume: 'bg-purple-500/20 text-purple-300 border-purple-400/30',
  multi_day_accumulation: 'bg-purple-600/20 text-purple-200 border-purple-400/40',
  smart_money: 'bg-amber-500/20 text-amber-300 border-amber-400/30',
  early_momentum: 'bg-oracle-green/20 text-oracle-green border-oracle-green/30',
  momentum_acceleration: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30',
  short_squeeze_loading: 'bg-orange-500/20 text-orange-300 border-orange-400/30',
  bb_squeeze: 'bg-blue-500/20 text-blue-300 border-blue-400/30',
  volume_contraction: 'bg-slate-500/20 text-slate-300 border-slate-400/30',
  near_52w_high: 'bg-yellow-500/20 text-yellow-300 border-yellow-400/30',
  earnings_tomorrow: 'bg-cyan-500/20 text-cyan-300 border-cyan-400/30',
  low_float_volume: 'bg-red-500/20 text-red-300 border-red-400/30',
  sector_lag: 'bg-teal-500/20 text-teal-300 border-teal-400/30',
  oversold_bounce: 'bg-sky-500/20 text-sky-300 border-sky-400/30',
  bull_flag: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/30',
  golden_cross: 'bg-lime-500/20 text-lime-300 border-lime-400/30',
  price_compression: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/30',
}

const TIMING_STYLES = {
  buy_today: { label: 'BUY TODAY', bg: 'bg-oracle-green/25', text: 'text-oracle-green', border: 'border-oracle-green/50', icon: ShoppingCart },
  buy_today_or_tomorrow: { label: 'BUY TODAY/TOMORROW', bg: 'bg-oracle-accent/20', text: 'text-oracle-accent', border: 'border-oracle-accent/40', icon: Timer },
  watch_for_breakout: { label: 'WATCH', bg: 'bg-oracle-yellow/15', text: 'text-oracle-yellow', border: 'border-oracle-yellow/30', icon: Eye },
  watchlist: { label: 'WATCHLIST', bg: 'bg-white/5', text: 'text-oracle-muted', border: 'border-oracle-border', icon: Eye },
}

const TABS = [
  { key: 'gems', label: 'Gems', icon: Diamond },
  { key: 'accumulation', label: 'Stealth Buy', icon: Activity },
  { key: 'coiledSprings', label: 'Squeeze', icon: Flame },
  { key: 'earlyRunners', label: 'Runners', icon: TrendingUp },
  { key: 'bounces', label: 'Bounces', icon: Target },
]

// ── Gem Score Ring ──
function GemScoreRing({ score, size = 44 }) {
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const pct = Math.min(score, 100) / 100
  const color = score >= 60 ? '#22c55e' : score >= 35 ? '#eab308' : '#64748b'
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={3}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"
          className="transition-all duration-700" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-oracle-text">{score}</span>
    </div>
  )
}

// ── Setup Card ──
function SetupCard({ stock }) {
  const navigate = useNavigate()
  const isUp = (stock.changePct ?? 0) >= 0
  const timing = TIMING_STYLES[stock.timing] || TIMING_STYLES.watchlist
  const TimingIcon = timing.icon

  const formatVol = (v) => {
    if (!v) return '?'
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
    return v.toString()
  }

  return (
    <div
      onClick={() => navigate(`/stock/${stock.symbol}`)}
      className="glass-card p-3.5 cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]"
    >
      {/* Top: Symbol + Gem Score + Price */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <GemScoreRing score={stock.gemScore ?? 0} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-oracle-text font-bold text-sm">{stock.symbol}</span>
              {stock.signalCount >= 3 && (
                <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-oracle-green/20 text-oracle-green border border-oracle-green/30">
                  {stock.signalCount} SIGNALS
                </span>
              )}
            </div>
            <p className="text-oracle-muted text-[11px] truncate">{stock.companyName}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-oracle-text font-bold text-sm">${(stock.price ?? 0).toFixed(2)}</p>
          <p className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {isUp ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
            {isUp ? '+' : ''}{(stock.changePct ?? 0).toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Timing + Consensus badges */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border ${timing.bg} ${timing.text} ${timing.border} ${stock.timing === 'buy_today' ? 'animate-pulse' : ''}`}>
          <TimingIcon size={9} />
          {timing.label}
        </span>
        {stock.consensus && stock.consensus !== 'No Trade' && (
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold border ${
            stock.consensus === 'Strong Buy' ? 'bg-oracle-green/15 text-oracle-green border-oracle-green/25'
            : stock.consensus === 'Buy' ? 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/25'
            : 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/25'
          }`}>
            {stock.buyCount || 0}/5 Agents: {stock.consensus}
          </span>
        )}
        {stock.risk === 'high_conviction' && (
          <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-oracle-green/15 text-oracle-green border border-oracle-green/25">
            HIGH CONVICTION
          </span>
        )}
      </div>

      {/* Signal badges */}
      <div className="flex flex-wrap gap-1 mb-2">
        {(stock.signals || []).slice(0, 4).map((sig) => (
          <span key={sig} className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${SIGNAL_COLORS[sig] || 'bg-white/5 text-oracle-muted border-oracle-border'}`}>
            {SIGNAL_LABELS[sig] || sig.replace(/_/g, ' ')}
          </span>
        ))}
        {(stock.signals || []).length > 4 && (
          <span className="px-1.5 py-0.5 rounded text-[9px] text-oracle-muted bg-white/5">
            +{stock.signals.length - 4} more
          </span>
        )}
      </div>

      {/* Squeeze explanation if squeeze signal present */}
      {(stock.signals || []).some(s => s === 'short_squeeze_loading' || s === 'bb_squeeze') && stock.details?.shortPercentOfFloat > 0 && (
        <div className="glass-inner rounded-lg p-2 mb-2 border-l-2 border-l-orange-400/50">
          <div className="text-[10px] text-oracle-muted leading-relaxed">
            <span className="text-orange-300 font-semibold">Squeeze Setup: </span>
            {stock.details.shortPercentOfFloat.toFixed(1)}% SI
            {stock.details.daysToCover ? ` · ${stock.details.daysToCover.toFixed(1)}d to cover` : ''}
            {' — '}
            {stock.details.shortPercentOfFloat >= 30
              ? 'Extreme short interest. If price rises, shorts are forced to buy back shares, creating explosive chain reaction.'
              : stock.details.shortPercentOfFloat >= 20
                ? 'High short interest. A catalyst could trigger forced covering and rapid price increase.'
                : 'Elevated shorts building. Watch for volume spikes as squeeze trigger.'}
          </div>
        </div>
      )}

      {/* Key details row */}
      <div className="flex items-center gap-3 text-[10px] text-oracle-muted">
        {stock.volumeRatio > 0 && (
          <span className={stock.volumeRatio >= 2 ? 'text-purple-300 font-semibold' : ''}>
            Vol: {stock.volumeRatio}x
          </span>
        )}
        {stock.details?.shortPercentOfFloat > 0 && (
          <span className="text-orange-300 font-semibold">
            SI: {stock.details.shortPercentOfFloat.toFixed(0)}%
          </span>
        )}
        {stock.details?.volumeStreakDays > 0 && (
          <span className="text-purple-300 font-semibold">
            {stock.details.volumeStreakDays}d streak
          </span>
        )}
        {stock.details?.closingStrength > 0 && (
          <span className={stock.details.closingStrength > 65 ? 'text-amber-300 font-semibold' : ''}>
            Close: {stock.details.closingStrength}% high
          </span>
        )}
        {stock.details?.pctFrom52wHigh != null && (
          <span className="text-yellow-300 font-semibold">
            {stock.details.pctFrom52wHigh >= 0 ? 'AT' : `${stock.details.pctFrom52wHigh}%`} 52w
          </span>
        )}
        <span className="ml-auto">Vol {formatVol(stock.volume)}</span>
      </div>
    </div>
  )
}

// ── Empty State ──
function EmptyTab({ icon: Icon, title, subtitle }) {
  return (
    <div className="py-12 text-center">
      <Icon size={40} className="text-oracle-muted/40 mx-auto mb-3" />
      <p className="text-oracle-muted text-sm font-medium">{title}</p>
      <p className="text-oracle-muted/60 text-xs mt-1">{subtitle}</p>
    </div>
  )
}

export default function TomorrowPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('gems')
  const [lastUpdated, setLastUpdated] = useState(null)
  const refreshingRef = useRef(false)

  const fetchData = useCallback(async (silent = false) => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/tomorrow-movers`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setData(result)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      refreshingRef.current = false
    }
  }, [])

  // Initial load + auto-refresh every 5 min
  useEffect(() => {
    fetchData()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchData(true)
    }, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [fetchData])

  const stats = data?.stats || {}
  const updatedAgo = lastUpdated
    ? `${Math.round((Date.now() - lastUpdated.getTime()) / 60000)}m ago`
    : null

  const tabStocks = data ? (data[tab] || []) : []

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Diamond className="text-oracle-green" size={22} />
            Gem Finder
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">
            Find explosive stocks BEFORE they move
          </p>
        </div>
        <div className="flex items-center gap-2">
          {updatedAgo && (
            <span className="text-oracle-muted text-[10px] flex items-center gap-0.5">
              <Clock size={9} /> {updatedAgo}
            </span>
          )}
          <button
            onClick={() => fetchData(false)}
            disabled={loading}
            className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Stats row */}
      {!loading && data && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="glass-card p-2 text-center">
            <p className="text-oracle-green font-bold text-lg">{stats.gemsFound || 0}</p>
            <p className="text-oracle-muted text-[10px]">Gems</p>
          </div>
          <div className="glass-card p-2 text-center">
            <p className="text-oracle-accent font-bold text-lg">{stats.setupsFound || 0}</p>
            <p className="text-oracle-muted text-[10px]">Setups</p>
          </div>
          <div className="glass-card p-2 text-center">
            <p className="text-oracle-yellow font-bold text-lg">{stats.highConviction || 0}</p>
            <p className="text-oracle-muted text-[10px]">High Conv.</p>
          </div>
        </div>
      )}

      {/* Info banner */}
      {!loading && data && (data.gems?.length > 0 || stats.gemsFound > 0) && (
        <div className="p-3 glass-card border-l-4 border-l-oracle-green mb-3 flex items-center gap-2">
          <Diamond size={16} className="text-oracle-green shrink-0" />
          <div>
            <div className="text-oracle-green text-sm font-bold">Gems Detected</div>
            <div className="text-oracle-muted text-xs">
              Stocks with multiple explosive signals. Higher Gem Score = higher probability of a big move.
            </div>
          </div>
        </div>
      )}

      {/* Tab pills */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto no-scrollbar pb-0.5">
        {TABS.map(t => {
          const Icon = t.icon
          const isActive = tab === t.key
          const count = data ? (data[t.key]?.length || 0) : 0
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border shrink-0
                ${isActive
                  ? 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/40'
                  : 'bg-white/[0.02] text-oracle-muted border-oracle-border hover:bg-white/[0.04]'
                }`}
            >
              <Icon size={13} />
              {t.label}
              {count > 0 && (
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-oracle-accent/20' : 'bg-white/5'}`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="p-4 glass-card border-l-4 border-l-oracle-red mb-4">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">Scan failed</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button onClick={() => fetchData(false)}
            className="px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors">
            Retry
          </button>
        </div>
      )}

      {loading && <LoadingSkeleton count={6} />}

      {/* Stock list */}
      {!loading && !error && tabStocks.length > 0 && (
        <div className="space-y-2">
          {tabStocks.map((stock) => (
            <SetupCard key={stock.symbol} stock={stock} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && tabStocks.length === 0 && (
        <EmptyTab
          icon={TABS.find(t => t.key === tab)?.icon || Diamond}
          title={`No ${TABS.find(t => t.key === tab)?.label || ''} setups found`}
          subtitle="Check back during US market hours (3:30 PM - 10:00 PM CET) for live data."
        />
      )}

      {/* Legend */}
      {!loading && (
        <div className="mt-4 glass-card p-3">
          <p className="text-oracle-muted text-[10px] font-semibold mb-2">HOW GEM SCORE WORKS</p>
          <div className="space-y-1.5 text-[10px] text-oracle-muted">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-oracle-green shrink-0" />
              <span><strong className="text-oracle-green">60-100</strong> — High conviction. Multiple explosive signals stacking up.</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-oracle-yellow shrink-0" />
              <span><strong className="text-oracle-yellow">35-59</strong> — Moderate. Worth watching, wait for confirmation.</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-slate-500 shrink-0" />
              <span><strong className="text-slate-400">0-34</strong> — Speculative. Single signal, needs more evidence.</span>
            </div>
          </div>
          <p className="text-oracle-muted/60 text-[9px] mt-2">
            BUY TODAY = act now during market hours · BUY TODAY/TOMORROW = position in next 1-2 days · WATCH = wait for breakout confirmation
          </p>
        </div>
      )}
    </div>
  )
}
