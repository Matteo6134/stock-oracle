import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine
} from 'recharts';
import {
  FlaskConical, TrendingUp, TrendingDown, Search, Trophy,
  AlertCircle, RefreshCw, ChevronDown, Info
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '';

const STRATEGIES = [
  { value: 'gem_finder',    label: 'Gem Finder',     desc: 'Volume surge + uptrend + not overbought' },
  { value: 'volume_surge',  label: 'Volume Surge',   desc: 'Volume 60%+ above avg on a bullish day' },
  { value: 'momentum',      label: 'Momentum',       desc: '20-day breakout on high volume' },
  { value: 'mean_reversion',label: 'Mean Reversion', desc: 'Oversold bounce above 50-day trend' },
];

const YEARS_OPTIONS = [
  { value: 1,  label: '1Y' },
  { value: 2,  label: '2Y' },
  { value: 3,  label: '3Y' },
  { value: 5,  label: '5Y' },
  { value: 10, label: '10Y' },
  { value: 20, label: '20Y' },
  { value: 30, label: 'MAX' },
];

const HOLD_OPTIONS = [
  { value: 1,  label: '1 day' },
  { value: 3,  label: '3 days' },
  { value: 5,  label: '5 days' },
  { value: 10, label: '10 days' },
  { value: 20, label: '20 days' },
];

function fmt(n, dec = 1) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(dec);
}

