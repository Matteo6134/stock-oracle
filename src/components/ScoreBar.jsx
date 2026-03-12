import { useEffect, useState } from 'react'

const colorMap = {
  blue: { bg: 'bg-blue-500/20', fill: 'bg-blue-500' },
  green: { bg: 'bg-emerald-500/20', fill: 'bg-emerald-500' },
  purple: { bg: 'bg-purple-500/20', fill: 'bg-purple-500' },
  orange: { bg: 'bg-orange-500/20', fill: 'bg-orange-500' },
  cyan: { bg: 'bg-cyan-500/20', fill: 'bg-cyan-500' },
  yellow: { bg: 'bg-yellow-500/20', fill: 'bg-yellow-500' },
  red: { bg: 'bg-red-500/20', fill: 'bg-red-500' },
}

export default function ScoreBar({ label, score = 0, maxScore = 25, color = 'blue' }) {
  const [animatedWidth, setAnimatedWidth] = useState(0)
  const normalizedScore = Math.min(maxScore, Math.max(0, score))
  const percentage = (normalizedScore / maxScore) * 100
  const colors = colorMap[color] || colorMap.blue

  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimatedWidth(percentage)
    }, 100)
    return () => clearTimeout(timer)
  }, [percentage])

  return (
    <div className="flex items-center gap-3">
      <span className="text-oracle-muted text-sm w-24 shrink-0">{label}</span>
      <div className={`flex-1 h-2.5 rounded-full ${colors.bg} overflow-hidden`}>
        <div
          className={`h-full rounded-full ${colors.fill}`}
          style={{
            width: `${animatedWidth}%`,
            transition: 'width 0.8s ease-out',
          }}
        />
      </div>
      <span className="text-oracle-text text-sm font-medium w-12 text-right">
        {normalizedScore}/{maxScore}
      </span>
    </div>
  )
}
