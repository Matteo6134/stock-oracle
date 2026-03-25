import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, NavLink, useLocation, matchPath } from 'react-router-dom'
import { Diamond, DollarSign, Bookmark, Menu, X, Target, Globe, ArrowLeftRight, Bot } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './components/Toast'
import LandscapeSplit from './components/LandscapeSplit'
import GemsPage from './pages/GemsPage'
import TradePage from './pages/TradePage'
import WishlistPage from './pages/WishlistPage'
import StockDetail from './pages/StockDetail'
import OracleLanding from './pages/OracleLanding'
import PolyDashboard from './pages/PolyDashboard'
import PolyMarkets from './pages/PolyMarkets'
import packageJson from '../package.json'
import { isNotificationSupported, isNotificationEnabled, requestNotificationPermission, disableNotifications } from './lib/notifications'
import { checkSmartAlerts } from './lib/tradeAlerts'
import { checkWishlistAlerts } from './lib/wishlistAlerts'
import { syncWatchlistToServer } from './lib/wishlist'
import { useSSE } from './hooks/useSSE'

// ── Stock Oracle: 3 tabs ──
const stockNavItems = [
  { to: '/', icon: Diamond, label: 'Gems' },
  { to: '/trade', icon: Bot, label: 'Trade' },
  { to: '/watchlist', icon: Bookmark, label: 'Watchlist' },
]

// ── Poly Oracle ──
const polyNavItems = [
  { to: '/poly', icon: Target, label: 'Dashboard' },
  { to: '/poly/markets', icon: Globe, label: 'Markets' },
]

// Routes where the sidebar toggle should be hidden
const detailPatterns = ['/stock/:symbol']

export default function App() {
  const location = useLocation()
  const isDetailPage = detailPatterns.some(p => matchPath(p, location.pathname))
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [notifEnabled, setNotifEnabled] = useState(isNotificationEnabled())
  const { connected: sseConnected } = useSSE()
  const [mode, setMode] = useState(() => localStorage.getItem('oracle_mode') || null)

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

  // Sync watchlist to server on load
  useEffect(() => { syncWatchlistToServer() }, [])

  // Register SW on mount
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  // ── Smart Trade Alert Monitor ──
  useEffect(() => {
    if (!notifEnabled) return

    const runAlertCheck = async () => {
      try {
        const day = new Date().getDay()
        if (day === 0 || day === 6) return

        const nyHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
        if (nyHour < 4 || nyHour >= 20) return

        const res = await fetch('/api/predictions')
        if (!res.ok) return
        const data = await res.json()
        const predictions = data.predictions || []

        let openTrades = []
        try {
          openTrades = JSON.parse(localStorage.getItem('paper_trades') || '[]')
        } catch {}

        checkSmartAlerts(predictions, openTrades)
      } catch {
        // Silent
      }
    }

    runAlertCheck()
    const interval = setInterval(runAlertCheck, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [notifEnabled])

  // ── Wishlist Alert Monitor ──
  useEffect(() => {
    if (!notifEnabled) return

    const runWishlistCheck = async () => {
      try {
        const day = new Date().getDay()
        if (day === 0 || day === 6) return
        await checkWishlistAlerts()
      } catch {
        // Silent
      }
    }

    let intervalId = null
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
    <div className="min-h-screen bg-gray-950">
      {/* Landscape split view */}
      <LandscapeSplit />

      {/* ── Top Tab Bar (Stock Oracle) ── */}
      {!isDetailPage && !isPolyMode && (
        <div className="sticky top-0 z-40 bg-gray-950/90 backdrop-blur-md border-b border-gray-800/50">
          <div className="max-w-lg mx-auto flex items-center">
            {/* Hamburger */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-3 text-gray-500 hover:text-white transition-all active:scale-95"
              aria-label="Open menu"
            >
              <Menu size={18} />
            </button>

            {/* Tabs */}
            <div className="flex-1 flex">
              {stockNavItems.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    `flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
                      isActive
                        ? 'text-white border-purple-500'
                        : 'text-gray-500 border-transparent hover:text-gray-300'
                    }`
                  }
                >
                  <Icon size={14} />
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Top Bar (Poly Oracle / Detail pages) ── */}
      {!isDetailPage && isPolyMode && (
        <div className="sticky top-0 z-40 bg-gray-950/90 backdrop-blur-md border-b border-gray-800/50 px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 bg-gray-900 border border-gray-800 rounded-xl text-gray-500 hover:text-white transition-all active:scale-95"
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
          <div className="flex gap-1 flex-1">
            {polyNavItems.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                    isActive
                      ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                      : 'text-gray-500 hover:text-gray-300'
                  }`
                }
              >
                <Icon size={14} />
                {label}
              </NavLink>
            ))}
          </div>
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
        className={`fixed top-0 left-0 bottom-0 w-64 bg-gray-900 border-r border-gray-800 z-[70] flex flex-col transition-transform duration-300 ease-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between p-5 pb-3">
          <span className="text-white font-bold text-base">{isPolyMode ? 'Poly Oracle' : 'Stock Oracle'}</span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-xl text-gray-500 hover:text-white hover:bg-white/10 transition-all"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Separator */}
        <div className="mx-5 h-px bg-gradient-to-r from-transparent via-gray-700 to-transparent mb-2" />

        {/* Nav items */}
        <div className="flex-1 px-3 py-2 space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'text-purple-400 bg-purple-500/10'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
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
                  ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                  : 'bg-gray-800 text-gray-500 hover:text-white'
              }`}
            >
              <span>{notifEnabled ? 'Alerts On' : 'Enable Alerts'}</span>
              <span className={`w-8 h-4 rounded-full relative transition-all ${notifEnabled ? 'bg-green-500' : 'bg-gray-700'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${notifEnabled ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="text-gray-600 text-[9px]">v{packageJson.version}</div>
            <div className={`flex items-center gap-1 text-[9px] ${sseConnected ? 'text-green-400' : 'text-gray-600'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? 'bg-green-400 animate-pulse' : 'bg-gray-700'}`} />
              {sseConnected ? 'LIVE' : 'OFFLINE'}
            </div>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main>
        <ErrorBoundary>
          <Routes>
            {/* Stock Oracle — 3 main pages */}
            <Route path="/" element={<GemsPage />} />
            <Route path="/trade" element={<TradePage />} />
            <Route path="/watchlist" element={<WishlistPage />} />
            <Route path="/stock/:symbol" element={<StockDetail />} />

            {/* Poly Oracle */}
            <Route path="/poly" element={<PolyDashboard />} />
            <Route path="/poly/markets" element={<PolyMarkets />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
    </ToastProvider>
  )
}
