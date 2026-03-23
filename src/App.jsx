import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, NavLink, useLocation, matchPath } from 'react-router-dom'
import { LayoutDashboard, TrendingUp, PieChart, CalendarDays, History as HistoryIcon, DollarSign, Zap, Crosshair, Menu, X, Bookmark, Diamond, Users, Rocket, FlaskConical, Target, Globe, ArrowLeftRight } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './components/Toast'
import LandscapeSplit from './components/LandscapeSplit'
import Dashboard from './pages/Dashboard'
import StockDetail from './pages/StockDetail'
import SectorsPage from './pages/SectorsPage'
import SectorDetail from './pages/SectorDetail'
import TrendingPage from './pages/TrendingPage'
import TomorrowPage from './pages/TomorrowPage'
import BacktesterPage from './pages/BacktesterPage'
import AlpacaTradingPage from './pages/AlpacaTradingPage'
import MoversPage from './pages/MoversPage'
import BuyTomorrowPage from './pages/BuyTomorrowPage'
import WishlistPage from './pages/WishlistPage'
import GemBacktestPage from './pages/GemBacktestPage'
import PennyStocksPage from './pages/PennyStocksPage'
import HistoricalBacktestPage from './pages/HistoricalBacktestPage'
import OracleLanding from './pages/OracleLanding'
import PolyDashboard from './pages/PolyDashboard'
import PolyMarkets from './pages/PolyMarkets'
import packageJson from '../package.json'
import { isNotificationSupported, isNotificationEnabled, requestNotificationPermission, disableNotifications } from './lib/notifications'
import { checkSmartAlerts } from './lib/tradeAlerts'
import { checkWishlistAlerts } from './lib/wishlistAlerts'
import { syncWatchlistToServer } from './lib/wishlist'
import { useSSE } from './hooks/useSSE'

const stockNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/gems', icon: Diamond, label: 'Gem Finder' },
  { to: '/buy-tomorrow', icon: Crosshair, label: 'Buy Tomorrow' },
  { to: '/wishlist', icon: Bookmark, label: 'My Watchlist' },
  { to: '/penny-stocks', icon: Rocket, label: 'Penny Stocks' },
  { to: '/movers', icon: Zap, label: 'Movers' },
  { to: '/trending', icon: TrendingUp, label: 'Trending' },
  { to: '/trading-desk', icon: Users, label: 'Trading Desk' },
  { to: '/trade', icon: DollarSign, label: 'Trade' },
  { to: '/history', icon: HistoryIcon, label: 'History' },
  { to: '/backtest', icon: FlaskConical, label: 'Backtest' },
  { to: '/sectors', icon: PieChart, label: 'Sectors' },
]

const polyNavItems = [
  { to: '/poly', icon: Target, label: 'Dashboard' },
  { to: '/poly/markets', icon: Globe, label: 'Markets' },
]

// Routes where the sidebar toggle should be hidden
const detailPatterns = ['/stock/:symbol', '/sectors/:sectorName']

