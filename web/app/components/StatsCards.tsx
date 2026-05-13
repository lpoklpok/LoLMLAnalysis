'use client'

import type { SummaryStats } from '../page'

function pct(n: number, d: number) {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`
}

export default function StatsCards({ stats, loading }: { stats: SummaryStats | null; loading: boolean }) {
  if (loading || !stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse">
            <div className="h-3 bg-gray-700 rounded w-24 mb-3" />
            <div className="h-8 bg-gray-700 rounded w-20" />
          </div>
        ))}
      </div>
    )
  }

  const avgMin = stats.avg_gamelength > 0
    ? `${(stats.avg_gamelength / 60).toFixed(1)} min`
    : '—'

  const cards = [
    { label: 'Total Games',      value: stats.total_games.toLocaleString() },
    { label: 'Blue Side Win Rate', value: pct(stats.blue_wins, stats.total_games) },
    { label: 'Avg Game Length',  value: avgMin },
    {
      label: 'Favorite Win Rate',
      value: pct(stats.favorite_wins, stats.games_with_odds),
      sub: `${stats.games_with_odds.toLocaleString()} games with odds`,
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide">{c.label}</p>
          <p className="text-3xl font-bold mt-1 text-white">{c.value}</p>
          {c.sub && <p className="text-xs text-gray-500 mt-1">{c.sub}</p>}
        </div>
      ))}
    </div>
  )
}
