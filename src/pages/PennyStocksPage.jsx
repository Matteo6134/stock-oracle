import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Rocket, RefreshCw, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  AlertTriangle, Diamond, Flame, Activity, Zap, Target, Eye, BarChart3, DollarSign
} from 'lucide-react'
import LoadingSkeleton from '../components/LoadingSkeleton'

const API_BASE = import.meta.env.VITE_API_URL || ''

const PRICE_TIERS = [
  { label: '< $1', value: 1 },
  { label: '< $2', value: 2 },
  { label: '< $5', value: 5 },
  { label: '< $10', value: 10 },
]

const SIGNAL_LABELS = {
  unusual_volume: 'Unusual Volume',
  multi_day_accumulation: 'Multi-Day Accumulation',
  smart_money: 'Smart Money',
  early_momentum: 'Early Momentum',
  momentum_acceleration: 'Momentum Accelerating',
  short_squeeze_loading: 'Squeeze Loading',
  bb_squeeze: 'BB Squeeze',
  low_float_volume: 'Low Float + Volume',
  oversold_bounce: 'Oversold Bounce',
  price_compression: 'Price Coiling',
  penny_breakout: 'Penny Breakout',
  micro_float: 'Micro Float',
  penny_squeeze: 'Penny Squeeze',
  penny_volume_spike: 'Volume Spike',
  dilution_risk: 'Dilution Risk',
  insider_buying: 'Insider Buying',
  bullish_options: 'Bullish Options',
  unusual_options_volume: 'Options Surge',
  institutions_accumulating: 'Institutions Loading',
}

const SIGNAL_COLORS = {
  unusual_volume: 'bg-purple-500/20 text-purple-300 border-purple-400/30',
  multi_day_accumulation: 'bg-purple-600/20 text-purple-200 border-purple-400/40',
  smart_money: 'bg-amber-500/20 text-amber-300 border-amber-400/30',
  early_momentum: 'bg-oracle-green/20 text-oracle-green border-oracle-green/30',
  momentum_acceleration: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30',
  short_squeeze_loading: 'bg-orange-500/20 text-orange-300 border-orange-400/30',
  bb_squeeze: 'bg-blue-500/20 text-blue-300 border-blue-400/30',
  low_float_volume: 'bg-red-500/20 text-red-300 border-red-400/30',
  oversold_bounce: 'bg-sky-500/20 text-sky-300 border-sky-400/30',
  price_compression: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/30',
  // Penny-specific
  penny_breakout: 'bg-rose-500/20 text-rose-300 border-rose-400/30',
  micro_float: 'bg-pink-500/20 text-pink-300 border-pink-400/30',
  penny_squeeze: 'bg-orange-600/20 text-orange-200 border-orange-400/40',
  penny_volume_spike: 'bg-violet-500/20 text-violet-300 border-violet-400/30',
  dilution_risk: 'bg-red-700/20 text-red-400 border-red-500/40',
  insider_buying: 'bg-green-600/25 text-green-200 border-green-400/50',
  bullish_options: 'bg-emerald-600/25 text-emerald-200 border-emerald-400/50',
  unusual_options_volume: 'bg-teal-600/25 text-teal-200 border-teal-400/50',
  institutions_accumulating: 'bg-cyan-600/25 text-cyan-200 border-cyan-400/50',
}

const TIMING_STYLES = {
  breaking_out: { label: 'BREAKING OUT', bg: 'bg-rose-500/25', text: 'text-rose-300', border: 'border-rose-400/50', pulse: true },
  volume_alert: { label: 'VOLUME ALERT', bg: 'bg-violet-500/20', text: 'text-violet-300', border: 'border-violet-400/40' },
  starting_move: { label: 'STARTING MOVE', bg: 'bg-oracle-green/25', text: 'text-oracle-green', border: 'border-oracle-green/50' },
  squeeze_setup: { label: 'SQUEEZE SETUP', bg: 'bg-orange-500/20', text: 'text-orange-300', border: 'border-orange-400/40' },
  accumulating: { label: 'ACCUMULATING', bg: 'bg-amber-500/15', text: 'text-amber-300', border: 'border-amber-400/30' },
  bounce_setup: { label: 'BOUNCE SETUP', bg: 'bg-sky-500/15', text: 'text-sky-300', border: 'border-sky-400/30' },
  watching: { label: 'WATCHING', bg: 'bg-white/5', text: 'text-oracle-muted', border: 'border-oracle-border' },
}

