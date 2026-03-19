import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  DollarSign, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  RefreshCw, X, ShoppingCart, AlertTriangle, Wallet, BarChart3,
  Clock, CheckCircle, XCircle, Loader2, ExternalLink
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import LoadingSkeleton from '../components/LoadingSkeleton'

const API = import.meta.env.VITE_API_URL || ''

function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0)
}

function formatPct(n) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${(n || 0).toFixed(2)}%`
}

// ── Not Configured State ──
function SetupPrompt() {
  return (
    <div className="max-w-lg mx-auto px-4 pt-8 pb-6">
      <div className="glass-card p-6 text-center">
        <Wallet size={48} className="text-oracle-accent mx-auto mb-4" />
        <h2 className="text-xl font-bold text-oracle-text mb-2">Connect Alpaca</h2>
        <p className="text-oracle-muted text-sm mb-4">
          Paper trade with real market data using Alpaca's free paper trading API.
        </p>
        <ol className="text-left text-oracle-muted text-xs space-y-2 mb-4">
          <li className="flex gap-2"><span className="text-oracle-accent font-bold">1.</span> Sign up at <a href="https://app.alpaca.markets" target="_blank" rel="noopener noreferrer" className="text-oracle-accent underline">alpaca.markets</a></li>
          <li className="flex gap-2"><span className="text-oracle-accent font-bold">2.</span> Go to Paper Trading → API Keys</li>
          <li className="flex gap-2"><span className="text-oracle-accent font-bold">3.</span> Generate a new key pair</li>
          <li className="flex gap-2"><span className="text-oracle-accent font-bold">4.</span> Add to your <code className="text-oracle-accent bg-white/5 px-1 rounded">.env</code> file:
            <pre className="mt-1 text-[10px] bg-white/5 p-2 rounded block w-full">
{`ALPACA_API_KEY=your_key_here
ALPACA_SECRET_KEY=your_secret_here`}
            </pre>
          </li>
          <li className="flex gap-2"><span className="text-oracle-accent font-bold">5.</span> Restart the server</li>
        </ol>
        <p className="text-oracle-muted text-[10px]">Paper trading uses virtual money — no risk to real funds.</p>
      </div>
    </div>
  )
}

// ── Position Card ──
function PositionCard({ position, onClose }) {
  const navigate = useNavigate()
  const isUp = position.unrealizedPL >= 0
  const [closing, setClosing] = useState(false)

  const handleClose = async (e) => {
    e.stopPropagation()
    if (!confirm(`Close ${position.symbol} position? (${position.qty} shares)`)) return
    setClosing(true)
    try {
      const res = await fetch(`${API}/api/alpaca/positions/${position.symbol}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error)
      onClose()
    } catch (err) {
      alert(`Failed to close: ${err.message}`)
    } finally {
      setClosing(false)
    }
  }

  return (
    <div
      className="glass-card p-3 cursor-pointer hover:bg-white/[0.03] transition-all active:scale-[0.98]"
      onClick={() => navigate(`/stock/${position.symbol}`)}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div>
          <span className="text-oracle-text font-bold text-sm">{position.symbol}</span>
          <span className="text-oracle-muted text-[10px] ml-2">{position.qty} shares</span>
        </div>
        <button
          onClick={handleClose}
          disabled={closing}
          className="px-2 py-1 rounded text-[9px] font-semibold bg-oracle-red/15 text-oracle-red border border-oracle-red/30 hover:bg-oracle-red/25 transition-all disabled:opacity-50"
        >
          {closing ? <Loader2 size={10} className="animate-spin" /> : 'CLOSE'}
        </button>
      </div>
      <div className="flex items-center justify-between text-[10px]">
        <div className="text-oracle-muted">
          Avg {formatMoney(position.avgEntryPrice)} → {formatMoney(position.currentPrice)}
        </div>
        <div className={`font-bold ${isUp ? 'text-oracle-green' : 'text-oracle-red'}`}>
          {formatMoney(position.unrealizedPL)} ({formatPct(position.unrealizedPLPct)})
        </div>
      </div>
      <div className="mt-1 h-1 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isUp ? 'bg-oracle-green' : 'bg-oracle-red'}`}
          style={{ width: `${Math.min(Math.abs(position.unrealizedPLPct), 100)}%` }}
        />
      </div>
    </div>
  )
}

