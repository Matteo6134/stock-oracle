import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users, RefreshCw, Clock, ChevronLeft, ChevronRight, Trophy,
  TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Target,
  BarChart3, AlertTriangle, Diamond, Flame, Zap, Activity
} from 'lucide-react'
import LoadingSkeleton from '../components/LoadingSkeleton'

const API_BASE = import.meta.env.VITE_API_URL || ''

const CONSENSUS_COLORS = {
  'Strong Buy': { bg: 'bg-oracle-green/15', text: 'text-oracle-green', border: 'border-oracle-green/30' },
  'Buy': { bg: 'bg-oracle-accent/15', text: 'text-oracle-accent', border: 'border-oracle-accent/30' },
  'Speculative': { bg: 'bg-oracle-yellow/15', text: 'text-oracle-yellow', border: 'border-oracle-yellow/30' },
  'No Trade': { bg: 'bg-white/5', text: 'text-oracle-muted', border: 'border-oracle-border' },
}

const ACTION_COLORS = {
  BUY: 'bg-oracle-green/20 text-oracle-green border-oracle-green/40',
  WATCH: 'bg-oracle-yellow/20 text-oracle-yellow border-oracle-yellow/40',
  SKIP: 'bg-white/5 text-oracle-muted border-oracle-border',
}

// ── Win Rate Ring (reused pattern from BacktesterPage) ──
function WinRateRing({ rate, size = 48, strokeWidth = 4, color = 'stroke-oracle-green' }) {
  const r = (size - strokeWidth) / 2
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - (rate || 0) / 100)
  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.1)" strokeWidth={strokeWidth} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" className={color} strokeWidth={strokeWidth}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x={size / 2} y={size / 2 + 1} textAnchor="middle" dominantBaseline="middle"
        className="fill-oracle-text text-[10px] font-bold">{rate}%</text>
    </svg>
  )
}

// ── Agent Card ──
function AgentCard({ agent, rank }) {
  const medal = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : ''
  const wrColor = agent.winRate >= 60 ? 'stroke-oracle-green' : agent.winRate >= 45 ? 'stroke-oracle-yellow' : 'stroke-oracle-red'

  return (
    <div className="glass-card p-3">
      <div className="flex items-center gap-3">
        <div className="text-center">
          <div className="text-2xl">{agent.emoji}</div>
          {medal && <div className="text-xs mt-0.5">{medal}</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-oracle-text text-sm font-bold truncate">{agent.agent}</span>
            <span className="text-oracle-muted text-[10px] capitalize">{agent.style}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px]">
            <span className="text-oracle-muted">{agent.totalPicks} picks</span>
            <span className="text-oracle-green">+{agent.avgGain}% avg win</span>
            <span className="text-oracle-red">-{agent.avgLoss}% avg loss</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <WinRateRing rate={agent.winRate} size={44} strokeWidth={3.5} color={wrColor} />
          <div className="text-[9px] text-oracle-muted mt-0.5">PF {agent.profitFactor}x</div>
        </div>
      </div>
    </div>
  )
}

