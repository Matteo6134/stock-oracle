import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, AlertCircle, RefreshCw, Target, Clock } from 'lucide-react'
import StockCard from '../components/StockCard'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { useSectorDetail } from '../hooks/useStocks'

export default function SectorDetail() {
  const { sectorName } = useParams()
  const navigate = useNavigate()
  const { stocks, sectorInfo, loading, error, refresh, lastUpdated } = useSectorDetail(sectorName)

  const displayName = sectorInfo?.sector || decodeURIComponent(sectorName || '')

  const updatedAgo = lastUpdated
    ? `${Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000)}m ago`
    : null

  return (
    <div className="max-w-lg mx-auto px-4 pt-2 pb-6">
      {/* Back button */}
      <button
        onClick={() => navigate('/sectors')}
        className="flex items-center gap-1 text-oracle-muted text-sm mb-4 hover:text-oracle-text transition-colors"
      >
        <ArrowLeft size={16} /> Sectors
      </button>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-oracle-text">{displayName}</h1>
          <p className="text-oracle-muted text-xs mt-0.5">
            {sectorInfo?.stockCount || 0} stocks analyzed &middot; sorted by score
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

      {/* Error */}
      {error && !loading && (
        <div className="p-4 glass-card border-l-4 border-l-oracle-red mb-4">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">Failed to load sector</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button onClick={refresh}
            className="px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors">
            Try Again
          </button>
        </div>
      )}

      {loading && <LoadingSkeleton count={6} />}

      {/* Stock list with reasons */}
      {!loading && !error && stocks.length > 0 && (
        <div className="space-y-2.5">
          {stocks.map((stock, index) => (
            <div key={stock.symbol}>
              <StockCard stock={stock} rank={index + 1} />
              {stock.reason && (
                <div className="ml-3 mt-1 mb-1 px-3 py-1.5 glass-inner border-l-2 border-oracle-accent rounded-r-lg">
                  <p className="text-oracle-muted text-xs leading-relaxed">
                    <Target size={10} className="inline text-oracle-accent mr-1" />
                    <span className="font-medium text-oracle-text">Why invest: </span>
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
          <p className="text-oracle-muted text-sm">No stock data available for this sector.</p>
          <button onClick={refresh}
            className="mt-4 px-4 py-2 bg-oracle-accent text-white text-sm rounded-lg hover:bg-oracle-accent/80 transition-colors">
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}
