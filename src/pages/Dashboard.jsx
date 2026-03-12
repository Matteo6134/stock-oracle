import { BarChart3, AlertCircle } from 'lucide-react'
import Header from '../components/Header'
import StockCard from '../components/StockCard'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { usePredictions } from '../hooks/useStocks'

export default function Dashboard() {
  const { stocks, loading, error, refresh } = usePredictions()

  return (
    <div className="max-w-lg mx-auto">
      <Header onRefresh={refresh} loading={loading} />

      {/* Section title */}
      <div className="px-4 py-3 flex items-center gap-2">
        <BarChart3 size={16} className="text-oracle-accent" />
        <h2 className="text-sm font-semibold text-oracle-text">Top 10 Picks Today</h2>
        {!loading && stocks.length > 0 && (
          <span className="text-oracle-muted text-xs ml-auto">{stocks.length} stocks</span>
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
      {!loading && !error && stocks.length > 0 && (
        <div className="space-y-2.5 px-4 pb-4">
          {stocks.map((stock, index) => (
            <StockCard key={stock.symbol} stock={stock} rank={index + 1} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && stocks.length === 0 && (
        <div className="px-4 py-12 text-center">
          <BarChart3 size={48} className="text-oracle-muted mx-auto mb-3" />
          <p className="text-oracle-muted text-sm">No predictions available yet.</p>
          <p className="text-oracle-muted text-xs mt-1">Check back later or try refreshing.</p>
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
