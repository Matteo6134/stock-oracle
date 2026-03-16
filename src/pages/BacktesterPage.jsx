import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, ArrowDownRight, History as HistoryIcon,
  CheckCircle2, XCircle, MinusCircle, Clock, RefreshCw, Trophy,
  TrendingUp, Zap, AlertCircle, ArrowRight, ChevronLeft, ChevronRight
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

function PerformanceTrendChart({ days }) {
  if (!days || days.length < 2) return null;

  // Process data for Recharts (chronological order)
  const chartData = [...days]
    .filter(d => d.dayStats?.total > 0)
    .reverse()
    .map(d => ({
      date: new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      winRate: d.dayStats.winRate || 0,
      avgPl: d.dayStats.avgPl || 0,
    }));

  return (
    <div className="glass-card p-4 mb-4">
      <h3 className="text-xs text-oracle-muted font-bold uppercase mb-4 flex items-center gap-2">
        <TrendingUp size={14} className="text-oracle-accent" />
        Accuracy Evolution
      </h3>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.1)" vertical={false} />
            <XAxis 
              dataKey="date" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: '#94a3b8', fontSize: 10 }} 
              minTickGap={20}
            />
            <YAxis 
              yAxisId="left"
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: '#94a3b8', fontSize: 10 }} 
              domain={[0, 100]}
              hide
            />
            <YAxis 
              yAxisId="right"
              orientation="right"
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: '#94a3b8', fontSize: 10 }}
              hide
            />
            <Tooltip
              contentStyle={{ 
                backgroundColor: 'rgba(15, 23, 42, 0.9)', 
                borderColor: 'rgba(148, 163, 184, 0.2)',
                borderRadius: '8px',
                fontSize: '10px'
              }}
              itemStyle={{ fontSize: '10px', padding: '2px 0' }}
            />
            <Line 
              yAxisId="left"
              type="monotone" 
              dataKey="winRate" 
              name="Win Rate %"
              stroke="#10b981" 
              strokeWidth={3} 
              dot={{ fill: '#10b981', r: 4 }}
              activeDot={{ r: 6, stroke: 'white', strokeWidth: 2 }}
            />
            <Line 
              yAxisId="right"
              type="monotone" 
              dataKey="avgPl" 
              name="Avg P/L %"
              stroke="#6366f1" 
              strokeWidth={2} 
              strokeDasharray="5 5"
              dot={{ fill: '#6366f1', r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center justify-center gap-4 mt-2">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-[#10b981]" />
          <span className="text-[10px] text-oracle-muted font-bold">Win Rate %</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-[#6366f1]" />
          <span className="text-[10px] text-oracle-muted font-bold">Avg P/L %</span>
        </div>
      </div>
    </div>
  );
}

function WinRateRing({ rate, size = 50 }) {
  const radius = size * 0.4;
  const stroke = size * 0.1;
  const normalizedRadius = radius - stroke * 2;
  const circumference = normalizedRadius * 2 * Math.PI;
  const strokeDashoffset = circumference - (rate / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg height={size} width={size} className="transform -rotate-90">
        <circle
          stroke="rgba(148, 163, 184, 0.1)"
          fill="transparent"
          strokeWidth={stroke}
          r={normalizedRadius}
          cx={size / 2}
          cy={size / 2}
        />
        <circle
          stroke={rate >= 55 ? '#10b981' : rate >= 45 ? '#f59e0b' : '#ef4444'}
          fill="transparent"
          strokeWidth={stroke}
          strokeDasharray={circumference + ' ' + circumference}
          style={{ strokeDashoffset }}
          strokeLinecap="round"
          r={normalizedRadius}
          cx={size / 2}
          cy={size / 2}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center flex-col">
        <span className="text-[14px] font-black text-oracle-text leading-none">{rate}%</span>
        {rate >= 60 && <Trophy size={8} className="text-oracle-accent mt-0.5" />}
      </div>
    </div>
  );
}

function PickCard({ pick, onClick }) {
  const isSettled = pick.status === 'settled';
  const isCorrect = pick.verdict === 'correct';
  const isWrong = pick.verdict === 'wrong';

  return (
    <div 
      onClick={onClick}
      className={`glass-card p-3 mb-2 flex items-center justify-between hover:bg-white/[0.04] transition-all cursor-pointer border-l-2 ${
        isCorrect ? 'border-oracle-green' : isWrong ? 'border-oracle-red' : 'border-oracle-muted/20'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-1.5 rounded-lg ${isCorrect ? 'bg-oracle-green/10 text-oracle-green' : isWrong ? 'bg-oracle-red/10 text-oracle-red' : 'bg-oracle-muted/10 text-oracle-muted'}`}>
          {isCorrect ? <CheckCircle2 size={16} /> : isWrong ? <XCircle size={16} /> : <MinusCircle size={16} />}
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-oracle-text">{pick.symbol}</span>
            <span className="text-[10px] text-oracle-muted px-1 border border-oracle-muted/20 rounded uppercase">{pick.status}</span>
          </div>
          <p className="text-[10px] text-oracle-muted truncate max-w-[150px]">{pick.name}</p>
        </div>
      </div>
      
      <div className="text-right">
        <div className={`text-sm font-bold ${pick.plPercent >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
          {pick.plPercent >= 0 ? '+' : ''}{pick.plPercent}%
        </div>
        <div className="text-[9px] text-oracle-muted flex items-center justify-end gap-1">
          <span>${pick.entryPrice}</span>
          <ArrowRight size={8} />
          <span>${pick.currentPrice || pick.nextDayClose}</span>
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
            Proof: entry price vs session move
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

      {/* Accuracy Trend Chart */}
      <PerformanceTrendChart days={days} />

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

      {/* Factor Accuracy & Confidence Breakdown */}
      {overall.factorAccuracy && Object.keys(overall.factorAccuracy).length > 0 && (
        <div className="glass-card p-4 mb-4">
          <div className="text-[10px] text-oracle-muted uppercase font-bold mb-2">Factor Win Rates</div>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(overall.factorAccuracy).map(([factor, data]) => (
              <div key={factor} className="glass-inner rounded-lg p-2 text-center">
                <div className={`text-sm font-bold ${data.winRate >= 55 ? 'text-oracle-green' : data.winRate >= 45 ? 'text-oracle-yellow' : 'text-oracle-red'}`}>
                  {data.winRate ?? '—'}%
                </div>
                <div className="text-[9px] text-oracle-muted capitalize">{factor.replace(/([A-Z])/g, ' $1').trim()}</div>
                <div className="text-[8px] text-oracle-muted/60">n={data.sampleSize}</div>
              </div>
            ))}
          </div>
          {overall.byConfidence && (
            <div className="mt-3 flex gap-2">
              {['HIGH', 'MEDIUM', 'LOW'].map(level => {
                const d = overall.byConfidence[level]
                if (!d || d.total === 0) return null
                const color = level === 'HIGH' ? 'text-oracle-green' : level === 'MEDIUM' ? 'text-oracle-yellow' : 'text-oracle-red'
                return (
                  <div key={level} className="flex-1 glass-inner rounded-lg p-2 text-center">
                    <div className={`text-sm font-bold ${color}`}>{d.winRate ?? '—'}%</div>
                    <div className="text-[9px] text-oracle-muted">{level} ({d.total})</div>
                  </div>
                )
              })}
            </div>
          )}
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
              title={`${p.symbol}: ${p.plPercent}% (${p.settlingSource || 'Daily close'})`}
            />
          ))}
        </div>
      )}

      {/* Evolution Note */}
      <div className="p-3 glass-card border-l-4 border-l-oracle-accent mb-4">
        <p className="text-[10px] text-oracle-muted leading-relaxed">
          <Zap size={10} className="inline mr-1 text-oracle-accent" />
          <strong>Evolution Logic:</strong> This history updates in real-time. As the app stays online, it learns your preferred symbols and tracks performance across Pre-market, Regular sessions, and After-hours.
        </p>
      </div>

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
