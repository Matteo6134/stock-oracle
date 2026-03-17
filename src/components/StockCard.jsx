import { useNavigate } from 'react-router-dom'
import { TrendingUp, TrendingDown, Zap, Calendar, Target, CircleCheck, AlertTriangle, XCircle, Clock } from 'lucide-react'
import BrokerBadge from './BrokerBadge'

function getScoreBorderColor(score) {
  if (score >= 70) return 'border-l-oracle-green'
  if (score >= 50) return 'border-l-oracle-yellow'
  return 'border-l-oracle-red'
}

function getScoreTextColor(score) {
  if (score >= 70) return 'text-oracle-green'
  if (score >= 50) return 'text-oracle-yellow'
  return 'text-oracle-red'
}

function getConfidenceBadge(confidence) {
  if (!confidence) return null
  const lower = confidence.toLowerCase()
  if (lower === 'high') return { label: 'High', cls: 'bg-oracle-green/15 text-oracle-green border-oracle-green/30' }
  if (lower === 'medium') return { label: 'Medium', cls: 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30' }
  return { label: 'Low', cls: 'bg-oracle-red/15 text-oracle-red border-oracle-red/30' }
}

const breakdownColors = ['bg-blue-500', 'bg-emerald-500', 'bg-yellow-500', 'bg-cyan-500', 'bg-orange-500', 'bg-purple-500']
const breakdownLabels = ['Cat', 'EPS', 'Rev', 'Tech', 'News', 'Liq']
const breakdownMaxes = [12, 25, 18, 25, 10, 5]

export default function StockCard({ stock, rank }) {
  const navigate = useNavigate()
  const {
    symbol,
    name,
    companyName,
    score = 0,
    probability = 0,
    confidence,
    sector,
    change = 0,
    price = 0,
    breakdown = {},
    brokers,
    brokerAvailability,
    upcomingEvents = [],
    hasEarningsToday,
    hasEarningsTomorrow,
    analystBuyPct,
    socialMentions,
    newsCount,
    entrySignal,
    entryLabel,
    entryReason,
    earningsTiming,
  } = stock

  const getEarningsStatus = (timing) => {
    if (!timing || timing === 'N/A') return null;
    
    // Get current New York time
    const nyTimeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).format(new Date());
    
    const [hour, minute] = nyTimeStr.split(':').map(Number);
    const totalMinutes = hour * 60 + minute;
    
    if (timing === 'BMO') {
      // BMO = Before Market Open (before 9:30 AM ET)
      if (totalMinutes >= 570) return { label: 'Reported @ 09:30', finished: true };
      return { label: 'Earnings @ 09:30', finished: false };
    }
    if (timing === 'AMC') {
      // AMC = After Market Close (after 4:00 PM ET)
      if (totalMinutes >= 960) return { label: 'Reported @ 16:00', finished: true };
      return { label: 'Earnings @ 16:00', finished: false };
    }
    return null;
  };

  const earningsStatus = getEarningsStatus(earningsTiming);
  const brokerData = brokers || brokerAvailability || {};

  const isPositive = change >= 0
  const confidenceBadge = getConfidenceBadge(confidence)
  const breakdownValues = [
    breakdown.catalyst ?? breakdown.earnings ?? breakdown.fundamental ?? 0,
    breakdown.earningsQuality ?? 0,
    breakdown.revision ?? 0,
    breakdown.technical ?? 0,
    breakdown.news ?? 0,
    breakdown.liquidity ?? 0,
  ]

  const hasEarningsResult = stock.earningsResult?.isReported;
  const isBigMove = hasEarningsResult && Math.abs(stock.earningsResult.reaction) >= 5;
  const glowClass = isBigMove 
    ? stock.earningsResult.sentiment === 'bullish' 
      ? 'shadow-[0_0_15px_rgba(16,185,129,0.3)] border-oracle-green/30' 
      : 'shadow-[0_0_15px_rgba(239,68,68,0.3)] border-oracle-red/30'
    : '';

  const borderClass = getScoreBorderColor(score);

  return (
    <div
      onClick={() => navigate(`/stock/${symbol}`)}
      className={`glass-card p-4 relative overflow-hidden transition-all duration-300 hover:bg-white/[0.03] active:scale-[0.98] cursor-pointer group border-l-4 ${borderClass} ${glowClass}`}
    >
      <div className="flex items-start justify-between">
        {/* Left side: stock info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {rank && (
              <span className="text-oracle-muted text-xs font-medium">#{rank}</span>
            )}
            <span className="text-oracle-text font-bold text-base">{symbol}</span>
            <span className="text-oracle-muted text-sm truncate">{companyName || name || symbol}</span>
          </div>

          {/* Trade Setup */}
          {stock.tradeSetup?.available && (
            <div className="mb-1.5 space-y-1">
              {/* Risk badge */}
              <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold border ${
                stock.tradeSetup.riskLevel === 'secure'
                  ? 'bg-oracle-green/15 text-oracle-green border-oracle-green/30'
                  : stock.tradeSetup.riskLevel === 'moderate'
                    ? 'bg-oracle-accent/15 text-oracle-accent border-oracle-accent/30'
                    : stock.tradeSetup.riskLevel === 'caution'
                      ? 'bg-oracle-yellow/15 text-oracle-yellow border-oracle-yellow/30'
                      : 'bg-oracle-red/15 text-oracle-red border-oracle-red/30'
              }`}>
                {stock.tradeSetup.riskLevel === 'secure' ? <CircleCheck size={10} /> : stock.tradeSetup.riskLevel === 'risky' ? <XCircle size={10} /> : <AlertTriangle size={10} />}
                {stock.tradeSetup.riskLevel === 'secure' ? 'Low Risk' : stock.tradeSetup.riskLevel === 'moderate' ? 'Moderate' : stock.tradeSetup.riskLevel === 'caution' ? 'Caution' : 'High Risk'}
                <span className="opacity-60 ml-0.5">R:R {stock.tradeSetup.riskReward}x</span>
              </div>
              {/* Entry → Target | SL */}
              <div className="flex items-center gap-1.5 text-[10px] font-mono">
                <span className="text-oracle-green">▲ ${stock.tradeSetup.targetPrice}</span>
                <span className="text-oracle-muted">←</span>
                <span className="text-oracle-text font-bold">${stock.tradeSetup.entryPrice}</span>
                <span className="text-oracle-muted">→</span>
                <span className="text-oracle-red">▼ ${stock.tradeSetup.stopLoss}</span>
              </div>
            </div>
          )}

          {/* Upcoming Events - the MAIN forward-looking info */}
          <div className="flex flex-wrap gap-1 mb-2">
            {/* Earnings Result or Status Badge */}
            {stock.earningsResult?.isReported ? (
              <span
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-extrabold border shadow-sm ${
                  stock.earningsResult.sentiment === 'bullish'
                    ? 'bg-oracle-green/20 text-oracle-green border-oracle-green/40 shadow-oracle-green/20'
                    : stock.earningsResult.sentiment === 'bearish'
                      ? 'bg-oracle-red/20 text-oracle-red border-oracle-red/40 shadow-oracle-red/20'
                      : 'bg-oracle-muted/10 text-oracle-muted border-oracle-muted/20'
                }`}
                title={stock.earningsResult.summary}
              >
                {stock.earningsResult.status} ({stock.earningsResult.reaction > 0 ? '+' : ''}{stock.earningsResult.reaction}%)
              </span>
            ) : earningsStatus && (
               <span
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                  earningsStatus.finished
                    ? 'bg-oracle-muted/10 text-oracle-muted border-oracle-muted/20'
                    : 'bg-orange-500/15 text-orange-400 border-orange-500/30 animate-pulse'
                }`}
              >
                <Clock size={8} />
                {earningsStatus.label}
                {earningsStatus.finished && <CircleCheck size={8} className="ml-0.5 text-oracle-green" />}
              </span>
            )}

            {upcomingEvents.length > 0 && upcomingEvents.slice(0, 3).map((evt, i) => {
                const isEarningsToday = evt.includes('TODAY')
                const isEarnings = evt.toLowerCase().includes('earnings')
                // Skip if we already showing the specific earnings status badge for today
                if (isEarningsToday && earningsStatus) return null;

                return (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                      isEarningsToday
                        ? 'bg-oracle-yellow/20 text-oracle-yellow border-oracle-yellow/40 animate-pulse'
                        : isEarnings
                          ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                          : 'bg-oracle-accent/10 text-oracle-accent border-oracle-accent/20'
                    }`}
                  >
                    <Calendar size={8} />
                    {evt}
                  </span>
                )
            })}
          </div>

          <div className="flex items-center gap-2 flex-wrap mb-2.5">
            {sector && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-oracle-accent/15 text-oracle-accent border border-oracle-accent/30">
                {sector}
              </span>
            )}
            {confidenceBadge && (
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${confidenceBadge.cls}`}>
                <Zap size={8} className="inline mr-0.5" />
                {confidenceBadge.label}
              </span>
            )}
            {analystBuyPct != null && analystBuyPct > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-oracle-green/10 text-oracle-green border border-oracle-green/20">
                <Target size={8} className="inline mr-0.5" />
                {analystBuyPct}% Buy
              </span>
            )}
            {brokerData?.etoro && (
              <BrokerBadge name="eToro" available={brokerData.etoro.available} url={brokerData.etoro.url} />
            )}
            {brokerData?.revolut && (
              <BrokerBadge name="Revolut" available={brokerData.revolut.available} url={brokerData.revolut.url} />
            )}
          </div>

          {/* Mini breakdown bars */}
          <div className="flex items-center gap-1">
            {breakdownValues.map((val, i) => (
              <div key={i} className="flex-1" title={`${breakdownLabels[i]}: ${val}/${breakdownMaxes[i]}`}>
                <div className="h-1.5 rounded-full bg-oracle-border overflow-hidden">
                  <div
                    className={`h-full rounded-full ${breakdownColors[i]}`}
                    style={{ width: `${Math.min(100, (val / breakdownMaxes[i]) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-1 mt-0.5">
            {breakdownLabels.map((lbl, i) => (
              <span key={i} className="flex-1 text-[8px] text-oracle-muted text-center">{lbl}</span>
            ))}
          </div>
        </div>

        {/* Right side: score + price */}
        <div className="flex flex-col items-end gap-1.5 ml-3">
          {/* Score circle mini */}
          <div className={`w-11 h-11 rounded-full border-2 flex items-center justify-center font-bold text-sm ${
            score >= 70
              ? 'border-oracle-green text-oracle-green bg-oracle-green/10'
              : score >= 50
                ? 'border-oracle-yellow text-oracle-yellow bg-oracle-yellow/10'
                : 'border-oracle-red text-oracle-red bg-oracle-red/10'
          }`}>
            {Math.round(score)}
          </div>

          {/* Probability */}
          <span className={`text-xs font-semibold ${getScoreTextColor(probability)}`}>
            {probability}%
          </span>

          {/* Price + change */}
          <div className="text-right">
            {price > 0 && (
              <div className="text-oracle-text text-xs font-medium">
                ${typeof price === 'number' ? price.toFixed(2) : price}
              </div>
            )}
            <div className={`flex items-center gap-0.5 text-xs font-medium ${isPositive ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {isPositive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
              {isPositive ? '+' : ''}{typeof change === 'number' ? change.toFixed(2) : change}%
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
