import { useState, useEffect, useCallback, useRef } from 'react'

// ── Helper: merge fresh prices into existing stocks ──
function mergePrices(stocks, prices) {
  if (!prices || Object.keys(prices).length === 0) return stocks
  return stocks.map(s => {
    const fresh = prices[s.symbol]
    if (!fresh) return s
    return {
      ...s,
      price: fresh.price ?? s.price,
      change: fresh.change ?? s.change,
      entrySignal: fresh.entrySignal ?? s.entrySignal,
      entryLabel: fresh.entryLabel ?? s.entryLabel,
      entryReason: fresh.entryReason ?? s.entryReason,
    }
  })
}

// ── Hook: Live price refresh every 60s ──
function useLivePrices(stocks, enabled = true) {
  const [liveStocks, setLiveStocks] = useState(stocks)
  const [lastUpdated, setLastUpdated] = useState(null)
  const stocksRef = useRef(stocks)

  useEffect(() => {
    stocksRef.current = stocks
    setLiveStocks(stocks)
  }, [stocks])

  useEffect(() => {
    if (!enabled || stocksRef.current.length === 0) return

    let intervalId = null;

    const refresh = async () => {
      // Don't waste API calls if tab is not visible
      if (document.visibilityState === 'hidden') return;

      const symbols = stocksRef.current.map(s => s.symbol).join(',')
      if (!symbols) return
      try {
        const res = await fetch(`/api/prices?symbols=${symbols}`)
        if (!res.ok) return
        const data = await res.json()
        setLiveStocks(prev => mergePrices(prev, data.prices))
        setLastUpdated(data.updatedAt || new Date().toISOString())
      } catch { /* silent */ }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh(); // Refresh immediately when coming back to tab
        intervalId = setInterval(refresh, 60000);
      } else {
        if (intervalId) clearInterval(intervalId);
      }
    };

    // Initial start
    if (document.visibilityState === 'visible') {
      intervalId = setInterval(refresh, 60000)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled])

  return { liveStocks, lastUpdated }
}

export function usePredictions() {
  const [stocks, setStocks] = useState([])
  const [marketRegime, setMarketRegime] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchPredictions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/predictions')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStocks(data.predictions || data || [])
      if (data.marketRegime) setMarketRegime(data.marketRegime)
    } catch (err) {
      setError(err.message || 'Failed to fetch predictions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPredictions()
  }, [fetchPredictions])

  const { liveStocks, lastUpdated } = useLivePrices(stocks, !loading)

  return { stocks: liveStocks, loading, error, refresh: fetchPredictions, lastUpdated, marketRegime }
}

export function useTomorrow() {
  const [stocks, setStocks] = useState([])
  const [tomorrowDate, setTomorrowDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchTomorrow = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/tomorrow')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStocks(data.predictions || data || [])
      setTomorrowDate(data.tomorrowDate || '')
    } catch (err) {
      setError(err.message || 'Failed to fetch tomorrow picks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTomorrow()
  }, [fetchTomorrow])

  const { liveStocks, lastUpdated } = useLivePrices(stocks, !loading)

  return { stocks: liveStocks, tomorrowDate, loading, error, refresh: fetchTomorrow, lastUpdated }
}

export function useStockDetail(symbol) {
  const [stock, setStock] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchStock = useCallback(async () => {
    if (!symbol) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/stock/${symbol}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStock(data)
    } catch (err) {
      setError(err.message || 'Failed to fetch stock details')
    } finally {
      setLoading(false)
    }
  }, [symbol])

  useEffect(() => {
    fetchStock()
  }, [fetchStock])

  return { stock, loading, error, refresh: fetchStock }
}

export function useSectors() {
  const [sectors, setSectors] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchSectors = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/sectors')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSectors(data.sectors || data || [])
    } catch (err) {
      setError(err.message || 'Failed to fetch sectors')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSectors()
  }, [fetchSectors])

  return { sectors, loading, error, refresh: fetchSectors }
}

export function useSectorDetail(sectorName) {
  const [stocks, setStocks] = useState([])
  const [sectorInfo, setSectorInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchSectorDetail = useCallback(async () => {
    if (!sectorName) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sectors/${encodeURIComponent(sectorName)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStocks(data.stocks || [])
      setSectorInfo({ sector: data.sector, date: data.date, stockCount: data.stockCount })
    } catch (err) {
      setError(err.message || 'Failed to fetch sector details')
    } finally {
      setLoading(false)
    }
  }, [sectorName])

  useEffect(() => {
    fetchSectorDetail()
  }, [fetchSectorDetail])

  const { liveStocks, lastUpdated } = useLivePrices(stocks, !loading)

  return { stocks: liveStocks, sectorInfo, loading, error, refresh: fetchSectorDetail, lastUpdated }
}

export function useTrending() {
  const [trending, setTrending] = useState([])
  const [news, setNews] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchTrending = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/trending')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTrending(data.trending || data.stocks || data || [])
      setNews(data.marketNews || data.news || [])
    } catch (err) {
      setError(err.message || 'Failed to fetch trending')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTrending()
  }, [fetchTrending])

  return { trending, news, loading, error, refresh: fetchTrending }
}
