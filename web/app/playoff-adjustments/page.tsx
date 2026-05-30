'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

interface TeamMeta {
  league?: string
}

interface ModelParams {
  team_po_adj: Record<string, number>
  teams:       Record<string, TeamMeta>
}

interface Row {
  team:     string
  league:   string
  po_adj:   number
}

type SortKey = 'po_adj' | 'team' | 'league'

export default function PlayoffAdjustmentsPage() {
  const [data, setData]       = useState<ModelParams | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('po_adj')
  const [sortAsc, setSortAsc] = useState(false)
  const [leagueFilter, setLeagueFilter] = useState('All')

  useEffect(() => {
    fetch('/model_params.json')
      .then(r => r.json() as Promise<ModelParams>)
      .then(setData)
      .catch(e => setErr(`${e}`))
      .finally(() => setLoading(false))
  }, [])

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    const out: Row[] = []
    for (const [team, po_adj] of Object.entries(data.team_po_adj)) {
      if (!po_adj) continue
      const meta = data.teams?.[team]
      out.push({ team, po_adj, league: meta?.league ?? '?' })
    }
    return out
  }, [data])

  const leagues = useMemo(() => {
    const s = new Set<string>()
    rows.forEach(r => s.add(r.league))
    return ['All', ...Array.from(s).sort()]
  }, [rows])

  const sorted = useMemo(() => {
    const filtered = leagueFilter === 'All' ? rows : rows.filter(r => r.league === leagueFilter)
    const cmp = (a: Row, b: Row): number => {
      const dir = sortAsc ? 1 : -1
      if (sortKey === 'po_adj') return dir * (a.po_adj - b.po_adj)
      if (sortKey === 'team')   return dir * a.team.localeCompare(b.team)
      return dir * a.league.localeCompare(b.league)
    }
    return [...filtered].sort(cmp)
  }, [rows, sortKey, sortAsc, leagueFilter])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key !== 'po_adj') }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">← Back</Link>
        <h1 className="text-2xl font-bold text-orange-400">Playoff Adjustments</h1>
        <span className="text-sm text-gray-500 ml-auto">
          {loading ? 'Loading…' : `${sorted.length} teams`}
        </span>
      </header>

      <main className="px-6 py-6 max-w-5xl mx-auto space-y-6">
        {err && <div className="text-red-400 text-sm">Error: {err}</div>}

        <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 space-y-2">
          <p>
            <span className="text-orange-300 font-semibold">How it&apos;s applied:</span>{' '}
            For playoff games only, the model&apos;s logit gets shifted by{' '}
            <code className="bg-gray-800 px-1.5 py-0.5 rounded text-blue-300">
              po_adj[blue_team] − po_adj[red_team]
            </code>.
            Per-team values are fit on leave-one-year-out playoff residuals, then
            shrunk by a global factor (0.76) optimized for 2025+2026 log loss.
            Only teams with ≥10 playoff games included; everyone else defaults to 0.
          </p>
          <p>
            <span className="text-green-400 font-semibold">Positive</span> = team has
            historically <i>outperformed</i> its regular-season form in playoffs.{' '}
            <span className="text-red-400 font-semibold">Negative</span> = the
            opposite. A G2 (+0.42) vs Nongshim RF (−0.67) playoff matchup gets a
            +1.09 logit boost for G2.
          </p>
        </section>

        {/* League filter */}
        <div className="flex gap-2">
          {leagues.map(l => (
            <button
              key={l}
              onClick={() => setLeagueFilter(l)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
                leagueFilter === l
                  ? 'bg-orange-700 text-white'
                  : 'bg-gray-900 border border-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        <section className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {loading ? (
            <div className="space-y-px">
              {[...Array(15)].map((_, i) => (
                <div key={i} className="h-10 bg-gray-800/50 animate-pulse" style={{ opacity: 1 - i * 0.04 }} />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-800 bg-gray-900/80 text-xs text-gray-400 uppercase">
                <tr>
                  <th className="text-right py-3 px-3 w-12">#</th>
                  <ColHeader label="Team"           onClick={() => toggleSort('team')}   active={sortKey === 'team'}   asc={sortAsc} />
                  <ColHeader label="League"         onClick={() => toggleSort('league')} active={sortKey === 'league'} asc={sortAsc} />
                  <ColHeader label="Playoff Adj"    onClick={() => toggleSort('po_adj')} active={sortKey === 'po_adj'} asc={sortAsc} align="right" />
                  <th className="text-left py-3 px-3">Interpretation</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.team} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-right text-gray-500">{i + 1}</td>
                    <td className="py-2 px-3 font-semibold text-white">{r.team}</td>
                    <td className="py-2 px-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${leagueBadge(r.league)}`}>
                        {r.league}
                      </span>
                    </td>
                    <td className={`py-2 px-3 text-right font-mono font-bold ${r.po_adj > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {r.po_adj > 0 ? '+' : ''}{r.po_adj.toFixed(4)}
                    </td>
                    <td className="py-2 px-3 text-xs text-gray-400">
                      {labelFor(r.po_adj)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  )
}


function ColHeader({
  label, onClick, active, asc, align = 'left',
}: {
  label: string; onClick: () => void; active: boolean; asc: boolean; align?: 'left' | 'right'
}) {
  return (
    <th
      className={`py-3 px-3 cursor-pointer select-none hover:text-white transition-colors ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${active ? 'text-white' : ''}`}
      onClick={onClick}
    >
      {label}
      {active && <span className="ml-1 text-gray-500">{asc ? '↑' : '↓'}</span>}
    </th>
  )
}

function leagueBadge(league: string) {
  switch (league) {
    case 'LCK': return 'bg-red-900/50 text-red-300'
    case 'LPL': return 'bg-orange-900/50 text-orange-300'
    case 'LEC': return 'bg-blue-900/50 text-blue-300'
    case 'LCS': return 'bg-purple-900/50 text-purple-300'
    default:    return 'bg-gray-800 text-gray-400'
  }
}

function labelFor(v: number): string {
  if (v >=  0.30) return 'Strong playoff overperformer'
  if (v >=  0.10) return 'Mild playoff overperformer'
  if (v >  -0.10) return 'Near neutral'
  if (v > -0.30)  return 'Mild playoff underperformer'
  return 'Strong playoff underperformer'
}
