'use client'

import type { ChampionStat } from '../page'

const POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup'] as const
const POSITION_LABELS: Record<string, string> = {
  top: 'Top', jng: 'Jungle', mid: 'Mid', bot: 'Bot', sup: 'Support',
}

export default function ChampionTable({
  champions, totalGames, position, onPositionChange, loading,
}: {
  champions: ChampionStat[]
  totalGames: number
  position: string
  onPositionChange: (p: string) => void
  loading: boolean
}) {
  const sorted = [...champions].sort((a, b) => b.picks - a.picks)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Champion Stats</h2>
        <div className="flex gap-1">
          {POSITIONS.map((p) => (
            <button
              key={p}
              onClick={() => onPositionChange(p)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                position === p
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {POSITION_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-8 bg-gray-800 rounded animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 uppercase border-b border-gray-800">
                <th className="text-left py-2 pr-4">#</th>
                <th className="text-left py-2 pr-4">Champion</th>
                <th className="text-right py-2 pr-4">Picks</th>
                <th className="text-right py-2 pr-4">Pick Rate</th>
                <th className="text-right py-2">Win Rate</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c, i) => {
                const winRate = c.picks > 0 ? (c.wins / c.picks) * 100 : 0
                const pickRate = totalGames > 0 ? (c.picks / (totalGames * 2)) * 100 : 0
                return (
                  <tr key={c.champion} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="py-2 pr-4 text-gray-500">{i + 1}</td>
                    <td className="py-2 pr-4 font-medium text-white">{c.champion}</td>
                    <td className="py-2 pr-4 text-right text-gray-300">{c.picks.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right text-gray-300">{pickRate.toFixed(1)}%</td>
                    <td className="py-2 text-right">
                      <span className={`font-medium ${winRate >= 55 ? 'text-green-400' : winRate <= 45 ? 'text-red-400' : 'text-gray-300'}`}>
                        {winRate.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                )
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-gray-500">No data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
