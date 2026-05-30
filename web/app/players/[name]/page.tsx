'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'

interface EloRow {
  game_date:  string
  gameid:     string
  league:     string
  pos:        string
  team:       string
  opp_team:   string
  elo_before: number
  elo_after:  number
  won:        number
}

const POS_LABEL: Record<string, string> = {
  top: 'Top', jng: 'Jungle', mid: 'Mid', bot: 'Bot', sup: 'Support',
}

export default function PlayerEloPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: nameParam } = use(params)
  const player = decodeURIComponent(nameParam)
  const [rows, setRows]   = useState<EloRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    const { data, error } = await supabase.rpc('get_player_elo_history', { p_player: player })
    if (error) setErr(error.message)
    setRows((data ?? []) as EloRow[])
    setLoading(false)
  }, [player])

  useEffect(() => { load() }, [load])

  const summary = useMemo(() => {
    if (!rows.length) return null
    const last     = rows[rows.length - 1]
    const wins     = rows.filter(r => r.won === 1).length
    const peak     = rows.reduce((m, r) => Math.max(m, r.elo_after), -Infinity)
    const trough   = rows.reduce((m, r) => Math.min(m, r.elo_after), Infinity)
    return {
      games:   rows.length,
      wins,
      losses:  rows.length - wins,
      wr:      wins / rows.length,
      cur_elo: last.elo_after,
      team:    last.team,
      league:  last.league,
      pos:     last.pos,
      peak,
      trough,
    }
  }, [rows])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/rankings" className="text-gray-400 hover:text-white text-sm transition-colors">
          ← Rankings
        </Link>
        <h1 className="text-2xl font-bold text-blue-400">{player}</h1>
        {summary && (
          <span className="text-sm text-gray-400">
            {summary.team} · {summary.league} · {POS_LABEL[summary.pos] ?? summary.pos}
          </span>
        )}
        <span className="text-sm text-gray-500 ml-auto">
          {loading ? 'Loading…' : `${rows.length} games`}
        </span>
      </header>

      <main className="px-6 py-6 max-w-6xl mx-auto space-y-6">
        {err && <div className="text-red-400 text-sm">Error: {err}</div>}

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Current ELO" value={Math.round(summary.cur_elo).toString()} color="text-blue-400" />
            <Stat label="Peak ELO"    value={Math.round(summary.peak).toString()}    color="text-yellow-400" />
            <Stat label="Trough ELO"  value={Math.round(summary.trough).toString()}  color="text-red-400" />
            <Stat label="Win rate"    value={`${(summary.wr * 100).toFixed(1)}%`}     color="text-green-400" />
            <Stat label="W / L"       value={`${summary.wins} / ${summary.losses}`}   color="text-gray-200" />
          </div>
        )}

        {/* ELO trajectory chart */}
        <section className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm uppercase tracking-wide text-gray-400 mb-3">
            ELO over time
          </h2>
          {loading ? (
            <div className="h-72 bg-gray-800/50 animate-pulse rounded" />
          ) : rows.length === 0 ? (
            <p className="text-gray-500 text-sm">No history found for &quot;{player}&quot;.</p>
          ) : (
            <EloChart rows={rows} />
          )}
        </section>

        {/* Recent games table */}
        {rows.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <h2 className="text-sm uppercase tracking-wide text-gray-400 px-4 py-3 border-b border-gray-800">
              Game-by-game (most recent first)
            </h2>
            <div className="max-h-[480px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 text-gray-500 uppercase">
                  <tr>
                    <th className="text-left py-2 px-3">Date</th>
                    <th className="text-left py-2 px-3">League</th>
                    <th className="text-left py-2 px-3">Opponent</th>
                    <th className="text-right py-2 px-3">ELO before</th>
                    <th className="text-right py-2 px-3">ELO after</th>
                    <th className="text-right py-2 px-3">Δ</th>
                    <th className="text-center py-2 px-3">W/L</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map(r => {
                    const delta = r.elo_after - r.elo_before
                    return (
                      <tr key={r.gameid} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                        <td className="py-1.5 px-3 text-gray-400">
                          {new Date(r.game_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                        </td>
                        <td className="py-1.5 px-3 text-gray-400">{r.league}</td>
                        <td className="py-1.5 px-3 text-gray-200">{r.opp_team}</td>
                        <td className="py-1.5 px-3 text-right text-gray-400 font-mono">{Math.round(r.elo_before)}</td>
                        <td className="py-1.5 px-3 text-right text-gray-100 font-mono">{Math.round(r.elo_after)}</td>
                        <td className={`py-1.5 px-3 text-right font-mono ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                        </td>
                        <td className={`py-1.5 px-3 text-center font-bold ${r.won ? 'text-green-400' : 'text-red-400'}`}>
                          {r.won ? 'W' : 'L'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}


function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded px-3 py-2">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
    </div>
  )
}


function EloChart({ rows }: { rows: EloRow[] }) {
  // Use rows[*].elo_after over the rows[*].game_date timeline.
  // Map dates to x positions (uniform per-game spacing keeps streaks visible
  // without compression around dense weeks).
  const W = 900, H = 320, PAD_L = 50, PAD_R = 12, PAD_T = 12, PAD_B = 28
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const xs = rows.map((_, i) => PAD_L + (innerW * i) / Math.max(rows.length - 1, 1))
  const elos = rows.map(r => r.elo_after)
  const ymin = Math.min(...elos) - 10
  const ymax = Math.max(...elos) + 10
  const yScale = (e: number) => PAD_T + innerH * (1 - (e - ymin) / Math.max(ymax - ymin, 1))
  const ys = elos.map(yScale)

  // Build the path
  const path = rows.map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')

  // Y-axis gridlines: round to nearest 50
  const gridStep = ymax - ymin > 300 ? 100 : 50
  const gridMin = Math.ceil(ymin / gridStep) * gridStep
  const gridLines: number[] = []
  for (let g = gridMin; g <= ymax; g += gridStep) gridLines.push(g)

  // X-axis labels: show ~6 evenly spaced dates
  const labelCount = Math.min(6, rows.length)
  const labelIdxs = Array.from({ length: labelCount }, (_, k) =>
    Math.round((k * (rows.length - 1)) / Math.max(labelCount - 1, 1))
  )

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: 280 }}>
      {/* Gridlines + Y labels */}
      {gridLines.map(g => (
        <g key={g}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yScale(g)} y2={yScale(g)}
                stroke="#1f2937" strokeWidth={1} strokeDasharray="2 3" />
          <text x={PAD_L - 6} y={yScale(g) + 4} fill="#6b7280" fontSize={10} textAnchor="end">
            {g}
          </text>
        </g>
      ))}
      {/* X axis labels */}
      {labelIdxs.map(i => (
        <text key={i} x={xs[i]} y={H - 8} fill="#6b7280" fontSize={10} textAnchor="middle">
          {new Date(rows[i].game_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </text>
      ))}
      {/* The line */}
      <path d={path} fill="none" stroke="#60a5fa" strokeWidth={1.5} />
      {/* Per-game dots, color-coded by W/L */}
      {rows.map((r, i) => (
        <circle
          key={r.gameid}
          cx={xs[i]} cy={ys[i]} r={2.5}
          fill={r.won ? '#4ade80' : '#f87171'}
        >
          <title>
            {new Date(r.game_date).toLocaleDateString()} · {r.league} · vs {r.opp_team} · {r.won ? 'W' : 'L'} · ELO {Math.round(r.elo_after)}
          </title>
        </circle>
      ))}
    </svg>
  )
}
