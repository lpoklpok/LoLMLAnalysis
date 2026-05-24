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
  q_blue_win: number | null            // oddsportal-derived market prob
  poly_blue_win_prob: number | null    // Polymarket-derived market prob (newer source)
  poly_source: string | null
  model_pred: number | null
  game_in_series: number | null
  series_type: string | null
  // Derived: q_blue_win when present, else poly_blue_win_prob
  effective_market: number | null
  market_source: 'oddsportal' | 'polymarket' | null
  mkt_model_abs: number | null
  ll_diff: number | null
  // Kelly columns — only for poly-era games (date >= 2026-05-21)
  // Assume 1% slippage to buy the market (e.g. pay 95¢ for a 94¢ mid). Bet sizing
  // rounded to whole-percent of bankroll. Side = whichever side has positive
  // edge after slippage; null if neither side does.
  kelly_side: 'BLU' | 'RED' | null
  kelly_bet_pct: number | null
  kelly_pl_pct: number | null
}

interface PivotRow {
  team: string
  games: number
  wins: number
  win_rate: number
  odds_games: number
  avg_ll_diff: number | null
  avg_mkt_model_abs: number | null
}

type SortKey = keyof Game
type SortDir = 'asc' | 'desc'
type PivotSortKey = keyof PivotRow
type Mode = 'games' | 'pivot'

const COLS: { key: SortKey; label: string; fmt?: (v: number) => string; width?: string }[] = [
  { key: 'date',           label: 'Date',        width: 'w-24' },
  { key: 'league',         label: 'League',      width: 'w-14' },
  { key: 'blue_team',      label: 'Blue',        width: 'w-36' },
  { key: 'red_team',       label: 'Red',         width: 'w-36' },
  { key: 'blue_win',       label: 'Result',      width: 'w-16' },
  { key: 'series_type',    label: 'Series',      width: 'w-12' },
  { key: 'game_in_series', label: 'Game',        width: 'w-10' },
  { key: 'model_pred',      label: 'Model',       fmt: v => `${(v*100).toFixed(0)}%` },
  { key: 'effective_market',label: 'Market',      fmt: v => `${(v*100).toFixed(0)}%` },
  { key: 'elo_diff',       label: 'ELO Δ',       fmt: v => (v>=0?'+':'')+v.toFixed(0) },
  { key: 'h2h_wr',         label: 'H2H',         fmt: v => `${(v*100).toFixed(0)}%` },
  { key: 'rwr_diff',       label: 'WR Δ',        fmt: v => (v>=0?'+':'')+`${(v*100).toFixed(0)}%` },
  { key: 'gd15_diff',      label: 'GD15 Δ',      fmt: v => (v>=0?'+':'')+v.toFixed(0) },
  { key: 'outperf_diff',   label: 'Outperf Δ',   fmt: v => (v>=0?'+':'')+`${(v*100).toFixed(1)}%` },
  { key: 'mkt_model_abs',  label: '|Mkt−Model|', fmt: v => `${(v*100).toFixed(0)}pp` },
  { key: 'll_diff',        label: 'MktLL−MdlLL', fmt: v => (v>=0?'+':'')+v.toFixed(3) },
  { key: 'kelly_bet_pct',  label: 'Kelly Bet',   fmt: v => `${v.toFixed(0)}%` },
  { key: 'kelly_pl_pct',   label: 'P&L',         fmt: v => (v>=0?'+':'')+`${v.toFixed(1)}%` },
]

const PIVOT_COLS: { key: PivotSortKey; label: string; fmt: (v: number) => string; tip: string }[] = [
  { key: 'team',             label: 'Team',         fmt: v => String(v),                          tip: 'Team name' },
  { key: 'games',            label: 'Games',        fmt: v => v.toFixed(0),                       tip: 'Total games in filtered set' },
  { key: 'win_rate',         label: 'Win %',        fmt: v => `${(v*100).toFixed(1)}%`,           tip: 'Win rate' },
  { key: 'odds_games',       label: 'W/ Odds',      fmt: v => v.toFixed(0),                       tip: 'Games with any market odds (oddsportal or Polymarket)' },
  { key: 'avg_ll_diff',      label: 'Avg MktLL−MdlLL', fmt: v => (v>=0?'+':'')+v.toFixed(3),    tip: 'Avg per-game (market LL − model LL). Positive = model outperformed market.' },
  { key: 'avg_mkt_model_abs', label: 'Avg |Mkt−Model|', fmt: v => `${(v*100).toFixed(1)}pp`,   tip: 'Average absolute market vs model disagreement' },
]

