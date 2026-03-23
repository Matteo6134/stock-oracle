import { useState, useEffect } from 'react';
import { Globe, RefreshCw, TrendingUp, AlertCircle } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '';

function MarketCard({ market }) {
  const yesWidth = Math.round(market.yesPrice * 100);
  const volStr = market.volume >= 1000000 ? `$${(market.volume / 1000000).toFixed(1)}M` :
                 market.volume >= 1000 ? `$${(market.volume / 1000).toFixed(0)}K` : `$${Math.round(market.volume)}`;

  return (
    <div className="glass-card p-3.5">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-oracle-text text-xs font-semibold leading-tight">{market.question}</div>
          {market.category && (
            <span className="text-[9px] text-purple-400/70 mt-0.5 inline-block">{market.category}</span>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-oracle-green font-bold text-sm">{Math.round(market.yesPrice * 100)}¢</div>
          <div className="text-[9px] text-oracle-muted">Yes</div>
        </div>
      </div>

      {/* Probability bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-2">
        <div className="bg-oracle-green/60 transition-all" style={{ width: `${yesWidth}%` }} />
        <div className="bg-oracle-red/40 flex-1" />
      </div>

      <div className="flex items-center justify-between text-[10px] text-oracle-muted">
        <span>Yes {yesWidth}%</span>
        <span>No {100 - yesWidth}%</span>
        <span>Vol {volStr}</span>
      </div>
    </div>
  );
}

export default function PolyMarkets() {
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMarkets = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/poly/markets?limit=30`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMarkets(data.markets || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMarkets(); }, []);

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Globe size={20} className="text-purple-400" />
            Markets
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">Live Polymarket prediction markets</p>
        </div>
        <button onClick={fetchMarkets} disabled={loading} className="p-2.5 glass-card text-oracle-muted hover:text-purple-400 transition-all active:scale-95 disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="glass-card border-l-4 border-l-oracle-red p-4 mb-4">
          <div className="flex items-center gap-2 text-oracle-red text-sm font-semibold"><AlertCircle size={16} /> Error</div>
          <p className="text-oracle-muted text-xs mt-1">{error}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="glass-card p-4 animate-pulse">
              <div className="h-3 bg-white/5 rounded w-3/4 mb-2" />
              <div className="h-2 bg-white/5 rounded w-1/2" />
            </div>
          ))}
        </div>
      )}

      {!loading && markets.length > 0 && (
        <div className="space-y-2">
          {markets.map((m, i) => (
            <MarketCard key={m.id || i} market={m} />
          ))}
        </div>
      )}

      {!loading && markets.length === 0 && !error && (
        <div className="py-16 text-center">
          <Globe size={48} className="text-oracle-muted/20 mx-auto mb-4" />
          <p className="text-oracle-muted text-sm">No markets available</p>
        </div>
      )}
    </div>
  );
}