// ── Consensus Bar ──
function ConsensusBar({ consensusStats }) {
  const levels = ['Strong Buy', 'Buy', 'Speculative', 'No Trade']
  return (
    <div className="glass-card p-3">
      <div className="flex items-center gap-2 mb-2">
        <Trophy size={14} className="text-oracle-accent" />
        <span className="text-xs font-semibold text-oracle-text">Consensus Accuracy</span>
      </div>
      <div className="space-y-2">
        {levels.map(level => {
          const s = consensusStats[level] || { count: 0, winRate: 0, avgReturn: 0 }
          const c = CONSENSUS_COLORS[level]
          return (
            <div key={level} className="flex items-center gap-2">
              <span className={`text-[10px] font-semibold w-20 shrink-0 ${c.text}`}>{level}</span>
              <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${s.winRate >= 50 ? 'bg-oracle-green' : 'bg-oracle-red'}`}
                  style={{ width: `${Math.min(s.winRate, 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-oracle-text font-semibold w-10 text-right">{s.winRate}%</span>
              <span className="text-[10px] text-oracle-muted w-8 text-right">{s.count}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Gem Verdict Card ──
function GemCard({ gem }) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const cColor = CONSENSUS_COLORS[gem.consensus] || CONSENSUS_COLORS['No Trade']

  const outcomes = gem.outcomes || {}
  const timeframes = ['1d', '3d', '5d', '7d']

  return (
    <div className="glass-card p-3.5">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0" onClick={() => navigate(`/stock/${gem.symbol}`)} style={{ cursor: 'pointer' }}>
          <div className="flex items-center gap-2">
            <span className="text-oracle-text font-bold text-sm">{gem.symbol}</span>
            <span className="text-oracle-muted text-[10px]">${gem.entryPrice}</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${cColor.bg} ${cColor.text} ${cColor.border}`}>
              {gem.consensus}
            </span>
          </div>
          {gem.companyName && <p className="text-oracle-muted text-xs truncate mt-0.5">{gem.companyName}</p>}
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center gap-1">
            <Diamond size={12} className="text-oracle-green" />
            <span className="text-oracle-green text-sm font-bold">{gem.gemScore}</span>
          </div>
        </div>
      </div>

      {/* Agent verdict badges */}
      <div className="flex flex-wrap gap-1 mb-2">
        {(gem.verdicts || []).map((v, i) => (
          <button
            key={i}
            onClick={() => setExpanded(!expanded)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${ACTION_COLORS[v.action]}`}
          >
            <span>{v.emoji}</span>
            <span>{v.action}</span>
            {v.conviction > 0 && <span className="opacity-60">{'●'.repeat(Math.min(v.conviction, 5))}</span>}
          </button>
        ))}
      </div>

      {/* Outcome bars */}
      {Object.keys(outcomes).length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {timeframes.map(tf => {
            const o = outcomes[tf]
            if (!o) return (
              <div key={tf} className="text-center">
                <div className="text-[9px] text-oracle-muted mb-0.5">{tf}</div>
                <div className="text-[10px] text-oracle-muted">—</div>
              </div>
            )
            const isUp = o.return >= 0
            return (
              <div key={tf} className="text-center">
                <div className="text-[9px] text-oracle-muted mb-0.5">{tf}</div>
                <div className={`text-xs font-bold ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
                  {isUp ? '+' : ''}{o.return}%
                </div>
                <div className="text-[8px] text-oracle-green/60">↑{o.maxGain}%</div>
                <div className="text-[8px] text-oracle-red/60">↓{o.maxDrawdown}%</div>
              </div>
            )
          })}
        </div>
      )}

      {/* Expanded reasoning */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-oracle-border space-y-1.5">
          {(gem.verdicts || []).filter(v => v.action !== 'SKIP').map((v, i) => (
            <div key={i} className="flex gap-2 text-[10px]">
              <span className="shrink-0">{v.emoji}</span>
              <div>
                <span className={`font-semibold ${v.action === 'BUY' ? 'text-oracle-green' : 'text-oracle-yellow'}`}>
                  {v.agent}:
                </span>{' '}
                <span className="text-oracle-muted">{v.reasoning}</span>
                {v.targetPrice && (
                  <span className="text-oracle-accent ml-1">Target ${v.targetPrice} | Stop ${v.stopLoss}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Signal Performance Table ──
function SignalPerformance({ signalPerformance }) {
  const sorted = Object.entries(signalPerformance || {})
    .map(([signal, stats]) => ({ signal, ...stats }))
    .sort((a, b) => b.avgReturn - a.avgReturn)

  if (sorted.length === 0) return null

  return (
    <div className="glass-card p-3">
      <div className="flex items-center gap-2 mb-2">
        <Activity size={14} className="text-oracle-accent" />
        <span className="text-xs font-semibold text-oracle-text">Signal Performance</span>
      </div>
      <div className="space-y-1">
        {sorted.slice(0, 8).map(s => (
          <div key={s.signal} className="flex items-center gap-2 text-[10px]">
            <span className="text-oracle-muted truncate flex-1">{s.signal.replace(/_/g, ' ')}</span>
            <span className="text-oracle-muted w-6 text-right">{s.count}</span>
            <span className={`font-semibold w-12 text-right ${s.avgReturn >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {s.avgReturn >= 0 ? '+' : ''}{s.avgReturn}%
            </span>
            <span className="text-oracle-muted w-10 text-right">{s.winRate}% WR</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Page ──
export default function GemBacktestPage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [dayIndex, setDayIndex] = useState(0)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/api/gem-backtest`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      setData(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const days = data?.days || []
  const currentDay = days[dayIndex] || null
  const leaderboard = data?.agentLeaderboard || []

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <Users className="text-oracle-accent" size={22} />
            AI Trading Desk
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">
            5 virtual traders analyze every gem pick
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && <LoadingSkeleton count={6} />}

      {error && !loading && (
        <div className="glass-card border-l-4 border-l-oracle-red p-4">
          <p className="text-oracle-red text-sm font-medium">Failed to load backtest data</p>
          <p className="text-oracle-muted text-xs mt-1">{error}</p>
          <button onClick={fetchData} className="mt-2 text-oracle-accent text-xs">Try Again</button>
        </div>
      )}

      {!loading && data && (
        <>
          {/* Overall stats */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="glass-card p-2 text-center">
              <p className="text-oracle-accent font-bold text-lg">{data.totalDays || 0}</p>
              <p className="text-oracle-muted text-[10px]">Days Tracked</p>
            </div>
            <div className="glass-card p-2 text-center">
              <p className="text-oracle-green font-bold text-lg">{data.totalGems || 0}</p>
              <p className="text-oracle-muted text-[10px]">Gems Analyzed</p>
            </div>
          </div>

          {/* Agent Leaderboard */}
          {leaderboard.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-2">
                <Trophy size={14} className="text-oracle-yellow" />
                <span className="text-sm font-semibold text-oracle-text">Agent Leaderboard</span>
              </div>
              <div className="space-y-2">
                {leaderboard.map((agent, i) => (
                  <AgentCard key={agent.agent} agent={agent} rank={i} />
                ))}
              </div>
            </div>
          )}

          {/* Consensus accuracy */}
          {data.consensusStats && <div className="mb-3"><ConsensusBar consensusStats={data.consensusStats} /></div>}

          {/* Signal performance */}
          {data.signalPerformance && <div className="mb-3"><SignalPerformance signalPerformance={data.signalPerformance} /></div>}

          {/* Day selector */}
          {days.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between glass-card p-2 mb-2">
                <button
                  onClick={() => setDayIndex(Math.min(days.length - 1, dayIndex + 1))}
                  disabled={dayIndex >= days.length - 1}
                  className="p-1.5 text-oracle-muted hover:text-oracle-accent disabled:opacity-30"
                >
                  <ChevronLeft size={16} />
                </button>
                <div className="text-center">
                  <div className="text-oracle-text text-sm font-semibold">{currentDay?.date || '—'}</div>
                  <div className="text-oracle-muted text-[10px]">{currentDay?.gems?.length || 0} gems</div>
                </div>
                <button
                  onClick={() => setDayIndex(Math.max(0, dayIndex - 1))}
                  disabled={dayIndex <= 0}
                  className="p-1.5 text-oracle-muted hover:text-oracle-accent disabled:opacity-30"
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Gem cards for selected day */}
              <div className="space-y-2">
                {(currentDay?.gems || []).map((gem, i) => (
                  <GemCard key={`${gem.symbol}-${i}`} gem={gem} />
                ))}
              </div>

              {currentDay?.gems?.length === 0 && (
                <div className="py-8 text-center">
                  <Diamond size={32} className="text-oracle-muted/30 mx-auto mb-2" />
                  <p className="text-oracle-muted text-sm">No gems tracked this day</p>
                </div>
              )}
            </div>
          )}

          {/* Empty state when no data at all */}
          {days.length === 0 && leaderboard.length === 0 && (
            <div className="py-12 text-center">
              <Users size={48} className="text-oracle-muted/30 mx-auto mb-3" />
              <p className="text-oracle-text text-sm font-medium">No backtest data yet</p>
              <p className="text-oracle-muted text-xs mt-1">
                Visit the Gem Finder page first to generate picks. The trading desk will analyze them and track results over time.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