export default function App() {
  const location = useLocation()
  const isDetailPage = detailPatterns.some(p => matchPath(p, location.pathname))
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notifEnabled, setNotifEnabled] = useState(isNotificationEnabled())
  const { connected: sseConnected, gemsAlert, moversAlert } = useSSE()
  const [mode, setMode] = useState(() => localStorage.getItem('oracle_mode') || null) // 'stock' | 'poly' | null

  const selectMode = (m) => {
    localStorage.setItem('oracle_mode', m)
    setMode(m)
  }

  const navItems = mode === 'poly' ? polyNavItems : stockNavItems
  const isPolyMode = mode === 'poly'

  // Close sidebar on route change
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  // Sync watchlist to server on load (so Telegram can read it)
  useEffect(() => { syncWatchlistToServer() }, [])

  // Register SW on mount
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  // ── Smart Trade Alert Monitor ──
  // Checks predictions every 5 minutes during market hours and sends buy/sell alerts
  useEffect(() => {
    if (!notifEnabled) return

    const runAlertCheck = async () => {
      try {
        // Only check during weekdays
        const day = new Date().getDay()
        if (day === 0 || day === 6) return

        // Check NY time — only run between 4 AM and 8 PM ET
        const nyHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
        if (nyHour < 4 || nyHour >= 20) return

        // Fetch fresh predictions
        const res = await fetch('/api/predictions')
        if (!res.ok) return
        const data = await res.json()
        const predictions = data.predictions || []

        // Load open paper trades
        let openTrades = []
        try {
          openTrades = JSON.parse(localStorage.getItem('paper_trades') || '[]')
        } catch {}

        // Run smart alert checks
        checkSmartAlerts(predictions, openTrades)
      } catch {
        // Silent — don't break the app
      }
    }

    // Run immediately, then every 5 minutes
    runAlertCheck()
    const interval = setInterval(runAlertCheck, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [notifEnabled])

  // ── Wishlist Alert Monitor ──
  // Checks wishlist stocks every 10 minutes for buy setups / squeezes
  useEffect(() => {
    if (!notifEnabled) return

    const runWishlistCheck = async () => {
      try {
        const day = new Date().getDay()
        if (day === 0 || day === 6) return // weekdays only
        await checkWishlistAlerts()
      } catch {
        // Silent
      }
    }

    let intervalId = null
    // Delay first check by 30s to avoid hammering on load
    const delay = setTimeout(() => {
      runWishlistCheck()
      intervalId = setInterval(runWishlistCheck, 10 * 60 * 1000)
    }, 30000)

    return () => {
      clearTimeout(delay)
      if (intervalId) clearInterval(intervalId)
    }
  }, [notifEnabled])

  const toggleNotifications = useCallback(async () => {
    if (notifEnabled) {
      disableNotifications()
      setNotifEnabled(false)
    } else {
      const ok = await requestNotificationPermission()
      setNotifEnabled(ok)
    }
  }, [notifEnabled])

  // Show landing page if no mode selected
  if (!mode) {
    return <OracleLanding onSelect={selectMode} />
  }

  return (
    <ToastProvider>
    <div className="min-h-screen bg-oracle-bg">
      {/* Landscape split view — appears when phone is rotated */}
      <LandscapeSplit />

      {/* Sticky top bar with hamburger — flows with content, no gap */}
      {!isDetailPage && (
        <div className="sticky top-0 z-40 px-4 py-2">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 glass-card text-oracle-muted hover:text-oracle-accent transition-all active:scale-95"
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
        </div>
      )}

      {/* Sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Slide-out sidebar */}
      <nav
        className={`fixed top-0 left-0 bottom-0 w-64 glass-nav z-[70] flex flex-col transition-transform duration-300 ease-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ borderRadius: '0 1.25rem 1.25rem 0' }}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between p-5 pb-3">
          <span className="text-oracle-text font-bold text-base">{isPolyMode ? 'Poly Oracle' : 'Stock Oracle'}</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-xl text-oracle-muted hover:text-oracle-text hover:bg-white/10 transition-all"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Separator */}
        <div className="mx-5 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent mb-2" />

        {/* Nav items */}
        <div className="flex-1 px-3 py-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'text-oracle-accent bg-white/10'
                    : 'text-oracle-muted hover:text-oracle-text hover:bg-white/[0.04]'
                }`
              }
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>

        {/* Mode switch */}
        <div className="mx-3 mb-2">
          <button
            onClick={() => { selectMode(isPolyMode ? 'stock' : 'poly'); setSidebarOpen(false) }}
            className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border border-purple-500/20 transition-all"
          >
            <ArrowLeftRight size={14} />
            Switch to {isPolyMode ? 'Stock Oracle' : 'Poly Oracle'}
          </button>
        </div>

        {/* Sidebar footer */}
        <div className="px-5 py-4 space-y-2">
          {isNotificationSupported() && (
            <button
              onClick={toggleNotifications}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                notifEnabled
                  ? 'bg-oracle-green/15 text-oracle-green border border-oracle-green/30'
                  : 'glass-inner text-oracle-muted hover:text-oracle-text'
              }`}
            >
              <span>{notifEnabled ? '🔔 Alerts On' : '🔕 Enable Alerts'}</span>
              <span className={`w-8 h-4 rounded-full relative transition-all ${notifEnabled ? 'bg-oracle-green' : 'bg-oracle-border'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${notifEnabled ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
            </button>
          )}
          <div className="text-oracle-muted text-[10px] uppercase font-bold">AI-Powered Predictions</div>
          <div className="flex items-center gap-2">
            <div className="text-oracle-muted/50 text-[9px]">v{packageJson.version}</div>
            <div className={`flex items-center gap-1 text-[9px] ${sseConnected ? 'text-oracle-green' : 'text-oracle-muted/40'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-oracle-green animate-pulse' : 'bg-oracle-muted/30'}`} />
              {sseConnected ? 'LIVE' : 'OFFLINE'}
            </div>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/gems" element={<TomorrowPage />} />
            <Route path="/buy-tomorrow" element={<BuyTomorrowPage />} />
            <Route path="/wishlist" element={<WishlistPage />} />
            <Route path="/penny-stocks" element={<PennyStocksPage />} />
            <Route path="/movers" element={<MoversPage />} />
            <Route path="/stock/:symbol" element={<StockDetail />} />
            <Route path="/sectors" element={<SectorsPage />} />
            <Route path="/sectors/:sectorName" element={<SectorDetail />} />
            <Route path="/trending" element={<TrendingPage />} />
            <Route path="/trade" element={<AlpacaTradingPage />} />
            <Route path="/trading-desk" element={<GemBacktestPage />} />
            <Route path="/history" element={<BacktesterPage />} />
            <Route path="/backtest" element={<HistoricalBacktestPage />} />
            <Route path="/poly" element={<PolyDashboard />} />
            <Route path="/poly/markets" element={<PolyMarkets />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
    </ToastProvider>
  )
}
