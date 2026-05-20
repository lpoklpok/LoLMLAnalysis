'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface ChampionRow {
  champion: string
  games:    number
  actual:   number
  expected: number
  outperf:  number
}

interface FindingsData {
  generated:         string
  year:              number
  min_games:         number
  min_games_major:   number
  by_position:       Record<string, ChampionRow[]>
  by_position_major: Record<string, ChampionRow[]>
}

const POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup'] as const
const POS_LABEL: Record<string, string> = { top: 'Top', jng: 'Jungle', mid: 'Mid', bot: 'Bot', sup: 'Support' }
const TOP_N = 10

function pct(v: number) { return `${(v * 100).toFixed(1)}%` }
function sign(v: number) { return v >= 0 ? `+${(v * 100).toFixed(1)}%` : `${(v * 100).toFixed(1)}%` }

function outperfColor(v: number): string {
  if (v >=  0.15) return 'text-green-300 font-semibold'
  if (v >=  0.08) return 'text-green-400'
  if (v >=  0.04) return 'text-green-500'
  if (v <= -0.15) return 'text-red-300 font-semibold'
  if (v <= -0.08) return 'text-red-400'
  if (v <= -0.04) return 'text-red-500'
  return 'text-gray-400'
}

function ChampionTable({
  rows,
  direction,
}: {
  rows: ChampionRow[]
  direction: 'over' | 'under'
}) {
  const sorted = direction === 'over'
    ? [...rows].sort((a, b) => b.outperf - a.outperf).slice(0, TOP_N)
    : [...rows].sort((a, b) => a.outperf - b.outperf).slice(0, TOP_N)

  const header = direction === 'over' ? 'Overperformers' : 'Underperformers'
  const accent = direction === 'over' ? 'text-green-400' : 'text-red-400'

  return (
    <div className="flex-1 min-w-0">
      <h3 className={`text-sm font-semibold uppercase tracking-wide mb-3 ${accent}`}>{header}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800">
            <th className="text-left pb-2 font-normal">Champion</th>
            <th className="text-right pb-2 font-normal">Games</th>
            <th className="text-right pb-2 font-normal">Actual</th>
            <th className="text-right pb-2 font-normal">Model</th>
            <th className="text-right pb-2 font-normal">Delta</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.champion} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
              <td className="py-1.5 pr-3 text-gray-200">{r.champion}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
              <td className="py-1.5 text-right text-gray-300 tabular-nums">{pct(r.actual)}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{pct(r.expected)}</td>
              <td className={`py-1.5 text-right tabular-nums ${outperfColor(r.outperf)}`}>
                {sign(r.outperf)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function FindingsPage() {
  const [data, setData]       = useState<FindingsData | null>(null)
  const [pos, setPos]         = useState<typeof POSITIONS[number]>('mid')
  const [majorOnly, setMajor] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch('/champion_findings.json')
      .then(r => r.json())
      .then(setData)
      .catch(() => setError('Failed to load findings data'))
  }, [])

  const rows = data
    ? (majorOnly ? data.by_position_major : data.by_position)[pos] ?? []
    : []

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/" className="text-gray-500 hover:text-gray-300 text-sm transition-colors">← Home</Link>
        <h1 className="text-2xl font-bold text-white">General Findings</h1>
        {data && (
          <span className="text-xs text-gray-600 ml-auto">
            2026 · model trained on 2024–2025 · min {majorOnly ? data.min_games_major : data.min_games} games
          </span>
        )}
      </div>

      {error && <p className="text-red-400">{error}</p>}

      {!data && !error && (
        <div className="text-gray-500 text-sm">Loading…</div>
      )}

      {data && (
        <>
          <p className="text-gray-400 text-sm mb-6">
            Champions ranked by how much their team's win rate exceeds or falls short of our model's
            pre-game prediction. Positive delta means teams that drafted this champion won more than
            expected; negative means they won less.
          </p>

          {/* League filter */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setMajor(false)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                !majorOnly
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              All Leagues
            </button>
            <button
              onClick={() => setMajor(true)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                majorOnly
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              Major Leagues (LCK / LEC / LCS / LPL)
            </button>
          </div>

          {/* Position tabs */}
          <div className="flex gap-2 mb-6">
            {POSITIONS.map(p => (
              <button
                key={p}
                onClick={() => setPos(p)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  pos === p
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                }`}
              >
                {POS_LABEL[p]}
              </button>
            ))}
          </div>

          {/* Over / Under tables side by side */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
            <div className="flex gap-8">
              <ChampionTable rows={rows} direction="over" />
              <div className="w-px bg-gray-800 shrink-0" />
              <ChampionTable rows={rows} direction="under" />
            </div>
          </div>

          <p className="text-xs text-gray-600 mt-4">
            Updated {new Date(data.generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </>
      )}
    </div>
  )
}
