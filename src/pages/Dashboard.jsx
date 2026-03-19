import { useState } from 'react'
import { BarChart3, AlertCircle, TrendingUp, TrendingDown, Minus, ShieldAlert, Skull, Search, X } from 'lucide-react'
import Header from '../components/Header'
import StockCard from '../components/StockCard'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { usePredictions } from '../hooks/useStocks'

const regimeConfig = {
  bull: { icon: TrendingUp, label: 'Bull Market', color: 'text-oracle-green', bg: 'bg-oracle-green/10 border-oracle-green/30', desc: 'SPY uptrend — favorable for buys' },
  cautious_bull: { icon: TrendingUp, label: 'Cautious Bull', color: 'text-oracle-yellow', bg: 'bg-oracle-yellow/10 border-oracle-yellow/30', desc: 'SPY recovering — moderate confidence' },
  neutral: { icon: Minus, label: 'Neutral', color: 'text-oracle-muted', bg: 'bg-white/5 border-oracle-border', desc: 'Mixed signals — be selective' },
  cautious_bear: { icon: ShieldAlert, label: 'Cautious', color: 'text-oracle-yellow', bg: 'bg-oracle-yellow/10 border-oracle-yellow/30', desc: 'SPY weakening — only high-confidence picks shown' },
  bear: { icon: TrendingDown, label: 'Bear Market', color: 'text-oracle-red', bg: 'bg-oracle-red/10 border-oracle-red/30', desc: 'SPY downtrend — only best setups shown, consider cash' },
  fear: { icon: Skull, label: 'Extreme Fear', color: 'text-oracle-red', bg: 'bg-oracle-red/20 border-oracle-red/50', desc: 'VIX > 30 — market panic. Only top setups, minimal size. Consider cash.' },
}

const vixColors = {
  low: 'text-oracle-green',
  normal: 'text-oracle-muted',
  elevated: 'text-oracle-yellow',
  high: 'text-oracle-red',
  extreme: 'text-oracle-red',
}

