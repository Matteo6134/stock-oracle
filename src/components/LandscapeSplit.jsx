import { useState, useEffect, lazy, Suspense, memo, useCallback } from 'react'
import { LayoutDashboard, CalendarDays, TrendingUp, History as HistoryIcon, DollarSign, PieChart } from 'lucide-react'

// Lazy-load all page components — only fetched when selected
const Dashboard = lazy(() => import('../pages/Dashboard'))
const TomorrowPage = lazy(() => import('../pages/TomorrowPage'))
const TrendingPage = lazy(() => import('../pages/TrendingPage'))
const BacktesterPage = lazy(() => import('../pages/BacktesterPage'))
const PaperTradingPage = lazy(() => import('../pages/PaperTradingPage'))
const SectorsPage = lazy(() => import('../pages/SectorsPage'))

const panels = [
  { id: 'home', label: 'Home', icon: LayoutDashboard, Component: Dashboard },
  { id: 'tomorrow', label: 'Tomorrow', icon: CalendarDays, Component: TomorrowPage },
  { id: 'trending', label: 'Trending', icon: TrendingUp, Component: TrendingPage },
  { id: 'paper', label: 'Paper', icon: DollarSign, Component: PaperTradingPage },
  { id: 'history', label: 'History', icon: HistoryIcon, Component: BacktesterPage },
  { id: 'sectors', label: 'Sectors', icon: PieChart, Component: SectorsPage },
]

// Simple loading placeholder
function PanelLoader() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-5 h-5 border-2 border-oracle-accent/30 border-t-oracle-accent rounded-full animate-spin" />
    </div>
  )
}

// Memoized panel to prevent re-renders when the other side changes
const Panel = memo(function Panel({ panelId }) {
  const panel = panels.find(p => p.id === panelId)
  if (!panel) return null
  const Comp = panel.Component
  return (
    <Suspense fallback={<PanelLoader />}>
      <Comp />
    </Suspense>
  )
})

// Tab button — memoized
const TabButton = memo(function TabButton({ panel, isActive, onClick }) {
  const Icon = panel.icon
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-bold shrink-0 transition-colors duration-150 ${
        isActive
          ? 'text-oracle-accent bg-oracle-accent/10 border-b-2 border-oracle-accent'
          : 'text-oracle-muted hover:text-oracle-text'
      }`}
    >
      <Icon size={11} />
      {panel.label}
    </button>
  )
})

export default function LandscapeSplit() {
  const [isLandscape, setIsLandscape] = useState(false)
  const [leftPanel, setLeftPanel] = useState('home')
  const [rightPanel, setRightPanel] = useState('history')

  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (max-height: 500px)')

    const handler = (e) => setIsLandscape(e.matches)
    setIsLandscape(mq.matches)

    // Use addEventListener for modern browsers
    if (mq.addEventListener) {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      // Safari <14 fallback
      mq.addListener(handler)
      return () => mq.removeListener(handler)
    }
  }, [])

  const handleLeftChange = useCallback((id) => setLeftPanel(id), [])
  const handleRightChange = useCallback((id) => setRightPanel(id), [])

  if (!isLandscape) return null

  return (
    <div className="fixed inset-0 z-[100] bg-oracle-bg flex flex-col">
      {/* Tab bars */}
      <div className="flex h-9 border-b border-oracle-border/30 shrink-0">
        {/* Left panel tabs */}
        <div className="flex-1 flex overflow-x-auto scrollbar-hide">
          {panels.map(p => (
            <TabButton
              key={`l-${p.id}`}
              panel={p}
              isActive={leftPanel === p.id}
              onClick={() => handleLeftChange(p.id)}
            />
          ))}
        </div>
        {/* Divider */}
        <div className="w-px bg-oracle-border/30 shrink-0" />
        {/* Right panel tabs */}
        <div className="flex-1 flex overflow-x-auto scrollbar-hide">
          {panels.map(p => (
            <TabButton
              key={`r-${p.id}`}
              panel={p}
              isActive={rightPanel === p.id}
              onClick={() => handleRightChange(p.id)}
            />
          ))}
        </div>
      </div>

      {/* Split panels — CSS contain for paint isolation */}
      <div className="flex flex-1 min-h-0">
        <div
          className="flex-1 overflow-y-auto border-r border-oracle-border/20"
          style={{ contain: 'strict' }}
        >
          <Panel panelId={leftPanel} />
        </div>
        <div
          className="flex-1 overflow-y-auto"
          style={{ contain: 'strict' }}
        >
          <Panel panelId={rightPanel} />
        </div>
      </div>
    </div>
  )
}
