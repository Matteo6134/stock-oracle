import { useEffect, useState } from 'react'

function getScoreColor(score) {
  if (score >= 70) return { stroke: '#10b981', text: 'text-oracle-green' }
  if (score >= 50) return { stroke: '#f59e0b', text: 'text-oracle-yellow' }
  return { stroke: '#ef4444', text: 'text-oracle-red' }
}

export default function ScoreCircle({ score = 0, size = 120 }) {
  const [animatedOffset, setAnimatedOffset] = useState(283)
  const radius = 45
  const circumference = 2 * Math.PI * radius
  const normalizedScore = Math.min(100, Math.max(0, score))
  const targetOffset = circumference - (normalizedScore / 100) * circumference
  const { stroke, text } = getScoreColor(normalizedScore)

  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimatedOffset(targetOffset)
    }, 100)
    return () => clearTimeout(timer)
  }, [targetOffset])

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 100 100"
        className="transform -rotate-90"
        style={{ width: size, height: size }}
      >
        {/* Background circle */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="#1e293b"
          strokeWidth="8"
        />
        {/* Score arc */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={animatedOffset}
          style={{ transition: 'stroke-dashoffset 1s ease-out' }}
        />
      </svg>
      {/* Score number in center */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-bold ${text}`} style={{ fontSize: size * 0.25 }}>
          {normalizedScore}
        </span>
        <span className="text-oracle-muted text-xs">/ 100</span>
      </div>
    </div>
  )
}
