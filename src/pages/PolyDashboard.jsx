import { useState, useEffect, useCallback } from 'react';
import {
  Target, RefreshCw, TrendingUp, TrendingDown, Brain,
  DollarSign, Trophy, AlertCircle, Zap, ChevronDown
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '';

function GoalTracker({ portfolio }) {
  const pct = portfolio.goalPct || 0;
  const barWidth = Math.min(100, pct);

  return (
    <div className="glass-card p-4 mb-4 border border-purple-500/20">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-oracle-muted uppercase font-bold">$400K Goal</div>
        <div className="text-purple-400 text-xs font-bold">{pct.toFixed(1)}%</div>
      </div>
      <div className="h-3 bg-white/5 rounded-full overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-purple-600 to-purple-400 transition-all"
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-oracle-muted">
        <span>$1,400</span>
        <span className="text-oracle-text font-bold">${portfolio.totalValue?.toLocaleString()}</span>
        <span>$400,000</span>
      </div>
    </div>
  );
}

function PositionCard({ pos }) {
  const unrealPnl = (pos.currentPrice - pos.entryPrice) * pos.shares;
  const unrealPct = pos.entryPrice > 0 ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100) : 0;
  const isUp = unrealPnl >= 0;

  return (
    <div className={`glass-card p-3 border-l-3 ${isUp ? 'border-l-oracle-green' : 'border-l-oracle-red'}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <div className="text-oracle-text text-xs font-semibold leading-tight">{pos.question}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${pos.outcome === 'Yes' ? 'bg-oracle-green/15 text-oracle-green' : 'bg-oracle-red/15 text-oracle-red'}`}>
              {pos.outcome}
            </span>
            <span className="text-oracle-muted text-[10px]">{Math.round(pos.entryPrice * 100)}¢ → {Math.round(pos.currentPrice * 100)}¢</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-sm font-bold ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {isUp ? '+' : ''}${unrealPnl.toFixed(2)}
          </div>
          <div className="text-[10px] text-oracle-muted">${pos.amount}</div>
        </div>
      </div>
      {pos.claudeThesis && (
        <div className="text-[10px] text-oracle-muted/70 mt-1 leading-tight">
          🧠 {pos.claudeThesis.slice(0, 100)}...
        </div>
      )}
    </div>
  );
}

function PickCard({ pick }) {
  const isYes = pick.action === 'BET_YES';
  const edgeColor = Math.abs(pick.edge) >= 20 ? 'text-oracle-green' : 'text-oracle-yellow';

  return (
    <div className="glass-card p-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <div className="text-oracle-text text-xs font-semibold leading-tight">{pick.question?.slice(0, 70)}</div>
        </div>
        <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold shrink-0 ${isYes ? 'bg-oracle-green/15 text-oracle-green' : 'bg-oracle-red/15 text-oracle-red'}`}>
          {isYes ? 'BET YES' : 'BET NO'}
        </span>
      </div>
      <div className="flex items-center gap-3 text-[10px] mb-1.5">
        <span className="text-oracle-muted">Market: {Math.round(pick.marketYesPrice * 100)}¢</span>
        <span className="text-purple-400">Claude: {Math.round(pick.realProbability * 100)}%</span>
        <span className={`font-bold ${edgeColor}`}>Edge: {pick.edge > 0 ? '+' : ''}{pick.edge}%</span>
        <span className="text-oracle-muted">{'●'.repeat(Math.min(pick.confidence, 10))} {pick.confidence}/10</span>
      </div>
      <div className="text-[10px] text-oracle-muted/70 leading-tight">🧠 {pick.thesis?.slice(0, 120)}</div>
    </div>
  );
}

export default function PolyDashboard() {
  const [portfolio, setPortfolio] = useState(null);
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [portRes, pickRes] = await Promise.all([
        fetch(`${API_BASE}/api/poly/portfolio`),
        fetch(`${API_BASE}/api/poly/brain`),
      ]);
      if (portRes.ok) setPortfolio(await portRes.json());
      if (pickRes.ok) {
        const d = await pickRes.json();
        setPicks(d.picks || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const p = portfolio || { totalValue: 1400, pnl: 0, pnlPct: 0, goalPct: 0.35, multiplier: 1, winRate: 0, tradeCount: 0, openPositions: [] };

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Target size={20} className="text-purple-400" />
            Polymarket Oracle
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">AI-powered prediction market trading</p>
        </div>
        <button onClick={fetchData} disabled={loading} className="p-2.5 glass-card text-oracle-muted hover:text-purple-400 transition-all active:scale-95 disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Goal Tracker */}
      <GoalTracker portfolio={p} />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="glass-card p-2 text-center">
          <div className="text-purple-400 font-black text-lg">${p.totalValue?.toLocaleString()}</div>
          <div className="text-[9px] text-oracle-muted">Portfolio</div>
        </div>
        <div className="glass-card p-2 text-center">
          <div className={`font-black text-lg ${p.pnl >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {p.pnl >= 0 ? '+' : ''}{p.pnlPct}%
          </div>
          <div className="text-[9px] text-oracle-muted">P&L</div>
        </div>
        <div className="glass-card p-2 text-center">
          <div className="text-oracle-text font-black text-lg">{p.multiplier}x</div>
          <div className="text-[9px] text-oracle-muted">Multiplier</div>
        </div>
        <div className="glass-card p-2 text-center">
          <div className="text-oracle-text font-black text-lg">{p.winRate}%</div>
          <div className="text-[9px] text-oracle-muted">Win Rate</div>
        </div>
      </div>

      {/* Claude's Top Picks */}
      {picks.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Brain size={14} className="text-purple-400" />
            <span className="text-sm font-semibold text-oracle-text">Claude's Best Bets</span>
            <span className="text-[9px] text-oracle-muted bg-purple-500/10 px-1.5 py-0.5 rounded">EDGE FOUND</span>
          </div>
          <div className="space-y-2">
            {picks.slice(0, 5).map((pick, i) => (
              <PickCard key={pick.marketId || i} pick={pick} />
            ))}
          </div>
        </div>
      )}

      {picks.length === 0 && !loading && (
        <div className="glass-card p-6 mb-4 text-center">
          <Brain size={32} className="text-oracle-muted/30 mx-auto mb-2" />
          <p className="text-oracle-muted text-sm">No edge found yet</p>
          <p className="text-oracle-muted/60 text-xs mt-1">Claude scans every 30 min for mispriced markets</p>
        </div>
      )}

      {/* Open Positions */}
      {p.openPositions?.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign size={14} className="text-oracle-accent" />
            <span className="text-sm font-semibold text-oracle-text">Open Positions ({p.openPositions.length})</span>
          </div>
          <div className="space-y-2">
            {p.openPositions.map(pos => (
              <PositionCard key={pos.id} pos={pos} />
            ))}
          </div>
        </div>
      )}

      {/* Info */}
      <div className="glass-card p-3 border border-purple-500/10">
        <p className="text-[9px] text-oracle-muted/50 leading-relaxed">
          🎯 Simulation mode — virtual $1,400 portfolio. Claude finds markets where the crowd is wrong (edge ≥10%), bets using Kelly criterion sizing. Auto-bets on confidence ≥8 picks every 30 min.
        </p>
      </div>
    </div>
  );
}
