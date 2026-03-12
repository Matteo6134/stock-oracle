import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, TrendingUp, TrendingDown, AlertCircle, Newspaper, MessageCircle, Activity, RefreshCw, Calendar, Target, Zap, CircleCheck, AlertTriangle, XCircle } from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import ScoreCircle from '../components/ScoreCircle'
import ScoreBar from '../components/ScoreBar'
import SourceLinks from '../components/SourceLinks'
import BrokerBadge from '../components/BrokerBadge'
import { useStockDetail } from '../hooks/useStocks'

function ProbabilityBadge({ probability }) {
  const value = probability || 0
  let colorClass = 'text-oracle-red bg-oracle-red/15 border-oracle-red/30'
  if (value >= 75) colorClass = 'text-oracle-green bg-oracle-green/15 border-oracle-green/30'
  else if (value >= 60) colorClass = 'text-oracle-yellow bg-oracle-yellow/15 border-oracle-yellow/30'

  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-bold border ${colorClass}`}>
      {value}% probability
    </span>
  )
}

function TimeAgo({ date }) {
  if (!date) return null
  const now = new Date()
  const then = new Date(date)
  const diffMs = now - then
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 60) return <span>{diffMins}m ago</span>
  if (diffHours < 24) return <span>{diffHours}h ago</span>
  return <span>{diffDays}d ago</span>
}

export default function StockDetail() {
  const { symbol } = useParams()
  const navigate = useNavigate()
  const { stock, loading, error, refresh } = useStockDetail(symbol)

  if (loading) {
    return (
      <div className="max-w-lg mx-auto px-4 pt-2">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-oracle-muted text-sm mb-4 hover:text-oracle-text transition-colors">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="space-y-4">
          {[200, 120, 160, 100, 80].map((h, i) => (
            <div key={i} className="skeleton-shimmer rounded-xl" style={{ height: h }} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-lg mx-auto px-4 pt-2">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-oracle-muted text-sm mb-4 hover:text-oracle-text transition-colors">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="p-4 glass-card border-l-4 border-l-oracle-red text-center">
          <AlertCircle size={32} className="text-oracle-red mx-auto mb-2" />
          <p className="text-oracle-red text-sm font-medium">Failed to load {symbol}</p>
          <p className="text-oracle-muted text-xs mt-1">{error}</p>
          <button
            onClick={refresh}
            className="mt-3 px-4 py-1.5 bg-oracle-red/20 text-oracle-red text-xs font-medium rounded-lg hover:bg-oracle-red/30 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!stock) return null

  const companyName = stock.companyName || stock.name || symbol
  const price = stock.price || 0
  const change = stock.change || 0
  const score = stock.score || 0
  const probability = stock.probability || 0
  const breakdown = stock.breakdown || {}
  const brokerData = stock.brokerAvailability || stock.brokers || {}
  const priceHistory = stock.history || stock.priceHistory || []
  const news = stock.news || []
  const social = stock.social || {}
  const sector = stock.sector
  const upcomingEvents = stock.upcomingEvents || []
  const catalysts = stock.catalysts || []
  const analystBuyPct = stock.analystBuyPct
  const hasEarningsToday = stock.hasEarningsToday
  const hasEarningsTomorrow = stock.hasEarningsTomorrow
  const entrySignal = stock.entrySignal
  const entryLabel = stock.entryLabel
  const entryReason = stock.entryReason

  const isPositive = change >= 0
  const chartData = priceHistory.map((p, i) => {
    const d = p.date ? new Date(p.date) : null
    return {
      day: d ? `${d.getMonth()+1}/${d.getDate()}` : `Day ${i + 1}`,
      price: p.close || p.price || p,
    }
  })

  const entrySignalConfig = {
    enter: {
      icon: CircleCheck,
      bg: 'bg-oracle-green/10',
      border: 'border-oracle-green/30',
      text: 'text-oracle-green',
    },
    risky: {
      icon: AlertTriangle,
      bg: 'bg-oracle-yellow/10',
      border: 'border-oracle-yellow/30',
      text: 'text-oracle-yellow',
    },
    caution: {
      icon: AlertTriangle,
      bg: 'bg-oracle-yellow/10',
      border: 'border-oracle-yellow/30',
      text: 'text-oracle-yellow',
    },
    too_late: {
      icon: XCircle,
      bg: 'bg-oracle-red/10',
      border: 'border-oracle-red/30',
      text: 'text-oracle-red',
    },
  }

  const signalCfg = entrySignal ? entrySignalConfig[entrySignal] || entrySignalConfig.enter : null
  const SignalIcon = signalCfg?.icon

  return (
    <div className="max-w-lg mx-auto px-4 pt-2 pb-6">
      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1 text-oracle-muted text-sm mb-4 hover:text-oracle-text transition-colors"
      >
        <ArrowLeft size={16} /> Back
      </button>

      {/* Header: Symbol + Price */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-oracle-text">{symbol}</h1>
          <p className="text-oracle-muted text-sm">{companyName}</p>
          {sector && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-oracle-accent/15 text-oracle-accent border border-oracle-accent/30">
              {sector}
            </span>
          )}
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-oracle-text">
            ${typeof price === 'number' ? price.toFixed(2) : price}
          </div>
          <div className={`flex items-center justify-end gap-1 text-sm font-semibold ${isPositive ? 'text-oracle-green' : 'text-oracle-red'}`}>
            {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {isPositive ? '+' : ''}{typeof change === 'number' ? change.toFixed(2) : change}%
          </div>
        </div>
      </div>

      {/* Trade Setup Card */}
      {stock.tradeSetup?.available && (
        <div className="glass-card p-4 mb-4">
          <h3 className="text-xs text-oracle-muted font-medium mb-3 flex items-center gap-1">
            <Target size={12} /> Trade Setup
          </h3>

          {/* Risk Level Badge */}
          <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border mb-3 ${
            stock.tradeSetup.riskLevel === 'secure'
              ? 'bg-oracle-green/15 text-oracle-green border-oracle-green/30'
              : stock.tradeSetup.riskLevel === 'moderate'
                ? 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/30'
                : stock.tradeSetup.riskLevel === 'caution'
                  ? 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30'
                  : 'bg-oracle-red/15 text-oracle-red border-oracle-red/30'
          }`}>
            {stock.tradeSetup.riskLevel === 'secure' ? <CircleCheck size={12} /> : stock.tradeSetup.riskLevel === 'risky' ? <XCircle size={12} /> : <AlertTriangle size={12} />}
            {stock.tradeSetup.riskLabel}
          </div>

          {/* Price Levels */}
          <div className="space-y-2 mb-3">
            {/* Target */}
            <div className="flex items-center justify-between glass-inner rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <TrendingUp size={12} className="text-oracle-green" />
                <span className="text-oracle-muted text-xs">Target</span>
              </div>
              <div className="text-right">
                <span className="text-oracle-green font-bold text-sm font-mono">${stock.tradeSetup.targetPrice}</span>
                <span className="text-oracle-green/60 text-[10px] ml-1">+{stock.tradeSetup.potentialGain}%</span>
              </div>
            </div>

            {/* Entry */}
            <div className="flex items-center justify-between glass-inner rounded-lg px-3 py-2 border border-oracle-accent/20">
              <div className="flex items-center gap-2">
                <Zap size={12} className="text-oracle-accent" />
                <span className="text-oracle-accent text-xs font-bold">Entry</span>
              </div>
              <span className="text-oracle-text font-bold text-sm font-mono">${stock.tradeSetup.entryPrice}</span>
            </div>

            {/* Stop Loss */}
            <div className="flex items-center justify-between glass-inner rounded-lg px-3 py-2">
              <div className="flex items-center gap-2">
                <TrendingDown size={12} className="text-oracle-red" />
                <span className="text-oracle-muted text-xs">Stop Loss</span>
              </div>
              <div className="text-right">
                <span className="text-oracle-red font-bold text-sm font-mono">${stock.tradeSetup.stopLoss}</span>
                <span className="text-oracle-red/60 text-[10px] ml-1">-{stock.tradeSetup.potentialLoss}%</span>
              </div>
            </div>
          </div>

          {/* R:R Ratio Bar */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-oracle-muted text-[10px] font-bold uppercase">Risk/Reward</span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden flex gap-px">
              <div className="bg-oracle-red rounded-full" style={{ flex: 1 }} />
              <div className="bg-oracle-green rounded-full" style={{ flex: Math.min(stock.tradeSetup.riskReward, 5) }} />
            </div>
            <span className={`text-xs font-bold ${stock.tradeSetup.riskReward >= 1.5 ? 'text-oracle-green' : stock.tradeSetup.riskReward >= 1 ? 'text-oracle-yellow' : 'text-oracle-red'}`}>
              {stock.tradeSetup.riskReward}x
            </span>
          </div>

          {/* Sources */}
          <div className="text-[9px] text-oracle-muted space-y-0.5">
            <div>Target: {stock.tradeSetup.targetSource}</div>
            <div>Stop: {stock.tradeSetup.stopSource}</div>
            {stock.tradeSetup.atr && <div>ATR(14): ${stock.tradeSetup.atr}</div>}
            {stock.tradeSetup.analystTarget && <div className="text-oracle-muted/50">Analyst 12mo target: ${stock.tradeSetup.analystTarget} (long-term)</div>}
          </div>
        </div>
      )}

      {/* Upcoming Events & Catalysts - THE KEY FORWARD-LOOKING INFO */}
      {(upcomingEvents.length > 0 || catalysts.length > 0 || hasEarningsToday || hasEarningsTomorrow) && (
        <div className="glass-card p-4 mb-4">
          <h3 className="text-xs text-oracle-muted font-medium mb-3 flex items-center gap-1">
            <Calendar size={12} /> Upcoming Catalysts
          </h3>

          {/* Earnings alert banner */}
          {(hasEarningsToday || hasEarningsTomorrow) && (
            <div className={`p-3 rounded-lg mb-3 flex items-center gap-2 ${
              hasEarningsToday
                ? 'bg-oracle-yellow/15 border border-oracle-yellow/40'
                : 'bg-orange-500/10 border border-orange-500/30'
            }`}>
              <Zap size={16} className={hasEarningsToday ? 'text-oracle-yellow' : 'text-orange-400'} />
              <div>
                <div className={`text-sm font-bold ${hasEarningsToday ? 'text-oracle-yellow' : 'text-orange-400'}`}>
                  {hasEarningsToday ? 'Earnings Report TODAY' : 'Earnings Report TOMORROW'}
                </div>
                <div className="text-oracle-muted text-xs">
                  {hasEarningsToday
                    ? 'Position before market close for potential post-earnings move'
                    : 'Position today before tomorrow\'s earnings announcement'}
                </div>
              </div>
            </div>
          )}

          {/* Event badges */}
          {upcomingEvents.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {upcomingEvents.map((evt, i) => {
                const isEarnings = evt.toLowerCase().includes('earnings')
                const isDividend = evt.toLowerCase().includes('dividend')
                const isTarget = evt.toLowerCase().includes('target')
                return (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border ${
                      isEarnings
                        ? 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30'
                        : isDividend
                          ? 'bg-oracle-green/15 text-oracle-green border-oracle-green/30'
                          : isTarget
                            ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                            : 'bg-oracle-accent/10 text-oracle-accent border-oracle-accent/20'
                    }`}
                  >
                    {isEarnings ? <Calendar size={10} /> : isDividend ? <Zap size={10} /> : <Target size={10} />}
                    {evt}
                  </span>
                )
              })}
            </div>
          )}

          {/* Analyst info */}
          {analystBuyPct != null && analystBuyPct > 0 && (
            <div className="flex items-center gap-2 p-2.5 glass-inner rounded-lg">
              <Target size={14} className="text-oracle-green" />
              <div className="flex-1">
                <div className="text-oracle-text text-sm font-medium">
                  {analystBuyPct}% of Analysts Say Buy
                </div>
                <div className="h-1.5 bg-oracle-border rounded-full mt-1 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-oracle-green"
                    style={{ width: `${Math.min(analystBuyPct, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {upcomingEvents.length === 0 && !hasEarningsToday && !hasEarningsTomorrow && analystBuyPct == null && (
            <p className="text-oracle-muted text-xs">No major catalysts detected in the near term.</p>
          )}
        </div>
      )}

      {/* Mini Price Chart */}
      {chartData.length > 0 && (
        <div className="glass-card p-4 mb-4">
          <h3 className="text-xs text-oracle-muted mb-2 font-medium flex items-center gap-1">
            <Activity size={12} /> Price History
          </h3>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={isPositive ? '#10b981' : '#ef4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fontSize: 10, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                width={45}
                tickFormatter={(v) => `$${v}`}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(15, 23, 42, 0.7)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  border: '1px solid rgba(148, 163, 184, 0.12)',
                  borderRadius: '12px',
                  fontSize: '12px',
                  color: '#e2e8f0',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                }}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke={isPositive ? '#10b981' : '#ef4444'}
                strokeWidth={2}
                fill="url(#priceGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Overall Score */}
      <div className="glass-card p-5 mb-4 flex flex-col items-center">
        <h3 className="text-xs text-oracle-muted mb-3 font-medium">Overall Score</h3>
        <ScoreCircle score={score} size={130} />
        <div className="mt-3">
          <ProbabilityBadge probability={probability} />
        </div>
      </div>

      {/* Score Breakdown */}
      <div className="glass-card p-4 mb-4 space-y-3">
        <h3 className="text-xs text-oracle-muted font-medium mb-1">Score Breakdown</h3>
        <ScoreBar label="Catalyst" score={breakdown.earnings ?? breakdown.fundamental ?? 0} color="blue" />
        <ScoreBar label="Social" score={breakdown.social ?? breakdown.sentiment ?? 0} color="purple" />
        <ScoreBar label="News" score={breakdown.news ?? 0} color="orange" />
        <ScoreBar label="Technical" score={breakdown.technical ?? 0} color="cyan" />
      </div>

      {/* Broker Availability */}
      {(brokerData.etoro !== undefined || brokerData.revolut !== undefined) && (
        <div className="glass-card p-4 mb-4">
          <h3 className="text-xs text-oracle-muted font-medium mb-3">Broker Availability</h3>
          <div className="flex gap-3">
            {brokerData.etoro !== undefined && <BrokerBadge name="eToro" available={brokerData.etoro} />}
            {brokerData.revolut !== undefined && <BrokerBadge name="Revolut" available={brokerData.revolut} />}
          </div>
        </div>
      )}

      {/* Source Links */}
      <div className="glass-card p-4 mb-4">
        <h3 className="text-xs text-oracle-muted font-medium mb-3">Research Links</h3>
        <SourceLinks symbol={symbol} />
      </div>

      {/* Social Sentiment */}
      {(social.reddit || social.stocktwits) && (
        <div className="glass-card p-4 mb-4">
          <h3 className="text-xs text-oracle-muted font-medium mb-3 flex items-center gap-1">
            <MessageCircle size={12} /> Social Sentiment
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {social.reddit && (
              <div className="glass-inner rounded-lg p-3 text-center">
                <div className="text-oracle-text font-bold text-lg">{social.reddit.mentions || 0}</div>
                <div className="text-oracle-muted text-xs">Reddit Mentions</div>
              </div>
            )}
            {social.reddit && (
              <div className="glass-inner rounded-lg p-3 text-center">
                <div className={`font-bold text-lg ${(social.reddit.sentiment || 0) >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
                  {((social.reddit.sentiment || 0) * 100).toFixed(0)}%
                </div>
                <div className="text-oracle-muted text-xs">Reddit Sentiment</div>
              </div>
            )}
            {social.stocktwits && (
              <div className="glass-inner rounded-lg p-3 text-center">
                <div className="text-oracle-green font-bold text-lg">{social.stocktwits.bullish || 0}</div>
                <div className="text-oracle-muted text-xs">Bullish Posts</div>
              </div>
            )}
            {social.stocktwits && (
              <div className="glass-inner rounded-lg p-3 text-center">
                <div className="text-oracle-red font-bold text-lg">{social.stocktwits.bearish || 0}</div>
                <div className="text-oracle-muted text-xs">Bearish Posts</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* News Articles */}
      {news.length > 0 && (
        <div className="glass-card p-4 mb-4">
          <h3 className="text-xs text-oracle-muted font-medium mb-3 flex items-center gap-1">
            <Newspaper size={12} /> Latest News
          </h3>
          <div className="space-y-3">
            {news.map((article, i) => (
              <a
                key={i}
                href={article.url || article.link}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-3 glass-inner rounded-lg hover:bg-white/[0.03] transition-all duration-300"
              >
                <p className="text-oracle-text text-sm font-medium leading-snug">
                  {article.title}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  {article.source && (
                    <span className="text-oracle-accent text-xs">{article.source}</span>
                  )}
                  {article.publishedAt && (
                    <span className="text-oracle-muted text-xs">
                      <TimeAgo date={article.publishedAt} />
                    </span>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Refresh button */}
      <button
        onClick={refresh}
        className="w-full py-3 glass-card text-oracle-muted text-sm font-medium hover:text-oracle-accent hover:border-oracle-accent/50 transition-all flex items-center justify-center gap-2"
      >
        <RefreshCw size={14} />
        Refresh Data
      </button>
    </div>
  )
}