function StatCard({ label, value, sub, color = '', icon }) {
  return (
    <div className="glass-card p-3 flex flex-col gap-0.5">
      <div className="text-[9px] text-oracle-muted uppercase font-bold tracking-wide flex items-center gap-1">
        {icon && icon}
        {label}
      </div>
      <div className={`text-lg font-black ${color || 'text-oracle-text'}`}>{value}</div>
      {sub && <div className="text-[10px] text-oracle-muted">{sub}</div>}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const strategy = payload.find(p => p.dataKey === 'equity');
  const bh = payload.find(p => p.dataKey === 'bh');
  return (
    <div className="bg-oracle-bg/95 border border-oracle-border rounded-lg p-2 text-[10px]">
      <div className="text-oracle-muted mb-1">{label}</div>
      {strategy && (
        <div className="flex justify-between gap-3">
          <span className="text-oracle-green">Strategy</span>
          <span className="text-oracle-text font-bold">${fmt(strategy.value, 0)}</span>
        </div>
      )}
      {bh && (
        <div className="flex justify-between gap-3">
          <span className="text-oracle-muted">Buy & Hold</span>
          <span className="text-oracle-muted font-bold">${fmt(bh.value, 0)}</span>
        </div>
      )}
    </div>
  );
}

export default function HistoricalBacktestPage() {
  const [symbol, setSymbol] = useState('AAPL');
  const [years, setYears] = useState(10);
  const [holdDays, setHoldDays] = useState(5);
  const [strategy, setStrategy] = useState('gem_finder');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [showTrades, setShowTrades] = useState(false);

  const runBacktest = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/historical-backtest?symbol=${sym}&years=${years}&holdDays=${holdDays}&strategy=${strategy}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const result = await res.json();
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const s = data?.stats;
  const stratLabel = STRATEGIES.find(st => st.value === strategy)?.label || strategy;
  const isWinner = s?.totalReturn > 0;
  const beatBH = s?.beatBH;
  const curveColor = isWinner ? '#10b981' : '#ef4444';

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-10">
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
          <FlaskConical size={20} className="text-oracle-accent" />
          Historical Backtest
        </h1>
        <p className="text-oracle-muted text-xs mt-0.5">
          How would this strategy have performed since the 1990s?
        </p>
      </div>

      {/* Controls */}
      <div className="glass-card p-4 mb-4 space-y-3">
        {/* Symbol */}
        <div>
          <label className="text-[10px] text-oracle-muted uppercase font-bold mb-1 block">Ticker</label>
          <input
            type="text"
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && runBacktest()}
            placeholder="e.g. AAPL, MVIS, TSLA"
            className="w-full bg-white/[0.04] border border-oracle-border rounded-xl px-3 py-2.5 text-oracle-text text-sm font-bold placeholder:text-oracle-muted/40 focus:outline-none focus:border-oracle-accent transition-colors uppercase"
          />
        </div>

        {/* Strategy */}
        <div>
          <label className="text-[10px] text-oracle-muted uppercase font-bold mb-1.5 block">Strategy</label>
          <div className="grid grid-cols-2 gap-1.5">
            {STRATEGIES.map(st => (
              <button
                key={st.value}
                onClick={() => setStrategy(st.value)}
                className={`px-2 py-2 rounded-xl text-[11px] font-semibold text-left transition-all ${
                  strategy === st.value
                    ? 'bg-oracle-accent/20 border border-oracle-accent/50 text-oracle-accent'
                    : 'bg-white/[0.03] border border-oracle-border text-oracle-muted hover:text-oracle-text'
                }`}
              >
                <div className="font-bold">{st.label}</div>
                <div className="text-[9px] opacity-70 mt-0.5 leading-tight">{st.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Years + Hold days */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-oracle-muted uppercase font-bold mb-1.5 block">Period</label>
            <div className="flex gap-1 flex-wrap">
              {YEARS_OPTIONS.map(y => (
                <button
                  key={y.value}
                  onClick={() => setYears(y.value)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                    years === y.value
                      ? 'bg-oracle-accent text-white'
                      : 'bg-white/[0.04] text-oracle-muted hover:text-oracle-text'
                  }`}
                >
                  {y.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] text-oracle-muted uppercase font-bold mb-1.5 block">Hold</label>
            <div className="flex gap-1 flex-wrap">
              {HOLD_OPTIONS.map(h => (
                <button
                  key={h.value}
                  onClick={() => setHoldDays(h.value)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                    holdDays === h.value
                      ? 'bg-oracle-accent text-white'
                      : 'bg-white/[0.04] text-oracle-muted hover:text-oracle-text'
                  }`}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Run button */}
        <button
          onClick={runBacktest}
          disabled={loading}
          className="w-full py-3 bg-oracle-accent text-white font-bold rounded-xl flex items-center justify-center gap-2 disabled:opacity-50 active:scale-98 transition-all text-sm"
        >
          {loading ? (
            <><RefreshCw size={16} className="animate-spin" /> Running...</>
          ) : (
            <><Search size={16} /> Run Backtest</>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="glass-card border-l-4 border-l-oracle-red p-4 mb-4">
          <div className="flex items-center gap-2 text-oracle-red text-sm font-semibold mb-1">
            <AlertCircle size={16} />
            Backtest Failed
          </div>
          <p className="text-oracle-muted text-xs">{error}</p>
        </div>
      )}

      {/* Results */}
      {data && s && (
        <>
          {/* Summary banner */}
          <div className={`glass-card p-4 mb-4 border-l-4 ${isWinner ? 'border-l-oracle-green' : 'border-l-oracle-red'}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-oracle-muted text-[10px] uppercase font-bold">
                  {data.symbol} · {stratLabel} · {years}Y · hold {holdDays}d
                </div>
                <div className={`text-3xl font-black mt-1 ${isWinner ? 'text-oracle-green' : 'text-oracle-red'}`}>
                  {s.totalReturn >= 0 ? '+' : ''}{s.totalReturn}%
                </div>
                <div className="text-oracle-muted text-xs mt-0.5">
                  $10,000 → <span className="text-oracle-text font-bold">${fmt(s.finalEquity, 0)}</span>
                  {' '}over {data.dataRange?.from} → {data.dataRange?.to}
                </div>
              </div>
              <div className="text-right shrink-0">
                {beatBH ? (
                  <div className="bg-oracle-green/15 border border-oracle-green/30 rounded-lg px-2 py-1 text-[10px] text-oracle-green font-bold">
                    🏆 Beat B&H<br />
                    <span className="font-normal text-oracle-muted">+{Math.abs(Math.round((s.totalReturn - s.bhReturn) * 10) / 10)}% edge</span>
                  </div>
                ) : (
                  <div className="bg-oracle-red/10 border border-oracle-red/20 rounded-lg px-2 py-1 text-[10px] text-oracle-muted font-bold">
                    B&H won<br />
                    <span className="text-oracle-muted font-normal">{s.bhReturn >= 0 ? '+' : ''}{s.bhReturn}%</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Equity curve chart */}
          <div className="glass-card p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] text-oracle-muted uppercase font-bold">Equity Curve ($10K start)</div>
              <div className="flex items-center gap-3 text-[9px]">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#10b981] inline-block" />
                  <span className="text-oracle-muted">Strategy</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-oracle-muted/40 inline-block" />
                  <span className="text-oracle-muted">Buy & Hold</span>
                </span>
              </div>
            </div>
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.equityCurve} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="stratGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={curveColor} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={curveColor} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="bhGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.1} />
                      <stop offset="95%" stopColor="#94a3b8" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.07)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#64748b', fontSize: 9 }}
                    minTickGap={40}
                    tickFormatter={v => v ? v.slice(0, 7) : ''}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#64748b', fontSize: 9 }}
                    tickFormatter={v => `$${v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v}`}
                    width={42}
                  />
                  <ReferenceLine y={10000} stroke="rgba(148,163,184,0.25)" strokeDasharray="4 4" />
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="bh"
                    name="Buy & Hold"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    fill="url(#bhGrad)"
                    dot={false}
                    strokeDasharray="4 4"
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    name="Strategy"
                    stroke={curveColor}
                    strokeWidth={2.5}
                    fill="url(#stratGrad)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            <StatCard
              label="CAGR"
              value={`${s.cagr >= 0 ? '+' : ''}${s.cagr}%`}
              sub="per year"
              color={s.cagr >= 10 ? 'text-oracle-green' : s.cagr >= 0 ? 'text-oracle-yellow' : 'text-oracle-red'}
            />
            <StatCard
              label="Win Rate"
              value={`${s.winRate}%`}
              sub={`${s.totalTrades} trades`}
              color={s.winRate >= 55 ? 'text-oracle-green' : s.winRate >= 45 ? 'text-oracle-yellow' : 'text-oracle-red'}
            />
            <StatCard
              label="Max DD"
              value={`-${s.maxDrawdown}%`}
              sub="max loss"
              color={s.maxDrawdown < 15 ? 'text-oracle-green' : s.maxDrawdown < 30 ? 'text-oracle-yellow' : 'text-oracle-red'}
            />
            <StatCard
              label="Profit Factor"
              value={s.profitFactor >= 99 ? '∞' : s.profitFactor}
              sub="win/loss ratio"
              color={s.profitFactor >= 1.5 ? 'text-oracle-green' : s.profitFactor >= 1 ? 'text-oracle-yellow' : 'text-oracle-red'}
            />
            <StatCard
              label="Avg Win"
              value={`+${s.avgWin}%`}
              sub="per winning trade"
              color="text-oracle-green"
            />
            <StatCard
              label="Avg Loss"
              value={`-${s.avgLoss}%`}
              sub="per losing trade"
              color="text-oracle-red"
            />
          </div>

          {/* Best / Worst trade */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="glass-card p-3">
              <div className="text-[9px] text-oracle-muted uppercase font-bold mb-1">Best Trade</div>
              <div className="text-oracle-green font-black text-lg">+{s.bestTrade}%</div>
            </div>
            <div className="glass-card p-3">
              <div className="text-[9px] text-oracle-muted uppercase font-bold mb-1">Worst Trade</div>
              <div className="text-oracle-red font-black text-lg">{s.worstTrade}%</div>
            </div>
          </div>

          {/* Trades list */}
          <button
            onClick={() => setShowTrades(t => !t)}
            className="w-full glass-card px-4 py-3 flex items-center justify-between mb-2 text-sm font-semibold text-oracle-text hover:text-oracle-accent transition-colors"
          >
            <span>Recent Trades ({data.recentTrades?.length})</span>
            <ChevronDown size={16} className={`transition-transform ${showTrades ? 'rotate-180' : ''}`} />
          </button>

          {showTrades && (
            <div className="space-y-1.5">
              {(data.recentTrades || []).map((t, i) => (
                <div key={i} className={`glass-card px-3 py-2 flex items-center gap-3 border-l-3 ${t.win ? 'border-l-oracle-green' : 'border-l-oracle-red'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-oracle-muted">{t.entryDate} → {t.exitDate}</div>
                    <div className="text-xs text-oracle-text font-semibold">
                      ${t.entry} → ${t.exit}
                    </div>
                  </div>
                  <div className={`text-sm font-black ${t.win ? 'text-oracle-green' : 'text-oracle-red'}`}>
                    {t.plPct >= 0 ? '+' : ''}{t.plPct}%
                  </div>
                  <div className="text-[10px] text-oracle-muted text-right">
                    ${fmt(t.equity, 0)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <div className="mt-4 p-3 glass-card border border-oracle-border/30">
            <p className="text-[9px] text-oracle-muted/60 leading-relaxed flex gap-1">
              <Info size={10} className="shrink-0 mt-0.5" />
              Past performance does not guarantee future results. Backtests use hindsight data and cannot account for slippage, liquidity, or real-world execution costs. Position size: 15% per trade, $10,000 starting capital, non-overlapping entries.
            </p>
          </div>
        </>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div className="py-16 text-center">
          <FlaskConical size={48} className="text-oracle-muted/20 mx-auto mb-4" />
          <p className="text-oracle-text font-semibold mb-1">Enter a ticker and run the backtest</p>
          <p className="text-oracle-muted text-sm">See how the strategy performed since the 1990s</p>
          <div className="flex justify-center gap-2 mt-4 flex-wrap">
            {['AAPL', 'TSLA', 'MVIS', 'NVDA', 'SPY'].map(sym => (
              <button
                key={sym}
                onClick={() => { setSymbol(sym); }}
                className="px-3 py-1 glass-card text-oracle-muted text-xs hover:text-oracle-accent transition-colors rounded-lg"
              >
                {sym}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
