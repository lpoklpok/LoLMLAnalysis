'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from 'recharts'

interface Game {
  date: string
  league: string
  blue_team: string
  red_team: string
  blue_win: number
  q_blue_win: number | null
  model_pred: number | null
  game_in_series: number | null
  series_type: string | null
}

interface ChartPoint {
  ts: number
  diff: number
  won: boolean
  date: string
  opponent: string
  model_pct: number
  market_pct: number
  is_blue: boolean
  league: string
  series_type: string | null
  game_in_series: number | null
}

const TIME_FRAMES = ['1M', '3M', '6M', '1Y', 'All']

function cutoff(frame: string): number {
  const now = Date.now()
  const D = 86_400_000
  if (frame === '1M') return now - 30 * D
  if (frame === '3M') return now - 90 * D
  if (frame === '6M') return now - 180 * D
  if (frame === '1Y') return now - 365 * D
  return 0
}

function fmtTs(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartPoint }[] }) {
  if (!active || !payload?.length) return null
  const pt = payload[0].payload
  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs shadow-xl" style={{ minWidth: 180 }}>
      <div className="font-semibold text-gray-200 mb-1">
        {new Date(pt.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' })}
        {' · '}{pt.league}
        {pt.series_type ? ` · ${pt.series_type} G${pt.game_in_series ?? '?'}` : ''}
      </div>
      <div className="text-gray-400 mb-2">
        vs <span className="text-gray-200">{pt.opponent}</span>{' '}
        <span className="text-gray-600">({pt.is_blue ? 'Blue' : 'Red'} side)</span>
      </div>
      <div className="space-y-0.5">
        <div className="flex justify-between gap-8">
          <span className="text-gray-500">Model</span>
          <span className="text-gray-200">{(pt.model_pct * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between gap-8">
          <span className="text-gray-500">Market</span>
          <span className="text-gray-200">{(pt.market_pct * 100).toFixed(1)}%</span>
        </div>
        <div className="flex justify-between gap-8 border-t border-gray-700 pt-1 mt-1">
          <span className="text-gray-500">Model − Market</span>
          <span className={pt.diff >= 0 ? 'text-blue-400 font-semibold' : 'text-red-400 font-semibold'}>
            {pt.diff >= 0 ? '+' : ''}{(pt.diff * 100).toFixed(1)}pp
          </span>
        </div>
      </div>
      <div className={`mt-2 font-bold ${pt.won ? 'text-green-400' : 'text-red-400'}`}>
        {pt.won ? 'WIN' : 'LOSS'}
      </div>
    </div>
  )
}

export default function ChartPage() {
  const [games, setGames]               = useState<Game[]>([])
  const [loading, setLoading]           = useState(true)
  const [selectedTeam, setSelectedTeam] = useState('')
  const [timeFrame, setTimeFrame]       = useState('6M')

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('game_features')
        .select('date,league,blue_team,red_team,blue_win,q_blue_win,model_pred,game_in_series,series_type')
        .order('date', { ascending: true })
      setGames(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  const teams = useMemo(() => {
    const s = new Set<string>()
    for (const g of games) { s.add(g.blue_team); s.add(g.red_team) }
    return [...s].sort()
  }, [games])

  // Pick a default team once loaded
  useEffect(() => {
    if (!selectedTeam && teams.length) setSelectedTeam(teams[0])
  }, [teams, selectedTeam])

  const chartData = useMemo<ChartPoint[]>(() => {
    if (!selectedTeam) return []
    const floor = cutoff(timeFrame)
    const pts: ChartPoint[] = []
    for (const g of games) {
      if (g.q_blue_win == null || g.model_pred == null) continue
      const ts = new Date(g.date).getTime()
      if (ts < floor) continue
      const isBlue = g.blue_team === selectedTeam
      const isRed  = g.red_team  === selectedTeam
      if (!isBlue && !isRed) continue
      const model_pct  = isBlue ? g.model_pred  : 1 - g.model_pred
      const market_pct = isBlue ? g.q_blue_win  : 1 - g.q_blue_win
      pts.push({
        ts,
        diff:  model_pct - market_pct,
        won:   isBlue ? g.blue_win === 1 : g.blue_win === 0,
        date:  g.date,
        opponent: isBlue ? g.red_team : g.blue_team,
        model_pct,
        market_pct,
        is_blue: isBlue,
        league: g.league,
        series_type:    g.series_type,
        game_in_series: g.game_in_series,
      })
    }
    return pts
  }, [games, selectedTeam, timeFrame])

  const summary = useMemo(() => {
    if (!chartData.length) return null
    const modelMore = chartData.filter(p => p.diff > 0.05)
    const mktMore   = chartData.filter(p => p.diff < -0.05)
    const wr = (arr: ChartPoint[]) => arr.length ? arr.filter(p => p.won).length / arr.length : null
    return {
      modelMore: modelMore.length, modelMoreWR: wr(modelMore),
      mktMore:   mktMore.length,   mktMoreWR:   wr(mktMore),
      total: chartData.length,
      totalWR: chartData.filter(p => p.won).length / chartData.length,
    }
  }, [chartData])

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
        <span className="text-sm text-purple-400 font-medium">Model vs Market</span>
      </div>

      {/* Controls */}
      <div className="px-6 py-3 border-b border-gray-800 flex gap-4 flex-wrap items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-400">Team</label>
          <select
            value={selectedTeam}
            onChange={e => setSelectedTeam(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-purple-500"
          >
            {teams.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>

        <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
          {TIME_FRAMES.map(f => (
            <button
              key={f}
              onClick={() => setTimeFrame(f)}
              className={`px-3 py-1.5 ${timeFrame === f
                ? 'bg-purple-600 text-white font-semibold'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
            >
              {f}
            </button>
          ))}
        </div>

        <span className="text-xs text-gray-500">
          {loading ? 'Loading…' : `${chartData.length} games with odds`}
        </span>
      </div>

      <main className="px-6 py-6">
        {loading ? (
          <p className="text-gray-500 text-sm mt-8">Loading…</p>
        ) : chartData.length === 0 ? (
          <p className="text-gray-500 text-sm mt-8">No games with market odds in this time frame.</p>
        ) : (
          <>
            {/* Summary cards */}
            {summary && (
              <div className="flex gap-4 mb-6 flex-wrap">
                {[
                  {
                    label: 'Model > Market (>5pp)',
                    count: summary.modelMore,
                    wr: summary.modelMoreWR,
                    color: 'text-blue-400',
                  },
                  {
                    label: 'Market > Model (>5pp)',
                    count: summary.mktMore,
                    wr: summary.mktMoreWR,
                    color: 'text-red-400',
                  },
                  {
                    label: 'Total games',
                    count: summary.total,
                    wr: summary.totalWR,
                    color: 'text-gray-200',
                  },
                ].map(card => (
                  <div key={card.label} className="bg-gray-900 rounded px-4 py-3 border border-gray-800 text-sm">
                    <div className="text-gray-500 text-xs mb-1">{card.label}</div>
                    <div className={`font-semibold ${card.color}`}>{card.count} games</div>
                    {card.wr != null && (
                      <div className="text-xs text-gray-400">
                        Win rate: <span className={card.wr >= 0.5 ? 'text-green-400' : 'text-red-400'}>
                          {(card.wr * 100).toFixed(0)}%
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <ResponsiveContainer width="100%" height={440}>
              <ScatterChart margin={{ top: 10, right: 30, bottom: 30, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={fmtTs}
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  tickCount={8}
                  axisLine={{ stroke: '#374151' }}
                  tickLine={false}
                  name="Date"
                />
                <YAxis
                  dataKey="diff"
                  tickFormatter={v => `${(v * 100).toFixed(0)}pp`}
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#374151' }}
                  tickLine={false}
                  label={{
                    value: 'Model − Market',
                    angle: -90,
                    position: 'insideLeft',
                    fill: '#6b7280',
                    fontSize: 11,
                    dx: -4,
                  }}
                  name="Diff"
                />
                <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1.5} />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ strokeDasharray: '3 3', stroke: '#4b5563' }}
                />
                <Scatter data={chartData} isAnimationActive={false}>
                  {chartData.map((pt, i) => (
                    <Cell
                      key={i}
                      fill={pt.won ? '#4ade80' : '#f87171'}
                      fillOpacity={0.8}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>

            <p className="text-xs text-gray-600 mt-2">
              <span className="text-green-400">Green</span> = win ·{' '}
              <span className="text-red-400">Red</span> = loss.
              Y-axis shows model win probability minus market win probability for {selectedTeam}.
              Positive = model was more bullish than market.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
