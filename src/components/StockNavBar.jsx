import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const API = import.meta.env.VITE_API_URL || ''

function getScoreClasses(score, isActive) {
  if (!isActive) return 'bg-white/5 text-oracle-muted border-transparent hover:bg-white/10 hover:text-oracle-text'
  if (score >= 70) return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
  if (score >= 50) return 'bg-amber-500/20 text-amber-400 border-amber-500/40'
  return 'bg-red-500/20 text-red-400 border-red-500/40'
}

export default function StockNavBar({ currentSymbol }) {
  const navigate = useNavigate()
  const [stocks, setStocks] = useState([])
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

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

  // Check scroll overflow state
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 4)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4)
  }, [])

  // Auto-scroll to current stock
  useEffect(() => {
    if (!scrollRef.current || stocks.length === 0) return
    const idx = stocks.findIndex(s => s.symbol === currentSymbol)
    if (idx < 0) return
    const el = scrollRef.current.children[idx]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
      setTimeout(updateScrollState, 400)
    }
  }, [currentSymbol, stocks, updateScrollState])

  // Listen for scroll events
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState, { passive: true })
    updateScrollState()
    return () => el.removeEventListener('scroll', updateScrollState)
  }, [stocks, updateScrollState])

  if (stocks.length === 0) return null

  const currentIdx = stocks.findIndex(s => s.symbol === currentSymbol)
  const prevStock = currentIdx > 0 ? stocks[currentIdx - 1] : null
  const nextStock = currentIdx < stocks.length - 1 ? stocks[currentIdx + 1] : null

  const scrollBy = (dir) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: dir * 150, behavior: 'smooth' })
  }

  return (
    <div className="mb-4">
      {/* Position indicator */}
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-oracle-muted text-[11px] font-medium">
          {currentIdx >= 0 ? `${currentIdx + 1} of ${stocks.length}` : `${stocks.length} picks`}
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={() => prevStock && navigate(`/stock/${prevStock.symbol}`)}
            disabled={!prevStock}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              prevStock
                ? 'glass-card text-oracle-accent active:scale-95'
                : 'text-oracle-muted/20 cursor-default'
            }`}
          >
            <ChevronLeft size={14} />
            {prevStock ? prevStock.symbol : 'Prev'}
          </button>
          <button
            onClick={() => nextStock && navigate(`/stock/${nextStock.symbol}`)}
            disabled={!nextStock}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              nextStock
                ? 'glass-card text-oracle-accent active:scale-95'
                : 'text-oracle-muted/20 cursor-default'
            }`}
          >
            {nextStock ? nextStock.symbol : 'Next'}
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Horizontal scrollable stock pills */}
      <div className="relative">
        {/* Left fade */}
        {canScrollLeft && (
          <div
            className="absolute left-0 top-0 bottom-0 w-8 z-10 pointer-events-none"
            style={{ background: 'linear-gradient(to right, var(--color-oracle-bg), transparent)' }}
          />
        )}
        {/* Right fade */}
        {canScrollRight && (
          <div
            className="absolute right-0 top-0 bottom-0 w-8 z-10 pointer-events-none"
            style={{ background: 'linear-gradient(to left, var(--color-oracle-bg), transparent)' }}
          />
        )}

        <div
          ref={scrollRef}
          className="flex gap-2 overflow-x-auto scrollbar-hide px-1 py-1"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {stocks.map(s => {
            const isActive = s.symbol === currentSymbol
            const classes = getScoreClasses(s.score, isActive)
            const changePct = s.change != null ? s.change.toFixed(1) : null
            return (
              <button
                key={s.symbol}
                onClick={() => navigate(`/stock/${s.symbol}`)}
                className={`shrink-0 px-3 py-2 rounded-xl text-xs font-bold border transition-all duration-200 active:scale-95 ${classes} ${
                  isActive ? 'scale-105 shadow-lg' : ''
                }`}
              >
                <span className="block">{s.symbol}</span>
                {isActive && changePct && (
                  <span className={`block text-[10px] font-medium mt-0.5 ${
                    s.change >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'
                  }`}>
                    {s.change >= 0 ? '+' : ''}{changePct}%
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
