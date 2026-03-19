import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bookmark, Search, X, Plus, RefreshCw, Bell, BellOff,
  TrendingUp, TrendingDown, Zap, Flame, Eye, AlertTriangle,
  ChevronRight, Clock, Star
} from 'lucide-react'
import { getWishlist, addToWishlist, removeFromWishlist, isInWishlist } from '../lib/wishlist'

const API_BASE = import.meta.env.VITE_API_URL || ''

const ALERT_STYLES = {
  buy_today: {
    label: 'BUY TODAY',
    bg: 'bg-oracle-green/20',
    text: 'text-oracle-green',
    border: 'border-oracle-green/40',
    icon: TrendingUp,
    pulse: true,
  },
  watch: {
    label: 'WATCH SETUP',
    bg: 'bg-oracle-accent/15',
    text: 'text-oracle-accent',
    border: 'border-oracle-accent/30',
    icon: Eye,
    pulse: false,
  },
  squeeze: {
    label: 'SQUEEZE LOADING',
    bg: 'bg-orange-500/15',
    text: 'text-orange-400',
    border: 'border-orange-400/30',
    icon: Flame,
    pulse: false,
  },
}

function AlertBadge({ alert }) {
  const style = ALERT_STYLES[alert.type] || {}
  const Icon = style.icon || Zap
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border ${style.bg} ${style.text} ${style.border} ${style.pulse ? 'animate-pulse' : ''}`}>
      <Icon size={9} />
      {style.label}
    </span>
  )
}

function WishlistCard({ stock, onRemove }) {
  const navigate = useNavigate()
  const isUp = stock.changePct >= 0
  const hasAlerts = stock.alerts && stock.alerts.length > 0

  const formatVol = (v) => {
    if (!v) return '?'
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1000) return `${(v / 1000).toFixed(0)}K`
    return v.toString()
  }

  return (
    <div
      className={`glass-card p-4 cursor-pointer hover:bg-white/[0.03] active:scale-[0.99] transition-all duration-200 ${hasAlerts ? 'border-oracle-accent/30' : ''}`}
      onClick={() => navigate(`/stock/${stock.symbol}`)}
    >
      {/* Top row */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-oracle-text font-bold text-sm">{stock.symbol}</span>
            {hasAlerts && (
              <span className="w-1.5 h-1.5 rounded-full bg-oracle-green animate-pulse" />
            )}
          </div>
          <p className="text-oracle-muted text-[11px] truncate">{stock.companyName}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="text-oracle-text font-bold text-sm">
              {stock.price > 0 ? `$${stock.price.toFixed(2)}` : '—'}
            </p>
            <p className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {isUp ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
              {isUp ? '+' : ''}{stock.changePct}%
            </p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(stock.symbol) }}
            className="p-1.5 rounded-lg text-oracle-muted/50 hover:text-oracle-red hover:bg-oracle-red/10 transition-all"
            aria-label="Remove from wishlist"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Alert badges */}
      {hasAlerts && (
        <div className="flex flex-wrap gap-1 mb-2">
          {stock.alerts.map((alert, i) => (
            <AlertBadge key={i} alert={alert} />
          ))}
        </div>
      )}

      {/* Setup explanation if available */}
      {stock.tomorrowSetup && (
        <div className="glass-inner rounded-lg p-2 mb-2">
          <p className="text-[10px] text-oracle-muted leading-relaxed">
            {stock.tomorrowSetup.signals?.slice(0, 2).map(s => s.replace(/_/g, ' ')).join(' · ') || 'Setup detected'}
            {stock.tomorrowSetup.setupScore ? ` — Score ${stock.tomorrowSetup.setupScore}` : ''}
          </p>
        </div>
      )}
      {stock.squeezeSetup && !stock.tomorrowSetup && (
        <div className="glass-inner rounded-lg p-2 mb-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-oracle-red text-[10px] font-bold">Squeeze Loading</span>
          </div>
          <p className="text-[10px] text-oracle-muted leading-relaxed">
            {(stock.squeezeSetup.shortPercentOfFloat ?? 0) > 0
              ? `${(stock.squeezeSetup.shortPercentOfFloat).toFixed(1)}% of shares are sold short`
              : 'Short interest data pending'}
            {' · '}
            {(stock.squeezeSetup.shortRatio ?? stock.squeezeSetup.daysToCover ?? 0) > 0
              ? `${(stock.squeezeSetup.shortRatio ?? stock.squeezeSetup.daysToCover).toFixed(1)} days to cover`
              : ''}
          </p>
          <p className="text-[9px] text-oracle-yellow/70 mt-1 leading-relaxed">
            {(stock.squeezeSetup.shortPercentOfFloat ?? 0) >= 30
              ? 'Extreme SI — if this stock moves up, shorts will be forced to buy (covering), creating an explosive chain reaction.'
              : (stock.squeezeSetup.shortPercentOfFloat ?? 0) >= 20
                ? 'High SI — many traders are betting against this stock. A positive catalyst could trigger a short squeeze.'
                : (stock.squeezeSetup.shortPercentOfFloat ?? 0) >= 10
                  ? 'Elevated SI — shorts are building. Watch for volume spikes as a squeeze trigger.'
                  : 'SI data from Yahoo Finance — updated weekly. Days-to-cover shows how long shorts need to exit.'}
          </p>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {stock.volume > 0 && (
            <span className="text-[10px] text-oracle-muted">Vol: {formatVol(stock.volume)}</span>
          )}
        </div>
        <ChevronRight size={14} className="text-oracle-muted/40" />
      </div>
    </div>
  )
}

function SearchDropdown({ results, onAdd, loading }) {
  if (loading) {
    return (
      <div className="absolute top-full left-0 right-0 mt-1 glass-card p-3 z-50">
        <div className="flex items-center gap-2 text-oracle-muted text-xs">
          <RefreshCw size={12} className="animate-spin" />
          Searching...
        </div>
      </div>
    )
  }
  if (!results || results.length === 0) return null
  return (
    <div className="absolute top-full left-0 right-0 mt-1 glass-card z-50 overflow-hidden">
      {results.map((r) => (
        <button
          key={r.symbol}
          onClick={() => onAdd(r.symbol)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.04] active:bg-white/[0.07] transition-colors border-b border-oracle-border/30 last:border-0"
        >
          <div className="flex items-start gap-3 text-left">
            <div>
              <p className="text-oracle-text text-sm font-bold">{r.symbol}</p>
              <p className="text-oracle-muted text-[11px]">{r.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {r.exchange && (
              <span className="text-[9px] text-oracle-muted/60 px-1.5 py-0.5 rounded bg-white/5">{r.exchange}</span>
            )}
            <Plus size={14} className="text-oracle-accent" />
          </div>
        </button>
      ))}
    </div>
  )
}

export default function WishlistPage() {
  const [wishlist, setWishlist] = useState(getWishlist())
  const [stocks, setStocks] = useState([])
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)

  // Search state
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const searchDebounce = useRef(null)
  const searchRef = useRef(null)

  // Analyze current wishlist
  const analyzeWishlist = useCallback(async (list = wishlist, showLoader = true) => {
    if (list.length === 0) { setStocks([]); return }
    if (showLoader) setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/wishlist-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: list }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStocks(data.stocks || [])
      setLastUpdated(new Date())
    } catch {
      // Silent
    } finally {
      setLoading(false)
    }
  }, [wishlist])

  // Initial load + auto-refresh every 3 min
  useEffect(() => {
    analyzeWishlist(wishlist, true)
    const interval = setInterval(() => analyzeWishlist(wishlist, false), 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line

  // Search debounce
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    if (!query.trim() || query.trim().length < 1) {
      setSearchResults([])
      setShowDropdown(false)
      return
    }
    searchDebounce.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query.trim())}`)
        if (!res.ok) return
        const data = await res.json()
        setSearchResults(data.results || [])
        setShowDropdown(true)
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 350)
  }, [query])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleAdd = (symbol) => {
    const sym = symbol.toUpperCase().trim()
    if (isInWishlist(sym)) { setQuery(''); setShowDropdown(false); return }
    const updated = addToWishlist(sym)
    setWishlist(updated)
    setQuery('')
    setShowDropdown(false)
    analyzeWishlist(updated, true)
  }

  const handleRemove = (symbol) => {
    const updated = removeFromWishlist(symbol)
    setWishlist(updated)
    setStocks(prev => prev.filter(s => s.symbol !== symbol))
  }

  const alertCount = stocks.filter(s => s.hasAlert).length

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Bookmark className="text-oracle-accent" size={22} />
            My Watchlist
          </h1>
          <p className="text-oracle-muted text-[10px] mt-0.5">
            Add any stock — get alerts when setups form
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-oracle-muted/50 text-[9px] flex items-center gap-1">
              <Clock size={8} />
              {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => analyzeWishlist(wishlist, true)}
            disabled={loading}
            className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Search input */}
      <div ref={searchRef} className="relative mb-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-oracle-muted/60" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
            placeholder="Search any stock to add (e.g. AAPL, NVDA, GME)..."
            className="w-full bg-white/[0.04] border border-oracle-border rounded-xl pl-9 pr-4 py-3 text-oracle-text text-sm placeholder:text-oracle-muted/50 focus:outline-none focus:border-oracle-accent/50 focus:bg-white/[0.06] transition-all"
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setShowDropdown(false) }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-oracle-muted/60 hover:text-oracle-muted"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {(showDropdown || searching) && (
          <SearchDropdown
            results={searchResults}
            onAdd={handleAdd}
            loading={searching && searchResults.length === 0}
          />
        )}
      </div>

      {/* Alert summary banner */}
      {alertCount > 0 && (
        <div className="glass-card p-3 mb-4 border-l-4 border-l-oracle-green">
          <div className="flex items-center gap-2">
            <Bell size={15} className="text-oracle-green animate-pulse" />
            <div>
              <p className="text-oracle-text text-[12px] font-bold">
                {alertCount} stock{alertCount > 1 ? 's' : ''} need your attention
              </p>
              <p className="text-oracle-muted text-[10px]">
                Setups are forming — check before market opens
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {wishlist.length === 0 && (
        <div className="py-16 text-center">
          <Bookmark size={44} className="text-oracle-muted/25 mx-auto mb-4" />
          <p className="text-oracle-text text-sm font-semibold mb-1">Your watchlist is empty</p>
          <p className="text-oracle-muted text-xs leading-relaxed max-w-xs mx-auto">
            Search for any stock above to add it. We'll monitor it and alert you when a setup forms or it enters Buy Tomorrow.
          </p>
        </div>
      )}

      {/* Loading skeletons */}
      {loading && wishlist.length > 0 && (
        <div className="space-y-2">
          {wishlist.map((sym) => (
            <div key={sym} className="glass-card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="skeleton-shimmer h-4 w-12 rounded" />
                  <div className="skeleton-shimmer h-3 w-24 rounded" />
                </div>
                <div className="skeleton-shimmer h-4 w-16 rounded" />
              </div>
              <div className="skeleton-shimmer h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
      )}

      {/* Stock cards — sort by alerts first */}
      {!loading && stocks.length > 0 && (
        <div className="space-y-2">
          {/* Stocks WITH alerts first */}
          {stocks
            .filter(s => s.hasAlert)
            .map(s => (
              <div key={s.symbol} className="card-animate">
                <WishlistCard stock={s} onRemove={handleRemove} />
              </div>
            ))}
          {/* Divider if we have both */}
          {stocks.some(s => s.hasAlert) && stocks.some(s => !s.hasAlert) && (
            <div className="flex items-center gap-3 py-1">
              <div className="flex-1 h-px bg-oracle-border/30" />
              <span className="text-[9px] text-oracle-muted/50 uppercase tracking-wider">No active setups</span>
              <div className="flex-1 h-px bg-oracle-border/30" />
            </div>
          )}
          {/* Stocks WITHOUT alerts */}
          {stocks
            .filter(s => !s.hasAlert)
            .map(s => (
              <div key={s.symbol} className="card-animate">
                <WishlistCard stock={s} onRemove={handleRemove} />
              </div>
            ))}
        </div>
      )}

      {/* Footer tip */}
      {wishlist.length > 0 && (
        <div className="mt-5 p-3 glass-inner rounded-xl">
          <div className="flex items-start gap-2">
            <Bell size={13} className="text-oracle-accent mt-0.5 shrink-0" />
            <p className="text-oracle-muted text-[10px] leading-relaxed">
              Enable alerts in the menu to get push notifications when any watchlist stock enters a BUY TODAY setup, squeeze, or breakout.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
