'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'

interface Row {
  team:      string
  league:    string
  month:     number
  games:     number
  actual_wr: number
  model_wr:  number
  bias:      number
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const LEAGUES = ['All','LCK','LPL','LEC','LCS']
const YEAR = 2026

type SortKey = 'bias' | 'games' | 'team' | 'actual_wr' | 'model_wr'

export default function CalibrationPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [league, setLeague] = useState('All')
  const [month, setMonth] = useState<number | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('bias')
  const [sortAsc, setSortAsc] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const { data, error } = await supabase.rpc('get_team_monthly_bias', { p_year: YEAR })
      if (cancelled) return
      if (error) setErr(error.message)
      setRows((data ?? []) as Row[])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  // Available months in the data
  const months = useMemo(() => {
    const s = new Set<number>(); rows.forEach(r => s.add(r.month))
    return Array.from(s).sort((a,b) => a-b)
  }, [rows])

  // Per-team aggregate across all selected months (for "all" view)
  const aggregated = useMemo<Row[]>(() => {
    if (month !== 'all') return rows.filter(r => r.month === month)
    const map = new Map<string, { team:string; league:string; games:number; w:number; p:number }>()
    for (const r of rows) {
      const k = r.team
      const e = map.get(k) ?? { team: r.team, league: r.league, games: 0, w: 0, p: 0 }
      e.games += r.games
      e.w += Number(r.actual_wr) * r.games
      e.p += Number(r.model_wr)  * r.games
      map.set(k, e)
    }
    const out: Row[] = []
    for (const e of map.values()) {
      const a = e.w / Math.max(e.games, 1)
      const p = e.p / Math.max(e.games, 1)
      out.push({
        team: e.team, league: e.league, month: 0, games: e.games,
        actual_wr: Number(a.toFixed(4)),
        model_wr:  Number(p.toFixed(4)),
        bias:      Number((p - a).toFixed(4)),
      })
    }
    return out
  }, [rows, month])

  const filtered = useMemo(() => {
    const subset = league === 'All' ? aggregated : aggregated.filter(r => r.league === league)
    const dir = sortAsc ? 1 : -1
    const cmp = (a: Row, b: Row): number => {
      if (sortKey === 'team') return dir * a.team.localeCompare(b.team)
      const av = a[sortKey] as number
      const bv = b[sortKey] as number
      return dir * (av - bv)
    }
    return [...subset].sort(cmp)
  }, [aggregated, league, sortKey, sortAsc])

