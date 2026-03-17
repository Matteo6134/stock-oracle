import { useState, useEffect } from 'react'
import { Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, CalendarDays, TrendingUp, History as HistoryIcon, DollarSign, PieChart } from 'lucide-react'
import Dashboard from '../pages/Dashboard'
import TomorrowPage from '../pages/TomorrowPage'
import TrendingPage from '../pages/TrendingPage'
import BacktesterPage from '../pages/BacktesterPage'
import PaperTradingPage from '../pages/PaperTradingPage'
import SectorsPage from '../pages/SectorsPage'

const panels = [
  { id: 'home', label: 'Home', icon: LayoutDashboard, Component: Dashboard },
  { id: 'tomorrow', label: 'Tomorrow', icon: CalendarDays, Component: TomorrowPage },
  { id: 'trending', label: 'Trending', icon: TrendingUp, Component: TrendingPage },
  { id: 'paper', label: 'Paper', icon: DollarSign, Component: PaperTradingPage },
  { id: 'history', label: 'History', icon: HistoryIcon, Component: BacktesterPage },
  { id: 'sectors', label: 'Sectors', icon: PieChart, Component: SectorsPage },
]

export default function LandscapeSplit() {
  const [isLandscape, setIsLandscape] = useState(false)
  const [leftPanel, setLeftPanel] = useState('home')
  const [rightPanel, setRightPanel] = useState('history')

  useEffect(() => {
    const check = () => {
      const landscape = window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches
      setIsLandscape(landscape)
    }
    check()
    window.addEventListener('resize', check)
    window.addEventListener('orientationchange', check)
    return () => {
      window.removeEventListener('resize', check)
      window.removeEventListener('orientationchange', check)
    }
  }, [])

  if (!isLandscape) return null

  const LeftComponent = panels.find(p => p.id === leftPanel)?.Component || Dashboard
  const RightComponent = panels.find(p => p.id === rightPanel)?.Component || BacktesterPage

  return (
    <div className="fixed inset-0 z-[100] bg-oracle-bg">
      {/* Panel selectors */}
      <div className="flex h-8 border-b border-oracle-border/30">
        {/* Left panel tabs */}
        <div className="flex-1 flex overflow-x-auto scrollbar-hide">
          {panels.map(p => {
            const Icon = p.icon
            const isActive = leftPanel === p.id
            return (
              <button
                key={`l-${p.id}`}
                onClick={() => setLeftPanel(p.id)}
                className={`flex items-center gap-1 px-2 py-1 text-[9px] font-bold shrink-0 transition-all ${
                  isActive
                    ? 'text-oracle-accent bg-oracle-accent/10 border-b-2 border-oracle-accent'
                    : 'text-oracle-muted hover:text-oracle-text'
                }`}
              >
                <Icon size={10} />
                {p.label}
              </button>
            )
          })}
        </div>
        {/* Divider */}
        <div className="w-px bg-oracle-border/30" />
        {/* Right panel tabs */}
        <div className="flex-1 flex overflow-x-auto scrollbar-hide">
          {panels.map(p => {
            const Icon = p.icon
            const isActive = rightPanel === p.id
            return (
              <button
                key={`r-${p.id}`}
                onClick={() => setRightPanel(p.id)}
                className={`flex items-center gap-1 px-2 py-1 text-[9px] font-bold shrink-0 transition-all ${
                  isActive
                    ? 'text-oracle-accent bg-oracle-accent/10 border-b-2 border-oracle-accent'
                    : 'text-oracle-muted hover:text-oracle-text'
                }`}
              >
                <Icon size={10} />
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Split panels */}
      <div className="flex" style={{ height: 'calc(100vh - 32px)' }}>
        <div className="flex-1 overflow-y-auto border-r border-oracle-border/20">
          <LeftComponent />
        </div>
        <div className="flex-1 overflow-y-auto">
          <RightComponent />
        </div>
      </div>
    </div>
  )
}
