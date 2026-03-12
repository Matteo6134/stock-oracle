import { useNavigate } from 'react-router-dom'
import { AlertCircle, TrendingUp, TrendingDown, Minus, RefreshCw, Zap, Cpu, Heart, ShoppingCart, Banknote, Factory, Fuel, Building2, Wifi, Pill, ChevronRight, Loader2 } from 'lucide-react'
import { useSectors } from '../hooks/useStocks'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { useState } from 'react' // Added useState import

const sectorIcons = {
  technology: Cpu,
  tech: Cpu,
  healthcare: Heart,
  health: Heart,
  'consumer cyclical': ShoppingCart,
  consumer: ShoppingCart,
  'consumer defensive': ShoppingCart,
  financial: Banknote,
  financials: Banknote,
  finance: Banknote,
  industrials: Factory,
  industrial: Factory,
  energy: Fuel,
  'real estate': Building2,
  'communication services': Wifi,
  communication: Wifi,
  utilities: Zap,
  materials: Factory,
  'basic materials': Factory,
  pharmaceutical: Pill,
}

function getSectorIcon(sectorName) {
  const lower = (sectorName || '').toLowerCase()
  for (const [key, Icon] of Object.entries(sectorIcons)) {
    if (lower.includes(key)) return Icon
  }
  return Zap
}

function getTrendInfo(trend) {
  const lower = (trend || '').toLowerCase()
  if (lower === 'bullish' || lower === 'up' || lower === 'positive') {
    return {
      icon: TrendingUp,
      label: 'Bullish',
      textColor: 'text-oracle-green',
      bgColor: 'bg-oracle-green/10',
      borderColor: 'border-oracle-green/30',
    }
  }
  if (lower === 'bearish' || lower === 'down' || lower === 'negative') {
    return {
      icon: TrendingDown,
      label: 'Bearish',
      textColor: 'text-oracle-red',
      bgColor: 'bg-oracle-red/10',
      borderColor: 'border-oracle-red/30',
    }
  }
  return {
    icon: Minus,
    label: 'Neutral',
    textColor: 'text-oracle-muted',
    bgColor: 'bg-oracle-muted/10',
    borderColor: 'border-oracle-muted/30',
  }
}

function SectorCard({ sector, onClick, isLoading }) {
  const {
    name,
    sector: sectorName,
    trend,
    avgChange = 0,
    topStocks = [],
    stockCount,
  } = sector

  const displayName = name || sectorName || 'Unknown'
  const SectorIcon = getSectorIcon(displayName)
  const trendInfo = getTrendInfo(trend)
  const TrendIcon = trendInfo.icon
  const isPositiveChange = avgChange >= 0

  return (
    <div
      onClick={onClick}
      className={`glass-card p-4 transition-all duration-300 hover:bg-white/[0.03] cursor-pointer active:scale-[0.98] border-l-4 ${trendInfo.borderColor} ${isLoading ? 'opacity-80' : ''}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${trendInfo.bgColor}`}>
            <SectorIcon size={16} className={trendInfo.textColor} />
          </div>
          <div>
            <h3 className="text-oracle-text font-semibold text-sm">{displayName}</h3>
            {stockCount && (
              <span className="text-oracle-muted text-[10px]">{stockCount} stocks</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${trendInfo.bgColor} ${trendInfo.textColor} ${trendInfo.borderColor}`}>
            <TrendIcon size={10} />
            {trendInfo.label}
          </div>
          {isLoading ? (
            <Loader2 size={16} className="text-oracle-muted animate-spin" />
          ) : (
            <ChevronRight size={16} className="text-oracle-muted" />
          )}
        </div>
      </div>

      {/* Average change */}
      <div className="mb-3">
        <span className="text-oracle-muted text-xs">Avg. Change: </span>
        <span className={`text-sm font-bold ${isPositiveChange ? 'text-oracle-green' : 'text-oracle-red'}`}>
          {isPositiveChange ? '+' : ''}{typeof avgChange === 'number' ? avgChange.toFixed(2) : avgChange}%
        </span>
      </div>

      {/* Top stocks */}
      {topStocks.length > 0 && (
        <div>
          <span className="text-oracle-muted text-[10px] font-medium">Top Stocks</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {topStocks.slice(0, 5).map((s) => {
              const tickerName = typeof s === 'string' ? s : s.symbol || s.name
              return (
                <span
                  key={tickerName}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium glass-inner text-oracle-text"
                >
                  {tickerName}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function SectorsPage() {
  const { sectors, loading, error, refresh } = useSectors()
  const navigate = useNavigate()
  const [loadingSector, setLoadingSector] = useState(null)

  const handleSectorClick = (sectorName) => {
    setLoadingSector(sectorName)
    // Small delay so the spinner actually renders before React Router freezes main thread
    setTimeout(() => {
      navigate(`/sectors/${encodeURIComponent(sectorName)}`)
    }, 10)
  }

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-oracle-text">Sector Heatmap</h1>
          <p className="text-oracle-muted text-xs mt-0.5">Market sector trends and analysis</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && !loading && (
        <div className="p-4 glass-card border-l-4 border-l-oracle-red mb-4">
          <div className="flex items-center gap-2 text-oracle-red mb-2">
            <AlertCircle size={16} />
            <span className="text-sm font-medium">Failed to load sectors</span>
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

      {loading && <LoadingSkeleton count={6} />}

      {!loading && !error && sectors.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {sectors.map((sector, i) => {
            const displayName = sector.name || sector.sector || 'Unknown'
            return (
              <SectorCard
                key={displayName + i}
                sector={sector}
                onClick={() => handleSectorClick(displayName)}
                isLoading={loadingSector === displayName}
              />
            )
          })}
        </div>
      )}

      {!loading && !error && sectors.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-oracle-muted text-sm">No sector data available.</p>
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
