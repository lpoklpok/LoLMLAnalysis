'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

interface Game {
  id: number
  date: string
  league: string
  year: number
  playoffs: number
  blue_team: string
  red_team: string
  blue_win: number
  blue_elo: number | null
  red_elo: number | null
  elo_diff: number | null
  h2h_wr: number | null
  rwr_diff: number | null
  gd15_diff: number | null
  outperf_diff: number | null
  q_blue_win: number | null
  model_pred: number | null
  game_in_series: number | null
  series_type: string | null
  mkt_model_abs: number | null  // |market - model|, computed client-side
  ll_diff: number | null        // mkt_ll - model_ll (positive = model won)
}

type SortKey = keyof Game
type SortDir = 'asc' | 'desc'

const COLS: { key: SortKey; label: string; fmt?: (v: number) => string; width?: string }[] = [
  { key: 'date',         label: 'Date',       width: 'w-24' },
  { key: 'league',       label: 'League',     width: 'w-14' },
  { key: 'blue_team',    label: 'Blue',       width: 'w-36' },
  { key: 'red_team',     label: 'Red',        width: 'w-36' },
  { key: 'blue_win',      label: 'Result',     width: 'w-16' },
  { key: 'series_type',   label: 'Series',     width: 'w-12' },
  { key: 'game_in_series', label: 'Game',      width: 'w-10' },
  { key: 'model_pred',   label: 'Model',      fmt: v => `${(v*100).toFixed(0)}%` },
  { key: 'q_blue_win',   label: 'Market',     fmt: v => `${(v*100).toFixed(0)}%` },
  { key: 'elo_diff',     label: 'ELO Δ',      fmt: v => (v>=0?'+':'')+v.toFixed(0) },
  { key: 'h2h_wr',       label: 'H2H',        fmt: v => `${(v*100).toFixed(0)}%` },
  { key: 'rwr_diff',     label: 'WR Δ',       fmt: v => (v>=0?'+':'')+`${(v*100).toFixed(0)}%` },
  { key: 'gd15_diff',    label: 'GD15 Δ',     fmt: v => (v>=0?'+':'')+v.toFixed(0) },
  { key: 'outperf_diff', label: 'Outperf Δ',  fmt: v => (v>=0?'+':'')+`${(v*100).toFixed(1)}%` },
  { key: 'mkt_model_abs', label: '|Mkt−Model|', fmt: v => `${(v*100).toFixed(0)}pp` },
  { key: 'll_diff',       label: 'MktLL−MdlLL', fmt: v => (v>=0?'+':'')+v.toFixed(3) },
]

function fmt(col: typeof COLS[0], val: unknown): string {
  if (val === null || val === undefined) return '—'
  if (col.fmt) return col.fmt(val as number)
  if (col.key === 'date') return new Date(val as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })
  if (col.key === 'blue_win') return (val as number) === 1 ? 'Blue' : 'Red'
  return String(val)
}

function cellColor(col: typeof COLS[0], val: unknown, row: Game): string {
  if (val === null || val === undefined) return 'text-gray-600'
  const v = val as number
  if (col.key === 'blue_win') return v === 1 ? 'text-blue-400 font-semibold' : 'text-red-400 font-semibold'
  if (col.key === 'model_pred') return v >= 0.6 ? 'text-blue-400' : v <= 0.4 ? 'text-red-400' : 'text-gray-300'
  if (col.key === 'q_blue_win') return v >= 0.6 ? 'text-blue-400' : v <= 0.4 ? 'text-red-400' : 'text-gray-300'
  if (col.key === 'elo_diff' || col.key === 'rwr_diff' || col.key === 'gd15_diff' || col.key === 'outperf_diff') {
    return v > 0 ? 'text-blue-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
  }
  if (col.key === 'h2h_wr') return v > 0.5 ? 'text-blue-400' : v < 0.5 ? 'text-red-400' : 'text-gray-400'
  if (col.key === 'll_diff') return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
  return 'text-gray-300'
}

