'use client'

import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, Legend,
  ReferenceLine, ReferenceArea, ResponsiveContainer,
} from 'recharts'

type RawGame = {
  date: string
  league: string
  playoffs: number
  blue_win: number
  q_blue_win: number
}

type DataPoint = {
  date: number
  rolling_ll: number
}

const LEAGUE_COLORS: Record<string, string> = {
  LCK: '#ef4444',
  LEC: '#3b82f6',
  LPL: '#f59e0b',
}

const WINDOW = 30

function logLoss(y: number, p: number): number {
  const clipped = Math.max(1e-7, Math.min(1 - 1e-7, p))
  return -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped))
}

function rollingPoints(games: RawGame[]): DataPoint[] {
  return games.map((g, i) => {
    const slice = games.slice(Math.max(0, i - WINDOW + 1), i + 1)
    const avg = slice.reduce((s, gm) => s + logLoss(gm.blue_win, gm.q_blue_win), 0) / slice.length
    return { date: new Date(g.date).getTime(), rolling_ll: parseFloat(avg.toFixed(4)) }
  })
}

function getPlayoffRanges(games: RawGame[]): [number, number][] {
  const ranges: [number, number][] = []
  let start: number | null = null
  for (const g of games) {
    const t = new Date(g.date).getTime()
    if (g.playoffs === 1 && start === null) start = t
    else if (g.playoffs === 0 && start !== null) { ranges.push([start, t]); start = null }
  }
  if (start !== null) ranges.push([start, new Date(games[games.length - 1].date).getTime()])
  return ranges
}

export default function RollingLogLossChart({ games }: { games: RawGame[] }) {
  const leagues = ['LCK', 'LEC', 'LPL'] as const

  const seriesData = Object.fromEntries(
    leagues.map(l => [
      l,
      rollingPoints(games.filter(g => g.league === l)),
    ])
  )

  // Playoff ranges across all leagues combined (for shading)
  const allPlayoffRanges = getPlayoffRanges([...games].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  ))

  const allDates = games.map(g => new Date(g.date).getTime())
  const domainMin = Math.min(...allDates)
  const domainMax = Math.max(...allDates)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-1">
        Market Odds — Rolling {WINDOW}-Game Log Loss by League
      </h2>
      <p className="text-xs text-gray-500 mb-4">Lower is better. Shaded = playoffs. Reference line = coin flip (0.6931)</p>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <XAxis
            dataKey="date"
            type="number"
            scale="time"
            domain={[domainMin, domainMax]}
            tickFormatter={v => new Date(v).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0.55, 0.72]}
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
            labelFormatter={v => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            formatter={(v: number) => [v.toFixed(4), 'Log Loss']}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af' }} />
          <ReferenceLine y={0.6931} stroke="#6b7280" strokeDasharray="4 4" label={{ value: 'Coin Flip', fill: '#6b7280', fontSize: 11 }} />

          {allPlayoffRanges.map(([x1, x2], i) => (
            <ReferenceArea key={i} x1={x1} x2={x2} fill="#374151" fillOpacity={0.35} />
          ))}

          {leagues.map(l => (
            <Line
              key={l}
              data={seriesData[l]}
              dataKey="rolling_ll"
              name={l}
              type="monotone"
              stroke={LEAGUE_COLORS[l]}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
