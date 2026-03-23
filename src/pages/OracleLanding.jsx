import { TrendingUp, Target } from 'lucide-react';

export default function OracleLanding({ onSelect }) {
  return (
    <div className="min-h-screen bg-oracle-bg flex flex-col items-center justify-center px-6">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-black text-oracle-text mb-2">Oracle</h1>
        <p className="text-oracle-muted text-sm">AI-powered trading brain. Choose your arena.</p>
      </div>

      <div className="grid gap-4 w-full max-w-sm">
        {/* Stock Oracle */}
        <button
          onClick={() => onSelect('stock')}
          className="glass-card p-6 text-left hover:bg-white/[0.06] transition-all active:scale-[0.98] border border-oracle-border hover:border-oracle-accent/50 group"
        >
          <div className="flex items-center gap-4 mb-3">
            <div className="w-12 h-12 rounded-2xl bg-oracle-green/15 flex items-center justify-center group-hover:bg-oracle-green/25 transition-colors">
              <TrendingUp size={24} className="text-oracle-green" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-oracle-text">Stock Oracle</h2>
              <p className="text-oracle-muted text-xs">Stocks, penny stocks, auto-trading</p>
            </div>
          </div>
          <p className="text-oracle-muted text-xs leading-relaxed">
            5 AI agents + Claude brain scan 200+ stocks every 5 minutes.
            Auto-trades via Alpaca with break-even stop strategy.
          </p>
          <div className="flex gap-2 mt-3">
            <span className="px-2 py-0.5 rounded-lg bg-oracle-green/10 text-oracle-green text-[9px] font-bold">LIVE TRADING</span>
            <span className="px-2 py-0.5 rounded-lg bg-oracle-accent/10 text-oracle-accent text-[9px] font-bold">PENNY STOCKS</span>
          </div>
        </button>

        {/* Polymarket Oracle */}
        <button
          onClick={() => onSelect('poly')}
          className="glass-card p-6 text-left hover:bg-white/[0.06] transition-all active:scale-[0.98] border border-oracle-border hover:border-purple-500/50 group"
        >
          <div className="flex items-center gap-4 mb-3">
            <div className="w-12 h-12 rounded-2xl bg-purple-500/15 flex items-center justify-center group-hover:bg-purple-500/25 transition-colors">
              <Target size={24} className="text-purple-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-oracle-text">Polymarket Oracle</h2>
              <p className="text-oracle-muted text-xs">Prediction markets, event betting</p>
            </div>
          </div>
          <p className="text-oracle-muted text-xs leading-relaxed">
            Claude AI finds mispriced prediction markets. Bets when the crowd is wrong.
            Simulated portfolio: $1,400 → $400K goal.
          </p>
          <div className="flex gap-2 mt-3">
            <span className="px-2 py-0.5 rounded-lg bg-purple-500/10 text-purple-400 text-[9px] font-bold">SIMULATION</span>
            <span className="px-2 py-0.5 rounded-lg bg-oracle-accent/10 text-oracle-accent text-[9px] font-bold">$1.4K → $400K</span>
          </div>
        </button>
      </div>

      <p className="text-oracle-muted/40 text-[10px] mt-8">Powered by Claude AI</p>
    </div>
  );
}