// ── Order Card ──
function OrderCard({ order, onCancel }) {
  const statusColors = {
    new: 'text-oracle-accent',
    partially_filled: 'text-oracle-yellow',
    filled: 'text-oracle-green',
    canceled: 'text-oracle-muted',
    expired: 'text-oracle-muted',
    rejected: 'text-oracle-red',
    pending_new: 'text-oracle-accent',
  }

  return (
    <div className="glass-card p-2.5 flex items-center justify-between gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-oracle-text font-bold text-xs">{order.symbol}</span>
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${order.side === 'buy' ? 'bg-oracle-green/15 text-oracle-green' : 'bg-oracle-red/15 text-oracle-red'}`}>
            {order.side.toUpperCase()}
          </span>
          <span className={`text-[9px] font-semibold ${statusColors[order.status] || 'text-oracle-muted'}`}>
            {order.status.replace(/_/g, ' ').toUpperCase()}
          </span>
        </div>
        <div className="text-[10px] text-oracle-muted mt-0.5">
          {order.qty > 0 ? `${order.qty} shares` : ''} {order.type} · {new Date(order.createdAt).toLocaleString()}
          {order.filledAvgPrice ? ` · Filled @ ${formatMoney(order.filledAvgPrice)}` : ''}
        </div>
      </div>
      {(order.status === 'new' || order.status === 'pending_new' || order.status === 'partially_filled') && (
        <button
          onClick={() => onCancel(order.id)}
          className="p-1.5 text-oracle-muted hover:text-oracle-red transition-all"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

// ── Main Page ──
export default function AlpacaTradingPage() {
  const [searchParams] = useSearchParams()
  const [configured, setConfigured] = useState(null) // null = loading
  const [account, setAccount] = useState(null)
  const [positions, setPositions] = useState([])
  const [orders, setOrders] = useState([])
  const [history, setHistory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('positions') // positions | orders | history | agents
  const [autoConfig, setAutoConfig] = useState(null)
  const [agentLog, setAgentLog] = useState([])

  // Trade form
  const [tradeSymbol, setTradeSymbol] = useState(searchParams.get('symbol') || '')
  const [tradeAmount, setTradeAmount] = useState(searchParams.get('amount') || '')
  const [tradeMode, setTradeMode] = useState('dollars') // dollars | shares
  const [tradeSide, setTradeSide] = useState('buy')
  const [tradeType, setTradeType] = useState('market')
  const [limitPrice, setLimitPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tradeResult, setTradeResult] = useState(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const statusRes = await fetch(`${API}/api/alpaca/status`)
      const { configured: isConfigured } = await statusRes.json()
      setConfigured(isConfigured)
      if (!isConfigured) { setLoading(false); return }

      const [accRes, posRes, ordRes] = await Promise.all([
        fetch(`${API}/api/alpaca/account`),
        fetch(`${API}/api/alpaca/positions`),
        fetch(`${API}/api/alpaca/orders?status=all&limit=20`),
      ])

      if (!accRes.ok) throw new Error((await accRes.json()).error)
      setAccount(await accRes.json())
      setPositions(posRes.ok ? await posRes.json() : [])
      setOrders(ordRes.ok ? await ordRes.json() : [])

      // Fetch auto-trade config + log
      const [cfgRes, logRes] = await Promise.all([
        fetch(`${API}/api/auto-trade/config`).catch(() => null),
        fetch(`${API}/api/auto-trade/log`).catch(() => null),
      ])
      if (cfgRes?.ok) setAutoConfig(await cfgRes.json())
      if (logRes?.ok) setAgentLog(await logRes.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchHistory = useCallback(async (period = '1M') => {
    try {
      const res = await fetch(`${API}/api/alpaca/history?period=${period}`)
      if (res.ok) setHistory(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => { if (configured && tab === 'history') fetchHistory() }, [configured, tab, fetchHistory])

  // Auto-refresh every 30s
  useEffect(() => {
    if (!configured) return
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [configured, fetchAll])

  const handleTrade = async () => {
    if (!tradeSymbol.trim()) return
    if (!tradeAmount || parseFloat(tradeAmount) <= 0) return

    setSubmitting(true)
    setTradeResult(null)
    try {
      const body = {
        symbol: tradeSymbol.toUpperCase(),
        side: tradeSide,
        type: tradeType,
      }
      if (tradeMode === 'dollars') {
        body.notional = parseFloat(tradeAmount)
      } else {
        body.qty = parseFloat(tradeAmount)
      }
      if (tradeType === 'limit' && limitPrice) {
        body.limitPrice = parseFloat(limitPrice)
      }

      const res = await fetch(`${API}/api/alpaca/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setTradeResult({ success: true, order: data })
      setTradeSymbol('')
      setTradeAmount('')
      setLimitPrice('')
      setTimeout(fetchAll, 1500) // refresh after fill
    } catch (err) {
      setTradeResult({ success: false, error: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleAutoTrade = async () => {
    try {
      const res = await fetch(`${API}/api/auto-trade/toggle`, { method: 'POST' })
      if (res.ok) {
        const config = await res.json()
        setAutoConfig(config)
      }
    } catch { /* ignore */ }
  }

  const handleUpdateConfig = async (updates) => {
    try {
      const res = await fetch(`${API}/api/auto-trade/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (res.ok) setAutoConfig(await res.json())
    } catch { /* ignore */ }
  }

  const handleCancelOrder = async (orderId) => {
    try {
      await fetch(`${API}/api/alpaca/orders/${orderId}`, { method: 'DELETE' })
      fetchAll()
    } catch { /* ignore */ }
  }

  if (configured === null) return <div className="max-w-lg mx-auto px-4 pt-4"><LoadingSkeleton count={4} /></div>
  if (configured === false) return <SetupPrompt />

  const totalPL = positions.reduce((s, p) => s + p.unrealizedPL, 0)
  const openOrders = orders.filter(o => ['new', 'pending_new', 'partially_filled'].includes(o.status))
  const recentOrders = orders.filter(o => !['new', 'pending_new'].includes(o.status)).slice(0, 15)

  // Equity chart data
  const chartData = history?.timestamps?.map((ts, i) => ({
    date: new Date(ts * 1000).toLocaleDateString(),
    equity: history.equity[i],
  })) || []

  return (
    <div className="max-w-lg mx-auto px-4 pt-1 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold text-oracle-text flex items-center gap-2">
            <DollarSign className="text-oracle-accent" size={22} />
            Paper Trading
          </h1>
          <p className="text-oracle-muted text-xs mt-0.5">Alpaca paper trading — real market, virtual money</p>
        </div>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="p-2.5 glass-card text-oracle-muted hover:text-oracle-accent transition-all active:scale-95 disabled:opacity-50"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="glass-card border-l-4 border-l-oracle-red p-3 mb-3">
          <p className="text-oracle-red text-xs font-medium">{error}</p>
          <button onClick={fetchAll} className="mt-1 text-oracle-accent text-[10px]">Retry</button>
        </div>
      )}

      {/* Account Overview */}
      {account && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="glass-card p-2.5 text-center">
            <p className="text-oracle-accent font-bold text-lg">{formatMoney(account.equity)}</p>
            <p className="text-oracle-muted text-[10px]">EQUITY</p>
          </div>
          <div className="glass-card p-2.5 text-center">
            <p className="text-oracle-green font-bold text-lg">{formatMoney(account.buyingPower)}</p>
            <p className="text-oracle-muted text-[10px]">BUYING POWER</p>
          </div>
          <div className="glass-card p-2.5 text-center">
            <p className={`font-bold text-sm ${account.dayPL >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {formatMoney(account.dayPL)} ({formatPct(account.dayPLPct)})
            </p>
            <p className="text-oracle-muted text-[10px]">TODAY P/L</p>
          </div>
          <div className="glass-card p-2.5 text-center">
            <p className={`font-bold text-sm ${totalPL >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
              {formatMoney(totalPL)}
            </p>
            <p className="text-oracle-muted text-[10px]">OPEN P/L</p>
          </div>
        </div>
      )}

      {/* Quick Trade Form */}
      <div className="glass-card p-3 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <ShoppingCart size={14} className="text-oracle-accent" />
          <span className="text-xs font-semibold text-oracle-text">Quick Trade</span>
        </div>

        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={tradeSymbol}
            onChange={e => setTradeSymbol(e.target.value.toUpperCase())}
            placeholder="SYMBOL"
            className="flex-1 bg-white/5 border border-oracle-border rounded px-2.5 py-1.5 text-oracle-text text-xs placeholder:text-oracle-muted/50 focus:outline-none focus:border-oracle-accent/50"
          />
          <input
            type="number"
            value={tradeAmount}
            onChange={e => setTradeAmount(e.target.value)}
            placeholder={tradeMode === 'dollars' ? 'Amount $' : 'Shares'}
            className="w-24 bg-white/5 border border-oracle-border rounded px-2.5 py-1.5 text-oracle-text text-xs placeholder:text-oracle-muted/50 focus:outline-none focus:border-oracle-accent/50"
          />
        </div>

        <div className="flex gap-1.5 mb-2">
          {/* Buy/Sell toggle */}
          <button
            onClick={() => setTradeSide('buy')}
            className={`flex-1 py-1.5 rounded text-[10px] font-bold transition-all ${tradeSide === 'buy' ? 'bg-oracle-green/25 text-oracle-green border border-oracle-green/50' : 'glass-card text-oracle-muted border border-oracle-border'}`}
          >
            BUY
          </button>
          <button
            onClick={() => setTradeSide('sell')}
            className={`flex-1 py-1.5 rounded text-[10px] font-bold transition-all ${tradeSide === 'sell' ? 'bg-oracle-red/25 text-oracle-red border border-oracle-red/50' : 'glass-card text-oracle-muted border border-oracle-border'}`}
          >
            SELL
          </button>
          {/* Dollars/Shares toggle */}
          <button
            onClick={() => setTradeMode(tradeMode === 'dollars' ? 'shares' : 'dollars')}
            className="px-2.5 py-1.5 glass-card text-oracle-muted text-[10px] font-semibold border border-oracle-border hover:text-oracle-accent transition-all"
          >
            {tradeMode === 'dollars' ? '$ USD' : '# QTY'}
          </button>
          {/* Market/Limit toggle */}
          <button
            onClick={() => setTradeType(tradeType === 'market' ? 'limit' : 'market')}
            className="px-2.5 py-1.5 glass-card text-oracle-muted text-[10px] font-semibold border border-oracle-border hover:text-oracle-accent transition-all"
          >
            {tradeType.toUpperCase()}
          </button>
        </div>

        {tradeType === 'limit' && (
          <input
            type="number"
            value={limitPrice}
            onChange={e => setLimitPrice(e.target.value)}
            placeholder="Limit price"
            step="0.01"
            className="w-full bg-white/5 border border-oracle-border rounded px-2.5 py-1.5 text-oracle-text text-xs placeholder:text-oracle-muted/50 focus:outline-none focus:border-oracle-accent/50 mb-2"
          />
        )}

        <button
          onClick={handleTrade}
          disabled={submitting || !tradeSymbol.trim() || !tradeAmount}
          className={`w-full py-2 rounded font-bold text-xs transition-all disabled:opacity-40 ${
            tradeSide === 'buy'
              ? 'bg-oracle-green/20 text-oracle-green border border-oracle-green/40 hover:bg-oracle-green/30'
              : 'bg-oracle-red/20 text-oracle-red border border-oracle-red/40 hover:bg-oracle-red/30'
          }`}
        >
          {submitting ? <Loader2 size={14} className="animate-spin mx-auto" /> : `${tradeSide.toUpperCase()} ${tradeSymbol || '...'}`}
        </button>

        {tradeResult && (
          <div className={`mt-2 p-2 rounded text-[10px] ${tradeResult.success ? 'bg-oracle-green/10 text-oracle-green border border-oracle-green/20' : 'bg-oracle-red/10 text-oracle-red border border-oracle-red/20'}`}>
            {tradeResult.success
              ? `Order ${tradeResult.order.status}: ${tradeResult.order.side} ${tradeResult.order.symbol} ${tradeResult.order.qty > 0 ? tradeResult.order.qty + ' shares' : formatMoney(tradeResult.order.notional)}`
              : tradeResult.error}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-3">
        {[
          { key: 'positions', label: `Positions (${positions.length})` },
          { key: 'orders', label: `Orders (${openOrders.length})` },
          { key: 'agents', label: 'Agents' },
          { key: 'history', label: 'Equity' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
              tab === t.key ? 'bg-oracle-accent/20 text-oracle-accent border-oracle-accent/40' : 'glass-card text-oracle-muted border-oracle-border'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Positions */}
      {tab === 'positions' && (
        <div className="space-y-2">
          {positions.length === 0 && (
            <div className="py-8 text-center">
              <Wallet size={32} className="text-oracle-muted/30 mx-auto mb-2" />
              <p className="text-oracle-muted text-sm">No open positions</p>
              <p className="text-oracle-muted text-[10px] mt-1">Use the trade form above or buy from Gem Finder</p>
            </div>
          )}
          {positions.map(p => (
            <PositionCard key={p.symbol} position={p} onClose={fetchAll} />
          ))}
        </div>
      )}

      {/* Orders */}
      {tab === 'orders' && (
        <div className="space-y-2">
          {openOrders.length > 0 && (
            <div className="mb-2">
              <p className="text-oracle-muted text-[10px] font-semibold mb-1">PENDING</p>
              <div className="space-y-1.5">
                {openOrders.map(o => (
                  <OrderCard key={o.id} order={o} onCancel={handleCancelOrder} />
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-oracle-muted text-[10px] font-semibold mb-1">RECENT</p>
            {recentOrders.length === 0 ? (
              <div className="py-6 text-center">
                <Clock size={24} className="text-oracle-muted/30 mx-auto mb-1" />
                <p className="text-oracle-muted text-xs">No recent orders</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentOrders.map(o => (
                  <OrderCard key={o.id} order={o} onCancel={handleCancelOrder} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent Auto-Trading */}
      {tab === 'agents' && autoConfig && (
        <div className="space-y-3">
          {/* Toggle */}
          <div className="glass-card p-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-oracle-text text-sm font-bold">Agent Auto-Trading</p>
                <p className="text-oracle-muted text-[10px]">Agents scan gems + pennies every 5 min and auto-execute trades</p>
              </div>
              <button
                onClick={handleToggleAutoTrade}
                className={`px-4 py-1.5 rounded-full text-[10px] font-bold transition-all border ${
                  autoConfig.enabled
                    ? 'bg-oracle-green/25 text-oracle-green border-oracle-green/50'
                    : 'bg-white/5 text-oracle-muted border-oracle-border'
                }`}
              >
                {autoConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>

            {autoConfig.enabled && (
              <div className="mt-3 pt-3 border-t border-oracle-border space-y-3">
                {/* Budget */}
                <div className="p-2 bg-oracle-accent/5 rounded border border-oracle-accent/20">
                  <p className="text-oracle-accent text-[9px] font-bold mb-1">BUDGET</p>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Max Budget $</label>
                      <input type="number" value={autoConfig.maxBudget || 1000}
                        onChange={e => handleUpdateConfig({ maxBudget: parseInt(e.target.value) || 1000 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Strong Buy $</label>
                      <input type="number" value={autoConfig.strongBuyAmount}
                        onChange={e => handleUpdateConfig({ strongBuyAmount: parseInt(e.target.value) || 200 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Max Pos.</label>
                      <input type="number" value={autoConfig.maxPositions}
                        onChange={e => handleUpdateConfig({ maxPositions: parseInt(e.target.value) || 5 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                  </div>
                </div>

                {/* Risk Management */}
                <div className="p-2 bg-oracle-red/5 rounded border border-oracle-red/20">
                  <p className="text-oracle-red text-[9px] font-bold mb-1">RISK MANAGEMENT</p>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Stop Loss %</label>
                      <input type="number" value={autoConfig.defaultStopPct}
                        onChange={e => handleUpdateConfig({ defaultStopPct: parseInt(e.target.value) || 5 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Take Profit %</label>
                      <input type="number" value={autoConfig.takeProfitPct}
                        onChange={e => handleUpdateConfig({ takeProfitPct: parseInt(e.target.value) || 10 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Trail Stop %</label>
                      <input type="number" value={autoConfig.trailingStopPct || 3}
                        onChange={e => handleUpdateConfig({ trailingStopPct: parseInt(e.target.value) || 3 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                  </div>
                </div>

                {/* Quality Filters */}
                <div className="p-2 bg-oracle-green/5 rounded border border-oracle-green/20">
                  <p className="text-oracle-green text-[9px] font-bold mb-1">QUALITY FILTERS</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Min Gem Score</label>
                      <input type="number" value={autoConfig.minGemScore}
                        onChange={e => handleUpdateConfig({ minGemScore: parseInt(e.target.value) || 60 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Min Conviction</label>
                      <input type="number" value={autoConfig.minConviction}
                        onChange={e => handleUpdateConfig({ minConviction: parseInt(e.target.value) || 4 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="text-oracle-muted text-[8px] block mb-0.5">Max Stock Price $</label>
                      <input type="number" value={autoConfig.maxStockPrice || 5}
                        onChange={e => handleUpdateConfig({ maxStockPrice: parseFloat(e.target.value) || 5 })}
                        className="w-full bg-white/5 border border-oracle-border rounded px-2 py-1 text-oracle-text text-[11px]" />
                    </div>
                  </div>
                  <div className="flex gap-3 mt-2">
                    <label className="flex items-center gap-1 text-[9px] text-oracle-muted cursor-pointer">
                      <input type="checkbox" checked={autoConfig.onlyStrongBuy !== false}
                        onChange={e => handleUpdateConfig({ onlyStrongBuy: e.target.checked })}
                        className="rounded" />
                      Strong Buy only
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-oracle-muted cursor-pointer">
                      <input type="checkbox" checked={autoConfig.requireOrderFlow !== false}
                        onChange={e => handleUpdateConfig({ requireOrderFlow: e.target.checked })}
                        className="rounded" />
                      Require order flow
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Agent Trade Log */}
          <div className="glass-card p-3">
            <p className="text-oracle-muted text-[10px] font-semibold mb-2">AGENT TRADE LOG</p>
            {agentLog.length === 0 ? (
              <div className="py-6 text-center">
                <Clock size={24} className="text-oracle-muted/30 mx-auto mb-1" />
                <p className="text-oracle-muted text-xs">No agent trades yet</p>
                <p className="text-oracle-muted text-[10px] mt-1">{autoConfig.enabled ? 'Agents will trade on next scan cycle (every 5 min)' : 'Toggle auto-trading ON to start'}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {agentLog.slice(0, 20).map(trade => (
                  <div key={trade.id} className="p-2 bg-white/[0.02] rounded border border-oracle-border">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-oracle-text font-bold text-xs">{trade.symbol}</span>
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${trade.side === 'buy' ? 'bg-oracle-green/15 text-oracle-green' : 'bg-oracle-red/15 text-oracle-red'}`}>
                          {trade.side.toUpperCase()}
                        </span>
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                          trade.consensus === 'Strong Buy' ? 'bg-oracle-green/15 text-oracle-green' : 'bg-oracle-accent/15 text-oracle-accent'
                        }`}>
                          {trade.consensus}
                        </span>
                      </div>
                      <span className="text-oracle-muted text-[9px]">{formatMoney(trade.amount)}</span>
                    </div>
                    <div className="text-[9px] text-oracle-muted">
                      {trade.agents?.join(', ')} · Score {trade.gemScore} · {trade.source}
                    </div>
                    {trade.pnl != null && (
                      <div className={`text-[9px] font-semibold mt-1 ${trade.pnl >= 0 ? 'text-oracle-green' : 'text-oracle-red'}`}>
                        {trade.exitReason} → {formatMoney(trade.pnl)}
                      </div>
                    )}
                    <div className="text-[8px] text-oracle-muted/60 mt-0.5">{new Date(trade.timestamp).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Equity Chart */}
      {tab === 'history' && (
        <div className="glass-card p-3">
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 size={14} className="text-oracle-accent" />
            <span className="text-xs font-semibold text-oracle-text">Portfolio Equity</span>
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={v => [formatMoney(v), 'Equity']}
                />
                <Line type="monotone" dataKey="equity" stroke="#22d3ee" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="py-8 text-center">
              <BarChart3 size={24} className="text-oracle-muted/30 mx-auto mb-1" />
              <p className="text-oracle-muted text-xs">No history data yet — make some trades first</p>
            </div>
          )}
        </div>
      )}

      {/* Disclaimer */}
      <div className="mt-4 glass-card p-2.5 border-l-4 border-l-oracle-yellow/50">
        <div className="flex items-start gap-2">
          <AlertTriangle size={12} className="text-oracle-yellow shrink-0 mt-0.5" />
          <p className="text-oracle-muted text-[9px] leading-relaxed">
            Paper trading with virtual money via Alpaca. No real money at risk. Market data may be delayed 15 minutes for free accounts.
          </p>
        </div>
      </div>
    </div>
  )
}
