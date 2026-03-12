import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, ArrowDownRight, History as HistoryIcon,
  CheckCircle2, XCircle, MinusCircle, Clock, RefreshCw, Trophy,
  TrendingUp, Zap, AlertCircle, ArrowRight, ChevronLeft, ChevronRight
} from 'lucide-react';

function WinRateRing({ rate, size = 90 }) {
  if (rate === null || rate === undefined) return null;
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = (rate / 100) * circumference;
  const color = rate >= 60 ? '#10b981' : rate >= 45 ? '#eab308' : '#ef4444';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="rgba(148, 163, 184, 0.1)" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={radius} fill="none"
          stroke={color} strokeWidth={5} strokeLinecap="round"
          strokeDasharray={`${strokeDash} ${circumference}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-black text-2xl text-oracle-text">{rate}%</span>
        <span className="text-[9px] text-oracle-muted uppercase font-bold">Win Rate</span>
      </div>
    </div>
  );
}

function PickCard({ pick, onClick }) {
  const isSettled = pick.status === 'settled';
  const isLive = pick.status === 'live';

  const borderClass = pick.verdict === 'correct'
    ? 'border-l-oracle-green'
    : pick.verdict === 'wrong'
      ? 'border-l-oracle-red'
      : 'border-l-oracle-border';

  return (
    <div
      onClick={onClick}
      className={`glass-card p-3 cursor-pointer transition-all duration-300 active:scale-[0.98] hover:bg-white/[0.03] border-l-4 ${borderClass}`}
    >
      {/* Row 1: Symbol + Verdict */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-oracle-text text-sm">{pick.symbol}</span>
          <span className="text-xs text-oracle-muted truncate">{pick.name}</span>
        </div>
        {isLive && (
          <span className="flex items-center gap-0.5 text-oracle-accent text-[10px] font-bold shrink-0">
            <Clock size={9} className="animate-pulse" /> LIVE
          </span>
        )}
        {isSettled && pick.verdict === 'correct' && (
          <span className="flex items-center gap-0.5 text-oracle-green text-[10px] font-bold shrink-0">
            <CheckCircle2 size={10} /> RIGHT
          </span>
        )}
        {isSettled && pick.verdict === 'wrong' && (
          <span className="flex items-center gap-0.5 text-oracle-red text-[10px] font-bold shrink-0">
            <XCircle size={10} /> WRONG
          </span>
        )}
        {isSettled && pick.verdict === 'flat' && (
          <span className="flex items-center gap-0.5 text-oracle-muted text-[10px] font-bold shrink-0">
            <MinusCircle size={10} /> FLAT
          </span>
        )}
        {pick.status === 'pending' && (
          <span className="flex items-center gap-0.5 text-oracle-muted text-[10px] font-bold shrink-0">
            <Clock size={9} /> PENDING
          </span>
        )}
      </div>

      {/* Row 2: Price proof */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[9px] text-oracle-muted uppercase font-bold">Buy @</div>
          <div className="text-sm font-mono font-semibold text-oracle-text">
            ${pick.entryPrice > 0 ? pick.entryPrice.toFixed(2) : '—'}
          </div>
        </div>

        <ArrowRight size={10} className="text-oracle-muted shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="text-[9px] text-oracle-muted uppercase font-bold">
            {isLive ? 'Now' : isSettled ? 'Next Day' : 'Current'}
          </div>
          <div className="text-sm font-mono font-semibold text-oracle-text">
            ${isSettled && pick.nextDayClose
              ? pick.nextDayClose.toFixed(2)
              : pick.currentPrice > 0 ? pick.currentPrice.toFixed(2) : '—'
            }
          </div>
        </div>

        {/* P/L */}
        <div className={`px-2 py-1 rounded-lg border min-w-[65px] text-right ${
          pick.plPercent > 0
            ? 'bg-oracle-green/5 border-oracle-green/20'
            : pick.plPercent < 0
              ? 'bg-oracle-red/5 border-oracle-red/20'
              : 'bg-oracle-muted/5 border-oracle-muted/20'
        }`}>
          <div className={`flex items-center justify-end gap-0.5 font-black text-sm ${
            pick.plPercent > 0 ? 'text-oracle-green' : pick.plPercent < 0 ? 'text-oracle-red' : 'text-oracle-muted'
          }`}>
            {pick.plPercent > 0 ? <ArrowUpRight size={12} /> : pick.plPercent < 0 ? <ArrowDownRight size={12} /> : null}
            {pick.plPercent > 0 ? '+' : ''}{pick.plPercent.toFixed(2)}%
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BacktesterPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);
  const navigate = useNavigate();

  const fetchHistory = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/history');
      if (!response.ok) throw new Error('Failed to fetch history');
      const result = await response.json();
      setData(result);
      // Default to first past day (skip today if it exists)
      const days = result?.days || [];
      const firstPastIdx = days.findIndex(d => !d.isToday);
      setSelectedDayIdx(firstPastIdx >= 0 ? firstPastIdx : 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHistory(); }, []);

  if (loading) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] text-oracle-muted">
        <HistoryIcon className="animate-spin mb-4" size={48} />
        <p className="text-sm">Checking prediction accuracy...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center">
        <AlertCircle className="mx-auto mb-2 text-oracle-red" size={32} />
        <p className="text-oracle-red text-sm">{error}</p>
        <button onClick={fetchHistory} className="mt-4 px-4 py-2 bg-oracle-accent text-white rounded-lg text-sm">
          Retry
        </button>
      </div>
    );
  }

  const days = data?.days || [];
  const overall = data?.overall || {};

  if (days.length === 0) {
    return (
      <div className="p-8 text-center glass-card mx-4 mt-8">
        <HistoryIcon className="mx-auto mb-4 text-oracle-muted" size={48} />
        <h2 className="text-xl font-bold text-oracle-text mb-2">No history yet</h2>
        <p className="text-oracle-muted text-sm">
          Go to Home or Tomorrow to generate picks. Come back tomorrow to see results!
        </p>
      </div>
    );
  }

  const selectedDay = days[selectedDayIdx];
  // Merge all categories into one flat list for simplicity
  const allPicks = selectedDay
    ? selectedDay.categories.flatMap(c => c.picks)
    : [];
  // Sort: settled first (by P/L desc), then live, then pending
  const sortedPicks = [...allPicks].sort((a, b) => {
    const statusOrder = { settled: 0, live: 1, pending: 2 };
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return b.plPercent - a.plPercent;
  });

  const dateObj = selectedDay ? new Date(selectedDay.date + 'T12:00:00') : null;
  const dayLabel = selectedDay?.isToday ? 'Today' : dateObj?.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });

  // Day stats
  const settled = sortedPicks.filter(p => p.status === 'settled');
  const correct = settled.filter(p => p.verdict === 'correct').length;
  const wrong = settled.filter(p => p.verdict === 'wrong').length;
  const dayWinRate = settled.length > 0 ? Math.round((correct / settled.length) * 100) : null;
  const dayAvgPl = settled.length > 0
    ? Math.round(settled.reduce((s, p) => s + p.plPercent, 0) / settled.length * 100) / 100
    : null;

  const canGoBack = selectedDayIdx < days.length - 1;
  const canGoForward = selectedDayIdx > 0;

  return (
    <div className="px-4 pt-1 pb-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-oracle-text flex items-center gap-2">
            <HistoryIcon size={18} className="text-oracle-accent" />
            Was the AI Right?
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">
            Proof: entry price vs next-day close
          </p>
        </div>
        <button
          onClick={fetchHistory}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Overall Stats (compact) */}
      {overall.totalPicks > 0 && (
        <div className="glass-card p-4 mb-4 flex items-center justify-between">
          <div>
            <div className="text-[10px] text-oracle-muted uppercase font-bold mb-1">All-Time Record</div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <Trophy size={12} className="text-oracle-accent" />
                <span className="text-oracle-text text-sm font-bold">{overall.totalCorrect}/{overall.totalPicks}</span>
              </div>
              <div className={`text-sm font-bold ${overall.avgPl >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
                {overall.avgPl >= 0 ? '+' : ''}{overall.avgPl}% avg
              </div>
              <span className="text-oracle-muted text-xs">{overall.totalDays}d</span>
            </div>
          </div>
          <WinRateRing rate={overall.winRate} size={60} />
        </div>
      )}

      {/* Day Selector - simple prev/next */}
      <div className="flex items-center justify-between glass-card px-3 py-2 mb-4">
        <button
          onClick={() => setSelectedDayIdx(i => Math.min(i + 1, days.length - 1))}
          disabled={!canGoBack}
          className="p-1.5 rounded-lg text-oracle-muted hover:text-oracle-text disabled:opacity-30 transition-colors"
        >
          <ChevronLeft size={18} />
        </button>

        <div className="text-center">
          <div className="text-oracle-text font-bold text-sm">{dayLabel}</div>
          {selectedDay?.isToday ? (
            <div className="text-oracle-accent text-[10px] font-bold animate-pulse">Running now</div>
          ) : dayWinRate !== null ? (
            <div className={`text-[10px] font-bold ${dayWinRate >= 50 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {correct}/{settled.length} correct &middot; {dayWinRate}% win rate
            </div>
          ) : (
            <div className="text-oracle-muted text-[10px]">{sortedPicks.length} picks</div>
          )}
        </div>

        <button
          onClick={() => setSelectedDayIdx(i => Math.max(i - 1, 0))}
          disabled={!canGoForward}
          className="p-1.5 rounded-lg text-oracle-muted hover:text-oracle-text disabled:opacity-30 transition-colors"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Day summary bar (visual) */}
      {settled.length > 0 && (
        <div className="flex gap-1 mb-4 h-2 rounded-full overflow-hidden">
          {settled.map((p, i) => (
            <div
              key={i}
              className={`flex-1 rounded-full ${
                p.verdict === 'correct' ? 'bg-oracle-green' : p.verdict === 'wrong' ? 'bg-oracle-red' : 'bg-oracle-muted/30'
              }`}
            />
          ))}
        </div>
      )}

      {/* Picks list */}
      <div className="space-y-2">
        {sortedPicks.map((pick, i) => (
          <PickCard
            key={`${selectedDay.date}-${pick.symbol}-${i}`}
            pick={pick}
            onClick={() => navigate(`/stock/${pick.symbol}`)}
          />
        ))}
      </div>

      {sortedPicks.length === 0 && (
        <div className="py-12 text-center text-oracle-muted text-sm">
          No picks recorded for this day.
        </div>
      )}
    </div>
  );
}
