import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const API = import.meta.env.VITE_API_URL || ''

export default function StockNavBar({ currentSymbol }) {
  const navigate = useNavigate()
  const [stocks, setStocks] = useState([])
  const scrollRef = useRef(null)

  // Load prediction list for navigation
  useEffect(() => {
    const cached = sessionStorage.getItem('nav_stocks')
    if (cached) {
      try {
        setStocks(JSON.parse(cached))
        return
      } catch {}
    }

    fetch(`${API}/api/predictions`)
      .then(r => r.json())
      .then(d => {
        const list = (d.predictions || []).map(s => ({
          symbol: s.symbol,
          score: s.score,
          change: s.change
        }))
        setStocks(list)
        sessionStorage.setItem('nav_stocks', JSON.stringify(list))
      })
      .catch(() => {})
  }, [])

  // Auto-scroll to current stock
  useEffect(() => {
    if (!scrollRef.current || stocks.length === 0) return
    const idx = stocks.findIndex(s => s.symbol === currentSymbol)
    if (idx < 0) return
    const el = scrollRef.current.children[idx]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }, [currentSymbol, stocks])

  if (stocks.length === 0) return null

  const currentIdx = stocks.findIndex(s => s.symbol === currentSymbol)
  const prevStock = currentIdx > 0 ? stocks[currentIdx - 1] : null
  const nextStock = currentIdx < stocks.length - 1 ? stocks[currentIdx + 1] : null

  return (
    <div className="mb-3">
      {/* Prev/Next arrows */}
      <div className="flex items-center gap-1 mb-1.5">
        <button
          onClick={() => prevStock && navigate(`/stock/${prevStock.symbol}`)}
          disabled={!prevStock}
          className={`p-1 rounded-lg transition-all ${prevStock ? 'text-oracle-accent hover:bg-white/10 active:scale-95' : 'text-oracle-muted/20'}`}
        >
          <ChevronLeft size={16} />
        </button>

        {/* Horizontal scrollable stock pills */}
        <div
          ref={scrollRef}
          className="flex-1 flex gap-1 overflow-x-auto scrollbar-hide"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {stocks.map(s => {
            const isActive = s.symbol === currentSymbol
            const scoreColor = s.score >= 70 ? 'oracle-green' : s.score >= 50 ? 'oracle-yellow' : 'oracle-red'
            return (
              <button
                key={s.symbol}
                onClick={() => navigate(`/stock/${s.symbol}`)}
                className={`shrink-0 px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                  isActive
                    ? `bg-${scoreColor}/20 text-${scoreColor} border border-${scoreColor}/40 scale-105`
                    : 'text-oracle-muted hover:text-oracle-text hover:bg-white/5'
                }`}
              >
                {s.symbol}
              </button>
            )
          })}
        </div>

        <button
          onClick={() => nextStock && navigate(`/stock/${nextStock.symbol}`)}
          disabled={!nextStock}
          className={`p-1 rounded-lg transition-all ${nextStock ? 'text-oracle-accent hover:bg-white/10 active:scale-95' : 'text-oracle-muted/20'}`}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}
