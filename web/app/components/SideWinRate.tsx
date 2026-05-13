'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts'
import type { SummaryStats } from '../page'

export default function SideWinRate({ stats, loading }: { stats: SummaryStats | null; loading: boolean }) {
  if (loading || !stats) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse">
        <div className="h-3 bg-gray-700 rounded w-32 mb-6" />
        <div className="h-48 bg-gray-700 rounded" />
      </div>
    )
  }

  const total = stats.total_games
  const blueWins = stats.blue_wins
  const redWins = total - blueWins

  const data = [
    { side: 'Blue Side', winRate: total > 0 ? parseFloat(((blueWins / total) * 100).toFixed(1)) : 0, wins: blueWins },
    { side: 'Red Side',  winRate: total > 0 ? parseFloat(((redWins  / total) * 100).toFixed(1)) : 0, wins: redWins },
  ]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">
        Side Win Rate
      </h2>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} barSize={60}>
          <XAxis dataKey="side" tick={{ fill: '#9ca3af', fontSize: 13 }} axisLine={false} tickLine={false} />
          <YAxis domain={[40, 60]} tick={{ fill: '#9ca3af', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 8 }}
            formatter={(value, _name, entry) =>
              [`${value}% (${(entry.payload as { wins: number }).wins.toLocaleString()} wins)`, 'Win Rate']
            }
          />
          <ReferenceLine y={50} stroke="#4b5563" strokeDasharray="4 4" />
          <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
            <Cell fill="#3b82f6" />
            <Cell fill="#ef4444" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-gray-500 mt-2 text-center">{total.toLocaleString()} total games</p>
    </div>
  )
}