  // Summary across the filtered view
  const summary = useMemo(() => {
    if (!filtered.length) return null
    const meanBias    = filtered.reduce((s,r) => s + r.bias, 0) / filtered.length
    const meanAbsBias = filtered.reduce((s,r) => s + Math.abs(r.bias), 0) / filtered.length
    const overrated   = [...filtered].sort((a,b) => b.bias - a.bias)[0]
    const underrated  = [...filtered].sort((a,b) => a.bias - b.bias)[0]
    return { meanBias, meanAbsBias, overrated, underrated }
  }, [filtered])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'team') }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">← Back</Link>
        <h1 className="text-2xl font-bold text-cyan-400">Model Calibration · {YEAR}</h1>
        <span className="text-sm text-gray-500 ml-auto">
          {loading ? 'Loading…' : `${filtered.length} teams`}
        </span>
      </header>

      <main className="px-6 py-6 max-w-6xl mx-auto space-y-6">
        {err && <div className="text-red-400 text-sm">Error: {err}</div>}

        <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-300">
          <p>
            For each team-month, <span className="text-blue-300 font-semibold">model WR</span> is the average pre-draft
            model probability of winning, taken from the side the team played. <span className="text-blue-300 font-semibold">Actual WR</span> is
            their realized win rate. <span className="text-blue-300 font-semibold">Bias</span> = model − actual.
          </p>
          <p className="mt-2">
            <span className="text-red-400 font-semibold">Positive bias</span>: model was too bullish (team underperformed).{' '}
            <span className="text-green-400 font-semibold">Negative bias</span>: model was too bearish (team overperformed).
            Bias near zero = well-calibrated.
          </p>
        </section>

        {/* Filters */}
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs text-gray-500 uppercase mr-1 self-center">League</span>
            {LEAGUES.map(l => (
              <button key={l} onClick={() => setLeague(l)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                  league === l ? 'bg-cyan-700 text-white' : 'bg-gray-900 border border-gray-800 text-gray-400 hover:text-white'
                }`}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs text-gray-500 uppercase mr-1 self-center">Month</span>
            <button onClick={() => setMonth('all')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                month === 'all' ? 'bg-cyan-700 text-white' : 'bg-gray-900 border border-gray-800 text-gray-400 hover:text-white'
              }`}>
              All
            </button>
            {months.map(m => (
              <button key={m} onClick={() => setMonth(m)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                  month === m ? 'bg-cyan-700 text-white' : 'bg-gray-900 border border-gray-800 text-gray-400 hover:text-white'
                }`}>
                {MONTHS[m - 1]}
              </button>
            ))}
          </div>
        </div>

        {/* Summary tiles */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Mean bias"     value={fmtBias(summary.meanBias)}    color={Math.abs(summary.meanBias) < 0.02 ? 'text-gray-200' : summary.meanBias > 0 ? 'text-red-400' : 'text-green-400'} />
            <Tile label="Mean |bias|"   value={summary.meanAbsBias.toFixed(3)} color="text-gray-200" />
            <Tile label="Most overrated"  value={`${summary.overrated.team} ${fmtBias(summary.overrated.bias)}`} color="text-red-400" />
            <Tile label="Most underrated" value={`${summary.underrated.team} ${fmtBias(summary.underrated.bias)}`} color="text-green-400" />
          </div>
        )}

        {/* Table */}
        <section className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {loading ? (
            <div className="space-y-px">
              {[...Array(12)].map((_, i) => (
                <div key={i} className="h-9 bg-gray-800/50 animate-pulse" style={{ opacity: 1 - i * 0.05 }} />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-800 bg-gray-900/80 text-xs text-gray-400 uppercase">
                <tr>
                  <th className="text-right py-3 px-3 w-12">#</th>
                  <ColHeader label="Team"   onClick={() => toggleSort('team')}      active={sortKey==='team'}     asc={sortAsc} />
                  <th className="text-left py-3 px-3">League</th>
                  <ColHeader label="Games"  onClick={() => toggleSort('games')}     active={sortKey==='games'}    asc={sortAsc} align="right" />
                  <ColHeader label="Actual WR" onClick={() => toggleSort('actual_wr')} active={sortKey==='actual_wr'} asc={sortAsc} align="right" />
                  <ColHeader label="Model WR"  onClick={() => toggleSort('model_wr')}  active={sortKey==='model_wr'}  asc={sortAsc} align="right" />
                  <ColHeader label="Bias"      onClick={() => toggleSort('bias')}      active={sortKey==='bias'}      asc={sortAsc} align="right" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={`${r.team}-${r.month}`} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                    <td className="py-2 px-3 text-right text-gray-500">{i + 1}</td>
                    <td className="py-2 px-3 font-semibold text-white">
                      <Link href={`/players/${encodeURIComponent(r.team)}`}
                            className="hover:text-cyan-400"
                            title="Players on this team — open Player Lookup">
                        {r.team}
                      </Link>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${leagueBadge(r.league)}`}>
                        {r.league}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right text-gray-400 font-mono">{r.games}</td>
                    <td className="py-2 px-3 text-right text-gray-200 font-mono">{(r.actual_wr * 100).toFixed(1)}%</td>
                    <td className="py-2 px-3 text-right text-gray-200 font-mono">{(r.model_wr * 100).toFixed(1)}%</td>
                    <td className={`py-2 px-3 text-right font-mono font-bold ${biasColor(r.bias)}`}>
                      {fmtBias(r.bias)}
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

function ColHeader({ label, onClick, active, asc, align = 'left' }:
  { label:string; onClick:()=>void; active:boolean; asc:boolean; align?:'left'|'right' }) {
  return (
    <th
      onClick={onClick}
      className={`py-3 px-3 cursor-pointer select-none hover:text-white transition-colors ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${active ? 'text-white' : ''}`}
    >
      {label}
      {active && <span className="ml-1 text-gray-500">{asc ? '↑' : '↓'}</span>}
    </th>
  )
}

function Tile({ label, value, color }: { label:string; value:string; color:string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded px-3 py-2">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-base font-mono font-bold ${color}`}>{value}</div>
    </div>
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

function biasColor(b: number) {
  const a = Math.abs(b)
  if (a < 0.03) return 'text-gray-300'
  if (b > 0)    return a > 0.10 ? 'text-red-500' : 'text-red-400'
  return a > 0.10 ? 'text-green-500' : 'text-green-400'
}

function fmtBias(b: number) {
  const pp = b * 100
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`
}