function fmt(col: typeof COLS[0], val: unknown, row?: Game): string {
  if (val === null || val === undefined) return '—'
  if (col.key === 'kelly_bet_pct') {
    const side = row?.kelly_side
    return side ? `${side} ${(val as number).toFixed(0)}%` : '—'
  }
  if (col.fmt) return col.fmt(val as number)
  if (col.key === 'date') return new Date(val as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })
  if (col.key === 'blue_win') return (val as number) === 1 ? 'Blue' : 'Red'
  return String(val)
}

function cellColor(col: typeof COLS[0], val: unknown): string {
  if (val === null || val === undefined) return 'text-gray-600'
  const v = val as number
  if (col.key === 'blue_win') return v === 1 ? 'text-blue-400 font-semibold' : 'text-red-400 font-semibold'
  if (col.key === 'model_pred') return v >= 0.6 ? 'text-blue-400' : v <= 0.4 ? 'text-red-400' : 'text-gray-300'
  if (col.key === 'effective_market') return v >= 0.6 ? 'text-blue-400' : v <= 0.4 ? 'text-red-400' : 'text-gray-300'
  if (col.key === 'elo_diff' || col.key === 'rwr_diff' || col.key === 'gd15_diff' || col.key === 'outperf_diff') {
    return v > 0 ? 'text-blue-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
  }
  if (col.key === 'h2h_wr') return v > 0.5 ? 'text-blue-400' : v < 0.5 ? 'text-red-400' : 'text-gray-400'
  if (col.key === 'll_diff') return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
  if (col.key === 'kelly_pl_pct') return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
  if (col.key === 'kelly_bet_pct') return 'text-yellow-300'
  return 'text-gray-300'
}

function pivotCellColor(key: PivotSortKey, val: number | null): string {
  if (val === null) return 'text-gray-600'
  if (key === 'avg_ll_diff') return val > 0.01 ? 'text-green-400' : val < -0.01 ? 'text-red-400' : 'text-gray-400'
  if (key === 'win_rate') return val >= 0.6 ? 'text-blue-400' : val <= 0.4 ? 'text-red-400' : 'text-gray-300'
  return 'text-gray-300'
}

