import { RefreshCw, Star } from 'lucide-react'

export default function Header({ onRefresh, loading }) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="px-4 pb-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Star className="text-oracle-yellow" size={24} fill="currentColor" />
            <h1 className="text-xl font-bold text-oracle-text">Stock Oracle</h1>
          </div>
          <p className="text-oracle-muted text-xs mt-0.5">AI-Powered Daily Stock Predictions</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent hover:border-oracle-accent/50 transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className="text-oracle-muted text-xs mt-2">{today}</p>
    </div>
  )
}
