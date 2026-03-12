import { ExternalLink } from 'lucide-react'

const sources = [
  {
    name: 'Yahoo Finance',
    url: (symbol) => `https://finance.yahoo.com/quote/${symbol}`,
    color: 'bg-purple-600/20 text-purple-400 border-purple-500/30',
    dot: 'bg-purple-400',
  },
  {
    name: 'Reddit',
    url: (symbol) => `https://www.reddit.com/search/?q=${symbol}`,
    color: 'bg-orange-600/20 text-orange-400 border-orange-500/30',
    dot: 'bg-orange-400',
  },
  {
    name: 'StockTwits',
    url: (symbol) => `https://stocktwits.com/symbol/${symbol}`,
    color: 'bg-blue-600/20 text-blue-400 border-blue-500/30',
    dot: 'bg-blue-400',
  },
  {
    name: 'TradingView',
    url: (symbol) => `https://www.tradingview.com/symbols/${symbol}`,
    color: 'bg-green-600/20 text-green-400 border-green-500/30',
    dot: 'bg-green-400',
  },
  {
    name: 'X (Twitter)',
    url: (symbol) => `https://x.com/search?q=%24${symbol}`,
    color: 'bg-slate-600/20 text-slate-300 border-slate-500/30',
    dot: 'bg-slate-300',
  },
]

export default function SourceLinks({ symbol }) {
  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((source) => (
        <a
          key={source.name}
          href={source.url(symbol)}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all hover:scale-105 ${source.color}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${source.dot}`} />
          {source.name}
          <ExternalLink size={10} />
        </a>
      ))}
    </div>
  )
}
