'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
  Legend,
} from 'recharts'

// ---------- types ----------

interface FilterStats {
  key: string
  label: string
  n_bets: number
  n_total: number
  final: number
  pnl: number
  pct: number
  win_rate: number
  mdd: number
}

interface CurvePoint { date: string; bankroll: number }

interface Bet {
  date: string
  league: string
  blue_team: string
  red_team: string
  model_p: number
  market_q: number
  blue_win: number
  side: string
  prob_edge: number
  kelly_f: number
  stake: number
  result: number
  bankroll: number
  won: boolean
}

interface BacktestData {
  generated: string
  starting_bankroll: number
  fee_pct: number
  filters: FilterStats[]
  bets: Bet[]
  curves: Record<string, CurvePoint[]>
}

// ---------- constants ----------

const FILTER_COLORS: Record<string, string> = {
  no_threshold: '#6b7280',
  prob_3pct:    '#60a5fa',
  prob_5pct:    '#3b82f6',
  kelly_3pct:   '#a78bfa',
  kelly_5pct:   '#8b5cf6',
}

const KELLY_COLORS: Record<string, string> = {
  quarter: '#fbbf24',
  half:    '#8b5cf6',
  full:    '#ef4444',
}

const KELLY_FRACTIONS: { key: string; label: string; frac: number }[] = [
  { key: 'quarter', label: '¼ Kelly', frac: 0.5 },
  { key: 'half',    label: '½ Kelly', frac: 1.0 },
  { key: 'full',    label: 'Full Kelly', frac: 2.0 },
]

const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const fmtDate = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

const fmtDateShort = (d: string) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// ---------- chart tooltip ----------

function CurveTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs shadow-xl min-w-[180px]">
      <div className="text-gray-400 mb-2 font-medium">{label ? fmtDate(label) : ''}</div>
      {payload.map(p => (
        <div key={p.name} className="flex justify-between gap-6">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono text-gray-200">{fmt$(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- sub-components ----------

function StatCard({ label, value, sub, color = 'text-white' }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function FilterSummaryTable({ filters }: { filters: FilterStats[] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-gray-300">Filter Comparison — 2026 Backtest</h3>
        <p className="text-xs text-gray-500 mt-0.5">$10k starting, 2% Polymarket fee, half-Kelly sizing, 20% max bet, OOS playoff adjustments</p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            {['Filter', 'Bets', 'Final', 'P&L', 'Return', 'Win Rate', 'Max Drawdown'].map(h => (
              <th key={h} className={`py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide ${h === 'Filter' ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filters.map(f => (
            <tr key={f.key} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/30">
              <td className="py-3 px-4">
                <span className="inline-block w-2.5 h-2.5 rounded-full mr-2" style={{ backgroundColor: FILTER_COLORS[f.key] }} />
                <span className="text-gray-200 text-sm">{f.label}</span>
              </td>
              <td className="py-3 px-4 text-right font-mono text-gray-400">{f.n_bets}</td>
              <td className="py-3 px-4 text-right font-mono text-gray-200">{fmt$(f.final)}</td>
              <td className={`py-3 px-4 text-right font-mono font-semibold ${f.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {f.pnl >= 0 ? '+' : ''}{fmt$(f.pnl)}
              </td>
              <td className={`py-3 px-4 text-right font-mono font-semibold ${f.pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {f.pct >= 0 ? '+' : ''}{f.pct.toFixed(1)}%
              </td>
              <td className="py-3 px-4 text-right font-mono text-gray-300">{f.win_rate.toFixed(1)}%</td>
              <td className="py-3 px-4 text-right font-mono text-red-400">{fmt$(f.mdd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- page ----------

export default function BacktestPage() {
  const [data, setData]               = useState<BacktestData | null>(null)
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(['prob_5pct', 'kelly_5pct', 'no_threshold']))
  const [betPage, setBetPage]         = useState(0)
  const BET_PAGE_SIZE = 50

  useEffect(() => {
    fetch('/backtest.json').then(r => r.json()).then(setData)
  }, [])

  // Merge all curves onto a shared date axis
  const curveData = useMemo(() => {
    if (!data) return []
    const allDates = new Set<string>()
    for (const curve of Object.values(data.curves)) curve.forEach(p => allDates.add(p.date))
    const sorted = [...allDates].sort()
    return sorted.map(date => {
      const row: Record<string, string | number> = { date }
      for (const [key, curve] of Object.entries(data.curves)) {
        const pt = curve.find(p => p.date === date)
        if (pt) row[key] = pt.bankroll
      }
      return row
    })
  }, [data])

  // Monthly P&L bar chart for kelly_5pct
  const monthlyData = useMemo(() => {
    if (!data) return []
    const curve = data.curves['kelly_5pct']
    const byMonth: Record<string, number> = {}
    let prev = 10000
    for (const pt of curve) {
      if (pt.date === '2025-12-31') continue
      const month = pt.date.slice(0, 7)
      byMonth[month] = pt.bankroll
    }
    const months = Object.keys(byMonth).sort()
    let last = 10000
    return months.map(m => {
      const end = byMonth[m]
      const pnl = end - last
      last = end
      return { month: m.slice(5) === '01' ? `Jan` : m.slice(5) === '02' ? `Feb` : m.slice(5) === '03' ? `Mar` : m.slice(5) === '04' ? `Apr` : `May`, pnl: Math.round(pnl) }
    })
  }, [data])

  const kellyComparison = useMemo(() => {
    if (!data) return []
    return KELLY_FRACTIONS.map(({ key, label, frac }) => {
      let bankroll = data.starting_bankroll
      let peak = bankroll
      let mdd = 0
      const curve: { date: string; bankroll: number }[] = []

      for (const bet of data.bets) {
        const mp = bet.side === 'blue' ? bet.market_q : 1 - bet.market_q
        const odds = (1 - mp) / mp
        const f = Math.min(bet.kelly_f * frac, 0.20)
        bankroll += bet.won ? f * bankroll * odds * (1 - data.fee_pct) : -f * bankroll
        if (bankroll > peak) peak = bankroll
        mdd = Math.max(mdd, peak - bankroll)

        const last = curve[curve.length - 1]
        if (last?.date === bet.date) last.bankroll = Math.round(bankroll)
        else curve.push({ date: bet.date, bankroll: Math.round(bankroll) })
      }

      return {
        key, label,
        final: Math.round(bankroll),
        pct: ((bankroll - data.starting_bankroll) / data.starting_bankroll) * 100,
        mdd: Math.round(mdd),
        curve,
      }
    })
  }, [data])

  const kellyCurveData = useMemo(() => {
    if (!kellyComparison.length) return []
    const allDates = new Set<string>()
    kellyComparison.forEach(k => k.curve.forEach(p => allDates.add(p.date)))
    return [...allDates].sort().map(date => {
      const row: Record<string, string | number> = { date }
      for (const k of kellyComparison) {
        const pt = k.curve.find(p => p.date === date)
        if (pt) row[k.key] = pt.bankroll
      }
      return row
    })
  }, [kellyComparison])

  const bets = data?.bets ?? []
  const pageBets = bets.slice(betPage * BET_PAGE_SIZE, (betPage + 1) * BET_PAGE_SIZE)
  const totalPages = Math.ceil(bets.length / BET_PAGE_SIZE)

  const toggleFilter = (key: string) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) { if (next.size > 1) next.delete(key) }
      else next.add(key)
      return next
    })
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
        <p className="text-gray-500">Loading backtest…</p>
      </div>
    )
  }

  const best = data.filters.find(f => f.key === 'kelly_5pct')!

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">LCK · LEC · LCS · LPL · 2024–2026</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"            className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
        <Link href="/players"     className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Player Lookup</Link>
        <Link href="/model"       className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        <Link href="/predictions" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Predictions</Link>
        <Link href="/games"       className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Game Explorer</Link>
        <Link href="/chart"       className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model vs Market</Link>
        <span className="text-sm text-emerald-400 font-medium">Kelly Backtest</span>
      </div>

      <main className="px-6 py-6 max-w-7xl mx-auto space-y-8">

        {/* Header */}
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Half-Kelly Backtest — 2026</h2>
          <p className="text-sm text-gray-400 max-w-3xl leading-relaxed">
            Simulated half-Kelly betting on all 2026 LCK/LEC/LPL games with Polymarket odds. Model trained on 2024–2025 data.
            Playoff adjustments fitted on 2024/2025 only (out-of-sample). 2% Polymarket fee on winnings. Max 20% of bankroll per bet.
          </p>
        </div>

        {/* Summary stat cards (best filter) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Starting" value="$10,000" />
          <StatCard label="Final (best)" value={fmt$(best.final)} color="text-emerald-400" sub="Half-Kelly > 5%" />
          <StatCard label="Return" value={`+${best.pct.toFixed(1)}%`} color="text-emerald-400" />
          <StatCard label="Bets placed" value={`${best.n_bets}`} sub={`of ${best.n_total} games`} />
          <StatCard label="Win rate" value={`${best.win_rate.toFixed(1)}%`} sub="bets that won" />
          <StatCard label="Max drawdown" value={fmt$(best.mdd)} color="text-red-400" />
        </div>

        {/* Filter comparison table */}
        <FilterSummaryTable filters={data.filters} />

        {/* Bankroll curve chart */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-200">Bankroll Over Time</h3>
              <p className="text-xs text-gray-500 mt-0.5">Click filters to toggle. Jan–May 2026.</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {data.filters.map(f => (
                <button
                  key={f.key}
                  onClick={() => toggleFilter(f.key)}
                  className={`px-3 py-1 rounded text-xs font-medium border transition-all ${
                    activeFilters.has(f.key)
                      ? 'border-transparent text-white'
                      : 'border-gray-700 text-gray-500 bg-transparent'
                  }`}
                  style={activeFilters.has(f.key) ? { backgroundColor: FILTER_COLORS[f.key] } : {}}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={curveData} margin={{ top: 5, right: 20, bottom: 5, left: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtDateShort}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={{ stroke: '#374151' }}
                tickLine={false}
                interval={15}
              />
              <YAxis
                tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={{ stroke: '#374151' }}
                tickLine={false}
              />
              <ReferenceLine y={10000} stroke="#374151" strokeDasharray="4 4" />
              <Tooltip content={<CurveTooltip />} />
              {data.filters.map(f => activeFilters.has(f.key) && (
                <Line
                  key={f.key}
                  type="monotone"
                  dataKey={f.key}
                  name={f.label}
                  stroke={FILTER_COLORS[f.key]}
                  strokeWidth={f.key === 'kelly_5pct' || f.key === 'prob_5pct' ? 2.5 : 1.5}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-600 mt-2">Dashed line = $10k starting bankroll.</p>
        </div>

        {/* Kelly Fraction Comparison */}
        {kellyComparison.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-gray-200">Kelly Fraction Comparison</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Same bets (Half-Kelly &gt; 5% filter, 290 bets), different stake sizing. All start at $10k.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-5">
              {kellyComparison.map(k => (
                <div key={k.key} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: KELLY_COLORS[k.key] }} />
                    <span className="text-xs font-semibold text-gray-300">{k.label}</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Final</span>
                      <span className="font-mono text-gray-200">{fmt$(k.final)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Return</span>
                      <span className={`font-mono font-semibold ${k.pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {k.pct >= 0 ? '+' : ''}{k.pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Max DD</span>
                      <span className="font-mono text-red-400">{fmt$(k.mdd)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={kellyCurveData} margin={{ top: 5, right: 20, bottom: 5, left: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="date"
                  tickFormatter={fmtDateShort}
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#374151' }}
                  tickLine={false}
                  interval={15}
                />
                <YAxis
                  tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#374151' }}
                  tickLine={false}
                />
                <ReferenceLine y={10000} stroke="#374151" strokeDasharray="4 4" />
                <Tooltip content={<CurveTooltip />} />
                {kellyComparison.map(k => (
                  <Line
                    key={k.key}
                    type="monotone"
                    dataKey={k.key}
                    name={k.label}
                    stroke={KELLY_COLORS[k.key]}
                    strokeWidth={k.key === 'half' ? 2.5 : 1.5}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
              <div className="bg-amber-950/30 border border-amber-900/50 rounded p-3">
                <p className="font-semibold text-amber-400 mb-1">¼ Kelly — Conservative</p>
                <p className="text-gray-400">Smallest drawdowns and variance. Good if you're uncertain about model calibration or want smoother equity. Grows slowest.</p>
              </div>
              <div className="bg-purple-950/30 border border-purple-900/50 rounded p-3">
                <p className="font-semibold text-purple-400 mb-1">½ Kelly — Balanced</p>
                <p className="text-gray-400">~75% of full Kelly geometric growth with significantly lower variance. The standard practical recommendation.</p>
              </div>
              <div className="bg-red-950/30 border border-red-900/50 rounded p-3">
                <p className="font-semibold text-red-400 mb-1">Full Kelly — Aggressive</p>
                <p className="text-gray-400">Maximises log-growth in theory but is highly sensitive to model miscalibration. Drawdowns are severe; ruin risk is real.</p>
              </div>
            </div>
          </div>
        )}

        {/* Monthly P&L bar chart */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-gray-200 mb-1">Monthly P&L — Half-Kelly &gt; 5%</h3>
          <p className="text-xs text-gray-500 mb-4">January cold-start is structural — early-season ELO is stale from off-season roster changes.</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyData} margin={{ top: 5, right: 20, bottom: 5, left: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#374151' }} tickLine={false} />
              <YAxis
                tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={{ stroke: '#374151' }}
                tickLine={false}
              />
              <ReferenceLine y={0} stroke="#374151" />
              <Tooltip
                formatter={(v) => [fmt$(Number(v ?? 0)), 'P&L']}
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 6 }}
                labelStyle={{ color: '#9ca3af' }}
                itemStyle={{ color: '#e5e7eb' }}
              />
              <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                {monthlyData.map((entry, i) => (
                  <Cell key={i} fill={entry.pnl >= 0 ? '#34d399' : '#f87171'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Return comparison bar */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-gray-200 mb-4">Return by Filter</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={data.filters.map(f => ({ label: f.label, pct: f.pct, key: f.key }))}
              margin={{ top: 5, right: 20, bottom: 5, left: 60 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={{ stroke: '#374151' }} tickLine={false} />
              <YAxis
                tickFormatter={v => `${v.toFixed(0)}%`}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={{ stroke: '#374151' }}
                tickLine={false}
              />
              <ReferenceLine y={0} stroke="#374151" />
              <Tooltip
                formatter={(v) => [`+${Number(v ?? 0).toFixed(1)}%`, 'Return']}
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 6 }}
                labelStyle={{ color: '#9ca3af' }}
                itemStyle={{ color: '#e5e7eb' }}
              />
              <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                {data.filters.map((f, i) => (
                  <Cell key={i} fill={FILTER_COLORS[f.key]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Bet log */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-300">Bet Log — Half-Kelly &gt; 5%</h3>
              <p className="text-xs text-gray-500 mt-0.5">{bets.length} bets · showing {betPage * BET_PAGE_SIZE + 1}–{Math.min((betPage + 1) * BET_PAGE_SIZE, bets.length)}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setBetPage(p => Math.max(0, p - 1))}
                disabled={betPage === 0}
                className="px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded disabled:opacity-40 hover:bg-gray-700"
              >← Prev</button>
              <span className="text-xs text-gray-500 self-center">{betPage + 1} / {totalPages}</span>
              <button
                onClick={() => setBetPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={betPage === totalPages - 1}
                className="px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded disabled:opacity-40 hover:bg-gray-700"
              >Next →</button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800">
                  {['Date', 'League', 'Match', 'Side', 'Model', 'Market', 'Edge', 'Kelly', 'Stake', 'Result', 'Bankroll'].map(h => (
                    <th key={h} className={`py-2.5 px-3 text-gray-500 font-semibold uppercase tracking-wide text-left ${
                      ['Model','Market','Edge','Kelly','Stake','Result','Bankroll'].includes(h) ? 'text-right' : ''
                    }`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageBets.map((bet, i) => (
                  <tr key={i} className={`border-b border-gray-800/60 last:border-0 ${bet.won ? 'hover:bg-green-950/20' : 'hover:bg-red-950/20'}`}>
                    <td className="py-2 px-3 text-gray-400">{fmtDate(bet.date)}</td>
                    <td className="py-2 px-3">
                      <span className={`font-medium ${bet.league === 'LCK' ? 'text-blue-400' : bet.league === 'LEC' ? 'text-purple-400' : 'text-yellow-400'}`}>
                        {bet.league}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-gray-300">
                      <span className={bet.side === 'blue' && bet.won || bet.side === 'red' && !bet.blue_win ? 'text-white font-medium' : 'text-gray-400'}>
                        {bet.blue_team}
                      </span>
                      <span className="text-gray-600 mx-1">vs</span>
                      <span className={bet.side === 'red' && bet.won || bet.side === 'blue' && !bet.blue_win ? 'text-white font-medium' : 'text-gray-400'}>
                        {bet.red_team}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`font-medium ${bet.side === 'blue' ? 'text-blue-400' : 'text-red-400'}`}>
                        {bet.side === 'blue' ? bet.blue_team : bet.red_team}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-gray-300">
                      {(bet.side === 'blue' ? bet.model_p : 1 - bet.model_p) >= 0.5
                        ? <span className="text-green-400">{((bet.side === 'blue' ? bet.model_p : 1 - bet.model_p) * 100).toFixed(1)}%</span>
                        : <span className="text-red-400">{((bet.side === 'blue' ? bet.model_p : 1 - bet.model_p) * 100).toFixed(1)}%</span>
                      }
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-gray-400">
                      {((bet.side === 'blue' ? bet.market_q : 1 - bet.market_q) * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-blue-400">
                      +{(bet.prob_edge * 100).toFixed(1)}pp
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-gray-400">
                      {(bet.kelly_f * 100).toFixed(1)}%
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-gray-300">
                      {fmt$(bet.stake)}
                    </td>
                    <td className={`py-2 px-3 text-right font-mono font-semibold ${bet.won ? 'text-green-400' : 'text-red-400'}`}>
                      {bet.result >= 0 ? '+' : ''}{fmt$(bet.result)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-gray-300">
                      {fmt$(bet.bankroll)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-gray-600 pb-4">
          Simulated results only. OOS = out-of-sample playoff adjustments fitted on 2024/2025 data.
          Coaching adjustment (KC Reapered) excluded — fitted on 2026 data. Not financial advice.
        </p>
      </main>
    </div>
  )
}