// ── Gem Score Ring ──
function GemScoreRing({ score, size = 44 }) {
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const pct = Math.min(score, 100) / 100
  const color = score >= 50 ? '#22c55e' : score >= 30 ? '#eab308' : '#64748b'
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

// ── Penny Stock Card ──
function PennyCard({ stock }) {
  const navigate = useNavigate()
  const timing = TIMING_STYLES[stock.timing] || TIMING_STYLES.watching
  const isUp = stock.changePct >= 0
  const hasDilution = stock.signals.includes('dilution_risk')
  const maxSignals = 4
  const visibleSignals = stock.signals.filter(s => s !== 'dilution_risk').slice(0, maxSignals)
  const remaining = stock.signals.filter(s => s !== 'dilution_risk').length - maxSignals

  const formatFloat = (n) => {
    if (!n) return '—'
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
    return n.toString()
  }

  const formatVol = (n) => {
    if (!n) return '—'
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
    return n.toString()
  }

  return (
    <div
      className="glass-card p-3.5 cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]"
      onClick={() => navigate(`/stock/${stock.symbol}`)}
    >
      {/* Top row: symbol, score, price */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-oracle-text font-bold text-sm">{stock.symbol}</span>
            {stock.signalCount >= 3 && (
              <span className="bg-oracle-accent/20 text-oracle-accent text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-oracle-accent/30">
                {stock.signalCount} signals
              </span>
            )}
            {hasDilution && (
              <span className="flex items-center gap-0.5 bg-red-700/20 text-red-400 text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-red-500/40">
                <AlertTriangle size={9} /> DILUTION
              </span>
            )}
          </div>
          {stock.companyName && (
            <p className="text-oracle-muted text-xs truncate mt-0.5">{stock.companyName}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <div className="text-oracle-text font-bold text-sm">${stock.price < 1 ? stock.price.toFixed(4) : stock.price.toFixed(2)}</div>
            <div className={`flex items-center justify-end gap-0.5 text-xs font-medium ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {isUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
              {isUp ? '+' : ''}{stock.changePct}%
            </div>
          </div>
          <GemScoreRing score={stock.gemScore} />
          <button
            onClick={e => { e.stopPropagation(); navigate(`/trade?symbol=${stock.symbol}&amount=100`) }}
            className="p-1.5 rounded bg-oracle-green/15 text-oracle-green border border-oracle-green/30 hover:bg-oracle-green/25 transition-all"
            title="Trade"
          >
            <DollarSign size={12} />
          </button>
        </div>
      </div>

      {/* Timing badge */}
      <div className="mb-2">
        <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full border ${timing.bg} ${timing.text} ${timing.border} ${timing.pulse ? 'animate-pulse' : ''}`}>
          {timing.label}
        </span>
      </div>

      {/* Signal badges */}
      <div className="flex flex-wrap gap-1 mb-2">
        {visibleSignals.map(sig => (
          <span key={sig} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${SIGNAL_COLORS[sig] || 'bg-white/5 text-oracle-muted border-oracle-border'}`}>
            {SIGNAL_LABELS[sig] || sig.replace(/_/g, ' ')}
          </span>
        ))}
        {remaining > 0 && (
          <span className="text-[9px] text-oracle-muted px-1.5 py-0.5">+{remaining} more</span>
        )}
      </div>

      {/* Details row */}
      <div className="flex items-center gap-3 text-[10px]">
        <div>
          <span className="text-oracle-muted">VOL </span>
          <span className="text-oracle-text font-semibold">{formatVol(stock.volume)}</span>
        </div>
        <div>
          <span className="text-oracle-muted">VOL/AVG </span>
          <span className={`font-semibold ${stock.volumeRatio >= 2 ? 'text-oracle-green' : stock.volumeRatio >= 1.5 ? 'text-oracle-yellow' : 'text-oracle-text'}`}>
            {stock.volumeRatio}x
          </span>
        </div>
        {stock.floatShares > 0 && (
          <div>
            <span className="text-oracle-muted">FLOAT </span>
            <span className={`font-semibold ${stock.floatShares < 10e6 ? 'text-pink-300' : 'text-oracle-text'}`}>
              {formatFloat(stock.floatShares)}
            </span>
          </div>
        )}
        {stock.details?.shortPercentOfFloat > 0 && (
          <div>
            <span className="text-oracle-muted">SI </span>
            <span className={`font-semibold ${stock.details.shortPercentOfFloat > 20 ? 'text-orange-300' : 'text-oracle-text'}`}>
              {stock.details.shortPercentOfFloat.toFixed(1)}%
            </span>
          </div>
        )}
      </div>

      {/* Squeeze info if relevant */}
      {stock.details?.shortPercentOfFloat > 15 && stock.details?.daysToCover > 0 && (
        <div className="mt-2 p-2 rounded border border-orange-500/20 bg-orange-500/5 text-[10px]">
          <span className="text-orange-300 font-semibold">Squeeze Setup: </span>
          <span className="text-orange-200">{stock.details.shortPercentOfFloat.toFixed(1)}% SI</span>
          <span className="text-oracle-muted"> · {stock.details.daysToCover.toFixed(1)}d to cover</span>
        </div>
      )}

      {/* Smart Money / Order Flow info */}
      {stock.details?.tripleThreat && (
        <div className="mt-2 p-2 rounded border border-green-500/30 bg-green-500/10 text-[10px]">
          <span className="text-green-300 font-bold">TRIPLE THREAT — </span>
          <span className="text-oracle-muted">Insiders buying + bullish options + volume accumulation = extremely high conviction.</span>
        </div>
      )}
      {!stock.details?.tripleThreat && (stock.details?.insiderNetBuying || stock.details?.optionsSentiment || stock.details?.institutionChange > 0) && (
        <div className="mt-2 p-2 rounded border border-emerald-500/20 bg-emerald-500/5 text-[10px]">
          <span className="text-emerald-300 font-semibold">Smart Money: </span>
          {stock.details.insiderNetBuying && <span className="text-oracle-muted">{stock.details.insiderNetBuying} · </span>}
          {stock.details.optionsSentiment && <span className="text-oracle-muted">{stock.details.optionsSentiment} · </span>}
          {stock.details.institutionChange > 0 && <span className="text-oracle-muted">Institutions +{stock.details.institutionChange}%</span>}
        </div>
      )}

      {/* Dilution warning */}
      {hasDilution && stock.details?.dilutionRatio && (
        <div className="mt-2 p-2 rounded border border-red-500/20 bg-red-500/5 text-[10px]">
          <span className="text-red-400 font-semibold">Dilution Warning: </span>
          <span className="text-red-300">Shares outstanding {stock.details.dilutionRatio}x float — watch for offerings</span>
        </div>
      )}
    </div>
  )
}

// ── Main Page ──
export default function PennyStocksPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [maxPrice, setMaxPrice] = useState(5)

  const fetchData = useCallback(async (price) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/penny-stocks?maxPrice=${price}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setData(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData(maxPrice) }, [fetchData, maxPrice])

  const handleTierChange = (value) => {
    setMaxPrice(value)
  }

  const stocks = data?.stocks || []
  const stats = data?.stats || {}

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Rocket className="text-oracle-accent" size={22} />
            Penny Runners
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">
            Explosive sub-${maxPrice} stocks with signals
          </p>
        </div>
        <button
          onClick={() => fetchData(maxPrice)}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Price tier selector */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto scrollbar-hide">
        {PRICE_TIERS.map(tier => (
          <button
            key={tier.value}
            onClick={() => handleTierChange(tier.value)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap border ${
              maxPrice === tier.value
                ? 'bg-oracle-accent/20 text-oracle-accent border-oracle-accent/40'
                : 'glass-card text-oracle-muted hover:text-oracle-text border-oracle-border'
            }`}
          >
            {tier.label}
          </button>
        ))}
      </div>

      {/* Stats bar */}
      {!loading && data && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="glass-card p-2 text-center">
            <p className="text-oracle-accent font-bold text-lg">{stats.setupsFound || 0}</p>
            <p className="text-oracle-muted text-[10px]">SETUPS</p>
          </div>
          <div className="glass-card p-2 text-center">
            <p className="text-oracle-green font-bold text-lg">{stats.highPotential || 0}</p>
            <p className="text-oracle-muted text-[10px]">HIGH POT.</p>
          </div>
          <div className="glass-card p-2 text-center">
            <p className="text-oracle-yellow font-bold text-lg">{stats.avgGemScore || 0}</p>
            <p className="text-oracle-muted text-[10px]">AVG SCORE</p>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && <LoadingSkeleton count={6} />}

      {/* Error */}
      {error && !loading && (
        <div className="glass-card border-l-4 border-l-oracle-red p-4">
          <p className="text-oracle-red text-sm font-medium">Failed to load penny stocks</p>
          <p className="text-oracle-muted text-xs mt-1">{error}</p>
          <button onClick={() => fetchData(maxPrice)} className="mt-2 text-oracle-accent text-xs">Try Again</button>
        </div>
      )}

      {/* Stock list */}
      {!loading && !error && stocks.length > 0 && (
        <div className="space-y-2 mb-4">
          {stocks.map((stock, i) => (
            <PennyCard key={`${stock.symbol}-${i}`} stock={stock} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && stocks.length === 0 && (
        <div className="py-12 text-center">
          <Rocket size={48} className="text-oracle-muted/30 mx-auto mb-3" />
          <p className="text-oracle-text text-sm font-medium">No penny runners found</p>
          <p className="text-oracle-muted text-xs mt-1">
            No stocks under ${maxPrice} are showing strong signals right now. Try a higher price tier or check back later.
          </p>
        </div>
      )}

      {/* Risk disclaimer */}
      {!loading && stocks.length > 0 && (
        <div className="glass-card p-3 border-l-4 border-l-oracle-yellow/50">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-oracle-yellow shrink-0 mt-0.5" />
            <p className="text-oracle-muted text-[10px] leading-relaxed">
              Penny stocks are extremely volatile and risky. Many are subject to dilution, low liquidity, and manipulation.
              These signals highlight unusual activity — not buy recommendations. Always do your own research and never invest more than you can afford to lose.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
