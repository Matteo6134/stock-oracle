import { CalendarDays, AlertCircle, RefreshCw, Zap, ShoppingCart, Clock } from 'lucide-react'
import StockCard from '../components/StockCard'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { useTomorrow } from '../hooks/useStocks'

export default function TomorrowPage() {
  const { stocks, tomorrowDate, loading, error, refresh, lastUpdated } = useTomorrow()

  const formattedDate = tomorrowDate
    ? new Date(tomorrowDate + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      })
    : 'Tomorrow'

  const updatedAgo = lastUpdated
    ? `${Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000)}m ago`
    : null

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <CalendarDays className="text-oracle-accent" size={22} />
            Tomorrow's Plays
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">
            Buy today to position for {formattedDate}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {updatedAgo && (
            <span className="text-oracle-muted text-[10px] flex items-center gap-0.5">
              <Clock size={9} /> {updatedAgo}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Action banner */}
      {!loading && stocks.length > 0 && (
        <div className="p-3 glass-card border-l-4 border-l-oracle-accent mb-4 flex items-center gap-2">
          <ShoppingCart size={16} className="text-oracle-accent shrink-0" />
          <div>
            <div className="text-oracle-accent text-sm font-bold">Position Before the Move</div>
            <div className="text-oracle-muted text-xs">
              These stocks have catalysts on {formattedDate}. Consider buying today.
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="p-4 glass-card border-l-4 border-l-oracle-red mb-4">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">Failed to load tomorrow picks</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button onClick={refresh}
            className="px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors">
            Try Again
          </button>
        </div>
      )}

      {loading && <LoadingSkeleton count={8} />}

      {/* Stock list with reasons */}
      {!loading && !error && stocks.length > 0 && (
        <div className="space-y-2.5">
          {stocks.map((stock, index) => (
            <div key={stock.symbol}>
              <StockCard stock={stock} rank={index + 1} />
              {stock.reason && (
                <div className="ml-3 mt-1 mb-1 px-3 py-1.5 glass-inner border-l-2 border-oracle-accent rounded-r-lg">
                  <p className="text-oracle-muted text-xs leading-relaxed">
                    <Zap size={10} className="inline text-oracle-accent mr-1" />
                    {stock.reason}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && stocks.length === 0 && (
        <div className="py-12 text-center">
          <CalendarDays size={48} className="text-oracle-muted mx-auto mb-3" />
          <p className="text-oracle-muted text-sm">No catalysts found for tomorrow yet.</p>
          <p className="text-oracle-muted text-xs mt-1">
            The earnings calendar updates throughout the day. Try refreshing later.
          </p>
          <button onClick={refresh}
            className="mt-4 px-4 py-2 bg-oracle-accent text-white text-sm rounded-lg hover:bg-oracle-accent/80 transition-colors">
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}
