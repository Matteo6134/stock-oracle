import { useState, useEffect } from 'react'
import { Routes, Route, NavLink, useLocation, matchPath } from 'react-router-dom'
import { LayoutDashboard, TrendingUp, PieChart, CalendarDays, History as HistoryIcon, Menu, X } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import StockDetail from './pages/StockDetail'
import SectorsPage from './pages/SectorsPage'
import SectorDetail from './pages/SectorDetail'
import TrendingPage from './pages/TrendingPage'
import TomorrowPage from './pages/TomorrowPage'
import BacktesterPage from './pages/BacktesterPage'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/tomorrow', icon: CalendarDays, label: 'Tomorrow' },
  { to: '/trending', icon: TrendingUp, label: 'Trending' },
  { to: '/history', icon: HistoryIcon, label: 'History' },
  { to: '/sectors', icon: PieChart, label: 'Sectors' },
]

// Routes where the sidebar toggle should be hidden
const detailPatterns = ['/stock/:symbol', '/sectors/:sectorName']

export default function App() {
  const location = useLocation()
  const isDetailPage = detailPatterns.some(p => matchPath(p, location.pathname))
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close sidebar on route change
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  return (
    <div className="min-h-screen bg-oracle-bg">
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
          <span className="text-oracle-text font-bold text-base">Stock Oracle</span>
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

        {/* Sidebar footer */}
        <div className="px-5 py-4">
          <div className="text-oracle-muted text-[10px] uppercase font-bold">AI-Powered Predictions</div>
        </div>
      </nav>

      {/* Main content */}
      <main>
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/stock/:symbol" element={<StockDetail />} />
            <Route path="/tomorrow" element={<TomorrowPage />} />
            <Route path="/sectors" element={<SectorsPage />} />
            <Route path="/sectors/:sectorName" element={<SectorDetail />} />
            <Route path="/trending" element={<TrendingPage />} />
            <Route path="/history" element={<BacktesterPage />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  )
}