export default function Dashboard() {
  const { stocks, loading, error, refresh, marketRegime } = usePredictions()
  const [searchQuery, setSearchQuery] = useState('')

  const regime = marketRegime?.regime ? regimeConfig[marketRegime.regime] || regimeConfig.neutral : null

  // Filter stocks: only show 10%+ potential gain, then by search
  const gainFiltered = stocks.filter(s => {
    const gain = s.tradeSetup?.potentialGain
    return gain == null || gain >= 10 // keep if no data or 10%+
  })
  const filteredStocks = searchQuery.trim()
    ? gainFiltered.filter(s => {
        const q = searchQuery.toLowerCase()
        return s.symbol?.toLowerCase().includes(q) ||
               (s.companyName || s.name || '').toLowerCase().includes(q) ||
               (s.sector || '').toLowerCase().includes(q)
      })
    : gainFiltered

  return (
    <div className="max-w-lg mx-auto">
      <Header onRefresh={refresh} loading={loading} />

      {/* Market Regime Banner */}
      {regime && marketRegime && (
        <div className={`mx-4 mb-2 p-2.5 rounded-xl border flex items-center gap-2 ${regime.bg}`}>
          <regime.icon size={14} className={regime.color} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-bold ${regime.color}`}>{regime.label}</span>
              <span className="text-[10px] text-oracle-muted">
                SPY ${marketRegime.spyPrice} ({marketRegime.fiveDayReturn >= 0 ? '+' : ''}{marketRegime.fiveDayReturn}% 5d)
              </span>
              {marketRegime.vix != null && (
                <span className={`text-[10px] font-semibold ${vixColors[marketRegime.vixLevel] || 'text-oracle-muted'}`}>
                  VIX {marketRegime.vix}
                </span>
              )}
            </div>
            <p className="text-[10px] text-oracle-muted/70">{regime.desc}</p>
            {marketRegime.complacent && (
              <p className="text-[10px] text-oracle-yellow/80 mt-0.5">VIX very low — market may be complacent, watch for sudden drops</p>
            )}
          </div>
        </div>
      )}

      {/* Search bar */}
      {!loading && filteredStocks.length > 0 && (
        <div className="mx-4 mb-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-oracle-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search symbol, name, or sector..."
              className="w-full pl-8 pr-8 py-2 glass-card text-sm text-oracle-text placeholder-oracle-muted/50 outline-none focus:border-oracle-accent/50 transition-colors"
              style={{ borderRadius: '0.75rem' }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-oracle-muted hover:text-oracle-text"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Section title */}
      <div className="px-4 py-3 flex items-center gap-2">
        <BarChart3 size={16} className="text-oracle-accent" />
        <h2 className="text-sm font-semibold text-oracle-text">Top Picks Today</h2>
        {!loading && filteredStocks.length > 0 && (
          <span className="text-oracle-muted text-xs ml-auto">
            {searchQuery ? `${filteredStocks.length} of ${gainFiltered.length}` : `${filteredStocks.length} stocks`}
          </span>
        )}
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="mx-4 p-4 glass-card border-l-4 border-l-oracle-red">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">Failed to load predictions</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button
            onClick={refresh}
            className="px-4 py-1.5 glass-badge bg-oracle-red/20 text-oracle-red text-xs font-medium hover:bg-oracle-red/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && <LoadingSkeleton count={10} />}

      {/* Stock list */}
      {!loading && !error && filteredStocks.length > 0 && (
        <div className="space-y-2.5 px-4 pb-4">
          {filteredStocks.map((stock, index) => (
            <div key={stock.symbol} className="card-animate">
              <StockCard stock={stock} rank={searchQuery ? undefined : index + 1} />
            </div>
          ))}
        </div>
      )}

      {/* No search results */}
      {!loading && !error && gainFiltered.length > 0 && filteredStocks.length === 0 && searchQuery && (
        <div className="px-4 py-8 text-center">
          <Search size={32} className="text-oracle-muted/30 mx-auto mb-2" />
          <p className="text-oracle-muted text-sm">No stocks match "{searchQuery}"</p>
          <button onClick={() => setSearchQuery('')} className="mt-2 text-oracle-accent text-xs">Clear search</button>
        </div>
      )}

      {/* No explosive stocks today */}
      {!loading && !error && stocks.length > 0 && gainFiltered.length === 0 && (
        <div className="px-4 py-8 text-center">
          <BarChart3 size={32} className="text-oracle-muted/30 mx-auto mb-2" />
          <p className="text-oracle-muted text-sm font-medium">No explosive setups today</p>
          <p className="text-oracle-muted/60 text-xs mt-1">All {stocks.length} stocks have less than 10% upside — check Gem Finder for tomorrow's plays</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && stocks.length === 0 && (
        <div className="px-4 py-12 text-center">
          <BarChart3 size={48} className="text-oracle-muted mx-auto mb-3" />
          {marketRegime?.regime === 'bear' || marketRegime?.regime === 'fear' ? (
            <>
              <p className="text-oracle-red text-sm font-bold">
                {marketRegime.regime === 'fear' ? 'Extreme Fear — Stay in cash' : 'Bear Market — No safe picks today'}
              </p>
              <p className="text-oracle-muted text-xs mt-1">
                {marketRegime.vix ? `VIX at ${marketRegime.vix}. ` : ''}Market conditions are too risky. Consider staying in cash.
              </p>
            </>
          ) : (
            <>
              <p className="text-oracle-muted text-sm">No predictions available yet.</p>
              <p className="text-oracle-muted text-xs mt-1">Check back later or try refreshing.</p>
            </>
          )}
          <button
            onClick={refresh}
            className="mt-4 px-4 py-2 bg-oracle-accent text-white text-sm rounded-lg hover:bg-oracle-accent/80 transition-colors"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}