export default function GamesPage() {
  const [games, setGames]       = useState<Game[]>([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [league, setLeague]     = useState('All')
  const [year, setYear]         = useState('All')
  const [playoffs, setPlayoffs] = useState('All')
  const [sortKey, setSortKey]   = useState<SortKey>('date')
  const [sortDir, setSortDir]   = useState<SortDir>('desc')
  const [page, setPage]         = useState(0)
  const PAGE_SIZE = 100

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data } = await supabase
        .from('game_features')
        .select('*')
        .order('date', { ascending: false })
      setGames((data ?? []).map(g => {
        const outcome = g.blue_win
        const mkt = g.q_blue_win
        const mdl = g.model_pred
        const mkt_model_abs = (mkt != null && mdl != null)
          ? Math.round(Math.abs(mkt - mdl) * 100) / 100
          : null
        let ll_diff: number | null = null
        if (mkt != null && mdl != null) {
          const clamp = (p: number) => Math.max(1e-6, Math.min(1 - 1e-6, p))
          const mkt_ll  = outcome === 1 ? -Math.log(clamp(mkt)) : -Math.log(clamp(1 - mkt))
          const mdl_ll  = outcome === 1 ? -Math.log(clamp(mdl)) : -Math.log(clamp(1 - mdl))
          ll_diff = Math.round((mkt_ll - mdl_ll) * 1000) / 1000
        }
        return { ...g, mkt_model_abs, ll_diff }
      }))
      setLoading(false)
    }
    load()
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return games.filter(g => {
      if (league !== 'All' && g.league !== league) return false
      if (year !== 'All' && g.year !== parseInt(year)) return false
      if (playoffs === 'Playoffs' && !g.playoffs) return false
      if (playoffs === 'Regular' && g.playoffs) return false
      if (q && !g.blue_team.toLowerCase().includes(q) && !g.red_team.toLowerCase().includes(q)) return false
      return true
    })
  }, [games, league, year, playoffs, search])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir])

  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(0)
  }

  function handleFilter() { setPage(0) }

  const leagues = ['All', 'LCK', 'LEC', 'LPL']
  const years   = ['All', '2024', '2025', '2026']

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">LCK · LEC · LCS · LPL · 2024–2026</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"           className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
        <Link href="/players"    className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Player Lookup</Link>
        <Link href="/model"      className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        <Link href="/predictions" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Predictions</Link>
        <span className="text-sm text-yellow-400 font-medium">Game Explorer</span>
      </div>

      {/* Filters */}
      <div className="px-6 py-3 border-b border-gray-800 flex gap-4 flex-wrap items-center">
        <input
          type="text"
          placeholder="Search team…"
          value={search}
          onChange={e => { setSearch(e.target.value); handleFilter() }}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 w-44 focus:outline-none focus:border-blue-500"
        />
        {[
          { label: 'League',   value: league,   set: setLeague,   opts: leagues },
          { label: 'Year',     value: year,     set: setYear,     opts: years },
          { label: 'Stage',    value: playoffs, set: setPlayoffs, opts: ['All', 'Regular', 'Playoffs'] },
        ].map(({ label, value, set, opts }) => (
          <div key={label} className="flex items-center gap-2">
            <label className="text-sm text-gray-400">{label}</label>
            <select
              value={value}
              onChange={e => { set(e.target.value); handleFilter() }}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            >
              {opts.map(o => <option key={o}>{o}</option>)}
            </select>
          </div>
        ))}
        <span className="text-xs text-gray-500 ml-auto">
          {loading ? 'Loading…' : `${sorted.length.toLocaleString()} games`}
        </span>
      </div>

      <main className="px-6 py-4 overflow-x-auto">
        {loading ? (
          <p className="text-gray-500 text-sm mt-8">Loading…</p>
        ) : (
          <>
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-gray-800">
                  {COLS.map(col => (
                    <th
                      key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`text-left py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none ${col.width ?? ''}`}
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map(row => (
                  <tr
                    key={row.id}
                    className={`border-b border-gray-800/30 hover:bg-gray-900/50 ${
                      row.blue_win === 1 ? 'bg-blue-950/10' : 'bg-red-950/10'
                    }`}
                  >
                    {COLS.map(col => (
                      <td key={col.key} className={`py-1.5 pr-4 font-mono ${cellColor(col, row[col.key], row)}`}>
                        {fmt(col, row[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center gap-3 mt-4 text-sm">
                <button
                  onClick={() => setPage(p => Math.max(0, p-1))}
                  disabled={page === 0}
                  className="px-3 py-1 bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
                >
                  ← Prev
                </button>
                <span className="text-gray-500">
                  Page {page+1} of {totalPages} ({sorted.length.toLocaleString()} games)
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages-1, p+1))}
                  disabled={page === totalPages-1}
                  className="px-3 py-1 bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