export default function GamesPage() {
  const [games, setGames]       = useState<Game[]>([])
  const [loading, setLoading]   = useState(true)
  const [mode, setMode]         = useState<Mode>('games')
  const [search, setSearch]     = useState('')
  const [league, setLeague]     = useState('All')
  const [year, setYear]         = useState('All')
  const [playoffs, setPlayoffs] = useState('All')

  // Game table sort
  const [sortKey, setSortKey]   = useState<SortKey>('date')
  const [sortDir, setSortDir]   = useState<SortDir>('desc')
  const [page, setPage]         = useState(0)
  const PAGE_SIZE = 100

  // Pivot sort
  const [pivotSort, setPivotSort] = useState<PivotSortKey>('avg_ll_diff')
  const [pivotDir, setPivotDir]   = useState<SortDir>('desc')

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data } = await supabase
        .from('game_features')
        .select('*')
        .order('date', { ascending: false })
      setGames((data ?? []).map(g => {
        const outcome = g.blue_win
        const mdl = g.model_pred
        // Coalesce: oddsportal first (historical coverage), fall back to Polymarket
        const effective_market: number | null = g.q_blue_win ?? g.poly_blue_win_prob ?? null
        const market_source: 'oddsportal' | 'polymarket' | null =
          g.q_blue_win != null ? 'oddsportal'
          : g.poly_blue_win_prob != null ? 'polymarket'
          : null
        const mkt_model_abs = (effective_market != null && mdl != null)
          ? Math.round(Math.abs(effective_market - mdl) * 100) / 100
          : null
        let ll_diff: number | null = null
        if (effective_market != null && mdl != null) {
          const clamp = (p: number) => Math.max(1e-6, Math.min(1 - 1e-6, p))
          const mkt_ll = outcome === 1 ? -Math.log(clamp(effective_market)) : -Math.log(clamp(1 - effective_market))
          const mdl_ll = outcome === 1 ? -Math.log(clamp(mdl)) : -Math.log(clamp(1 - mdl))
          ll_diff = Math.round((mkt_ll - mdl_ll) * 1000) / 1000
        }
        // Kelly bet: only for polymarket-era games (date >= 2026-05-21) with both odds + model
        let kelly_side: 'BLU' | 'RED' | null = null
        let kelly_bet_pct: number | null = null
        let kelly_pl_pct:  number | null = null
        const polyMid = g.poly_blue_win_prob
        if (polyMid != null && mdl != null && g.date >= '2026-05-21') {
          const SLIP = 0.01
          // Two candidate sides; pick whichever has positive edge (if any)
          const buyYes = polyMid + SLIP          // pay (mid+1%) to bet BLUE wins
          const buyNo  = (1 - polyMid) + SLIP    // pay (1-mid+1%) to bet RED wins
          const edgeYes = mdl - buyYes
          const edgeNo  = (1 - mdl) - buyNo
          if (edgeYes > 0 || edgeNo > 0) {
            const side  = edgeYes >= edgeNo ? 'BLU' : 'RED'
            const p     = side === 'BLU' ? mdl : (1 - mdl)
            const price = side === 'BLU' ? buyYes : buyNo
            // Full Kelly: f* = (p - price) / (1 - price). Round to whole-percent.
            const f = (p - price) / (1 - price)
            const bet_pct = Math.max(0, Math.min(100, Math.round(f * 100)))
            if (bet_pct > 0) {
              kelly_side = side
              kelly_bet_pct = bet_pct
              const won = (side === 'BLU' && outcome === 1) || (side === 'RED' && outcome === 0)
              // Win: stake / price = shares; each pays $1 → profit = stake * (1-price)/price
              // Lose: forfeit the stake
              kelly_pl_pct = won
                ? Math.round(bet_pct * (1 - price) / price * 10) / 10
                : -bet_pct
            }
          }
        }
        return { ...g, effective_market, market_source, mkt_model_abs, ll_diff,
                 kelly_side, kelly_bet_pct, kelly_pl_pct }
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

  const pivotRows = useMemo<PivotRow[]>(() => {
    const map = new Map<string, { games: number; wins: number; ll: number[]; abs: number[] }>()
    for (const g of filtered) {
      const sides: [string, boolean][] = [
        [g.blue_team, g.blue_win === 1],
        [g.red_team,  g.blue_win === 0],
      ]
      for (const [team, won] of sides) {
        if (!map.has(team)) map.set(team, { games: 0, wins: 0, ll: [], abs: [] })
        const r = map.get(team)!
        r.games++
        if (won) r.wins++
        if (g.ll_diff != null) r.ll.push(g.ll_diff)
        if (g.mkt_model_abs != null) r.abs.push(g.mkt_model_abs)
      }
    }
    const rows: PivotRow[] = [...map.entries()].map(([team, r]) => ({
      team,
      games: r.games,
      wins: r.wins,
      win_rate: r.wins / r.games,
      odds_games: r.ll.length,
      avg_ll_diff: r.ll.length ? r.ll.reduce((a, b) => a + b, 0) / r.ll.length : null,
      avg_mkt_model_abs: r.abs.length ? r.abs.reduce((a, b) => a + b, 0) / r.abs.length : null,
    }))
    return rows.sort((a, b) => {
      const av = a[pivotSort], bv = b[pivotSort]
      if (av === null) return 1
      if (bv === null) return -1
      const cmp = (av as number) < (bv as number) ? -1 : (av as number) > (bv as number) ? 1 : 0
      return pivotDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, pivotSort, pivotDir])

  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)

  // Kelly summary across all currently-filtered games (NOT just the page)
  const kellySummary = useMemo(() => {
    const bets = filtered.filter(g => g.kelly_bet_pct != null && g.kelly_pl_pct != null)
    if (!bets.length) return null
    const total_pl = bets.reduce((s, g) => s + (g.kelly_pl_pct as number), 0)
    const wins    = bets.filter(g => (g.kelly_pl_pct as number) > 0).length
    return { n: bets.length, total_pl, wins }
  }, [filtered])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(0)
  }

  function togglePivotSort(key: PivotSortKey) {
    if (pivotSort === key) setPivotDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setPivotSort(key); setPivotDir('desc') }
  }

  function handleFilter() { setPage(0) }

  const leagues = useMemo(() => ['All', ...Array.from(new Set(games.map(g => g.league))).sort()], [games])
  const years   = useMemo(() => ['All', ...Array.from(new Set(games.map(g => String(g.year)))).sort().reverse()], [games])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">All leagues · 2024–2026</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"            className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
        <Link href="/players"     className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Player Lookup</Link>
        <Link href="/model"       className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        <Link href="/predictions" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Predictions</Link>
        <Link href="/chart"       className="text-sm text-purple-400 hover:text-purple-300 transition-colors">Model vs Market</Link>
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
          { label: 'League', value: league,   set: setLeague,   opts: leagues },
          { label: 'Year',   value: year,     set: setYear,     opts: years },
          { label: 'Stage',  value: playoffs, set: setPlayoffs, opts: ['All', 'Regular', 'Playoffs'] },
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

        {/* Mode toggle */}
        <div className="ml-auto flex rounded overflow-hidden border border-gray-700 text-xs">
          <button
            onClick={() => setMode('games')}
            className={`px-3 py-1.5 ${mode === 'games' ? 'bg-yellow-500 text-gray-900 font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
          >
            Games
          </button>
          <button
            onClick={() => setMode('pivot')}
            className={`px-3 py-1.5 ${mode === 'pivot' ? 'bg-yellow-500 text-gray-900 font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
          >
            Team Pivot
          </button>
        </div>

        <span className="text-xs text-gray-500">
          {loading ? 'Loading…' : mode === 'games'
            ? `${sorted.length.toLocaleString()} games`
            : `${pivotRows.length} teams`}
        </span>
      </div>

      <main className="px-6 py-4 overflow-x-auto">
        {loading ? (
          <p className="text-gray-500 text-sm mt-8">Loading…</p>
        ) : mode === 'games' ? (
          <>
            {kellySummary && (
              <p className="text-xs text-gray-400 mb-3">
                Kelly across filtered set: <span className="text-yellow-300 font-mono">{kellySummary.n} bets</span>
                {', '}
                <span className="font-mono">{kellySummary.wins}-{kellySummary.n - kellySummary.wins}</span>
                {', total P&L '}
                <span className={`font-mono ${kellySummary.total_pl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {kellySummary.total_pl >= 0 ? '+' : ''}{kellySummary.total_pl.toFixed(1)}% of bankroll
                </span>
                <span className="text-gray-500 ml-2">(1% slippage, full-percent Kelly, polymarket-era only)</span>
              </p>
            )}
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
                      <td key={col.key} className={`py-1.5 pr-4 font-mono ${cellColor(col, row[col.key])}`}>
                        {fmt(col, row[col.key], row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

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
        ) : (
          /* Pivot table */
          <>
            <p className="text-xs text-gray-500 mb-3">
              Each row aggregates all filtered games for that team.
              <span className="ml-2 text-green-400">Green Avg MktLL−MdlLL</span> = model beat market on average for those games.
            </p>
            <table className="text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-gray-800">
                  {PIVOT_COLS.map(col => (
                    <th
                      key={col.key}
                      onClick={() => togglePivotSort(col.key)}
                      title={col.tip}
                      className="text-left py-2 pr-6 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none"
                    >
                      {col.label}
                      {pivotSort === col.key && (
                        <span className="ml-1 text-gray-400">{pivotDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pivotRows.map(row => (
                  <tr key={row.team} className="border-b border-gray-800/30 hover:bg-gray-900/50">
                    <td className="py-1.5 pr-6 font-medium text-gray-200">{row.team}</td>
                    <td className="py-1.5 pr-6 font-mono text-gray-300">{row.games}</td>
                    <td className={`py-1.5 pr-6 font-mono ${pivotCellColor('win_rate', row.win_rate)}`}>
                      {(row.win_rate * 100).toFixed(1)}%
                    </td>
                    <td className="py-1.5 pr-6 font-mono text-gray-400">{row.odds_games}</td>
                    <td className={`py-1.5 pr-6 font-mono ${pivotCellColor('avg_ll_diff', row.avg_ll_diff)}`}>
                      {row.avg_ll_diff != null ? (row.avg_ll_diff >= 0 ? '+' : '') + row.avg_ll_diff.toFixed(3) : '—'}
                    </td>
                    <td className="py-1.5 pr-6 font-mono text-gray-300">
                      {row.avg_mkt_model_abs != null ? `${(row.avg_mkt_model_abs * 100).toFixed(1)}pp` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  )
}
