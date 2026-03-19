import { useNavigate } from 'react-router-dom'
import { TrendingUp, TrendingDown, AlertCircle, RefreshCw, Newspaper, Flame } from 'lucide-react'
import { useTrending } from '../hooks/useStocks'
import LoadingSkeleton from '../components/LoadingSkeleton'

function TrendingStockRow({ stock }) {
  const navigate = useNavigate()
  const { symbol, name, sources = [], count = 0 } = stock

  return (
    <div
      onClick={() => navigate(`/stock/${symbol}`)}
      className="flex items-center gap-3 p-3 glass-card cursor-pointer hover:bg-white/[0.03] transition-all duration-300 active:scale-[0.98]"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-oracle-text font-bold text-sm">{symbol}</span>
          {count > 1 && (
            <span className="flex items-center gap-0.5 text-oracle-yellow text-[10px]">
              <Flame size={10} />{count}
            </span>
          )}
        </div>
        {name && <p className="text-oracle-muted text-xs truncate">{name}</p>}
        {sources.length > 0 && (
          <div className="flex gap-1 mt-1">
            {sources.map(s => (
              <span key={s} className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-oracle-accent/10 text-oracle-accent border border-oracle-accent/20">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
      <TrendingUp size={16} className="text-oracle-green shrink-0" />
    </div>
  )
}

function NewsCard({ article }) {
  return (
    <a
      href={article.url || article.link || '#'}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-3 glass-card hover:bg-white/[0.03] transition-all duration-300"
    >
      <p className="text-oracle-text text-sm font-medium leading-snug line-clamp-2">
        {article.title}
      </p>
      <div className="flex items-center gap-2 mt-2">
        {article.source && (
          <span className="text-oracle-accent text-xs">{article.source}</span>
        )}
        {article.publishedAt && (
          <span className="text-oracle-muted text-xs">
            {(() => {
              const d = new Date(article.publishedAt)
              const diff = Date.now() - d.getTime()
              if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
              if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
              return `${Math.round(diff / 86400000)}d ago`
            })()}
          </span>
        )}
      </div>
    </a>
  )
}

export default function TrendingPage() {
  const { trending, news, loading, error, refresh } = useTrending()

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Flame className="text-oracle-yellow" size={22} />
            Trending Stocks
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">Most mentioned and active today</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="p-4 glass-card border-l-4 border-l-oracle-red mb-4">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">Failed to load trending</span>
          </div>
          <p className="text-oracle-muted text-xs mb-3">{error}</p>
          <button
            onClick={refresh}
            className="px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && <LoadingSkeleton count={8} />}

      {/* Trending stocks list */}
      {!loading && !error && trending.length > 0 && (
        <div className="space-y-2 mb-6">
          {trending.map((stock) => (
            <TrendingStockRow key={stock.symbol} stock={stock} />
          ))}
        </div>
      )}

      {!loading && !error && trending.length === 0 && (
        <div className="py-8 text-center mb-6">
          <TrendingUp size={40} className="text-oracle-muted mx-auto mb-2" />
          <p className="text-oracle-muted text-sm">No trending data available.</p>
        </div>
      )}

      {/* Market News section */}
      {!loading && news.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-oracle-text flex items-center gap-2 mb-3">
            <Newspaper size={14} className="text-oracle-accent" />
            Market News
          </h2>
          <div className="space-y-2">
            {news.map((article, i) => (
              <NewsCard key={i} article={article} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
