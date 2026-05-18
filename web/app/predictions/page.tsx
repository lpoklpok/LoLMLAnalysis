'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

interface Prediction {
  blue_team: string
  red_team: string
  league: string
  blue_elo: number
  red_elo: number
  elo_diff: number
  pred_blue_win: number
  pred_se: number
  best_of: number
  model_name: string
  date: string
}

/** Probability that blue side wins a BO series, assuming i.i.d. games. */
function seriesProb(p: number, bestOf: number): number {
  if (bestOf === 1) return p
  if (bestOf === 3) return p * p * (3 - 2 * p)
  if (bestOf === 5) return p * p * p * (10 - 15 * p + 6 * p * p)
  return p
}

function pct(n: number) { return Math.round(n * 100) }

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
  }) + ' UTC'
}

function ProbBar({ blueP, label }: { blueP: number; label: string }) {
  const b = pct(blueP)
  const r = 100 - b
  return (
    <div>
      <div className="flex text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <span className="ml-auto">{b}% · {r}%</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden bg-gray-700 flex">
        <div className="h-full bg-blue-500" style={{ width: `${b}%` }} />
        <div className="h-full bg-red-500"  style={{ width: `${r}%` }} />
      </div>
    </div>
  )
}

function MatchCard({ game }: { game: Prediction }) {
  const p       = game.pred_blue_win
  const sp      = seriesProb(p, game.best_of)
  const blueWin = p >= 0.5
  const sePct   = game.pred_se ? Math.round(game.pred_se * 100) : null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-500">{formatTime(game.date)}</span>
        <span className="text-xs font-mono text-yellow-400 bg-yellow-400/10 border border-yellow-400/20 px-2 py-0.5 rounded">
          BO{game.best_of}
        </span>
      </div>

      {/* Teams */}
      <div className="flex items-start gap-2 mb-4">
        <div className="flex-1 text-right">
          <p className={`font-semibold text-sm ${blueWin ? 'text-white' : 'text-gray-400'}`}>
            {game.blue_team}
          </p>
          <p className="text-xs text-blue-500 mt-0.5">Blue · {Math.round(game.blue_elo)}</p>
        </div>

        <span className="text-gray-600 text-xs mt-1 shrink-0">vs</span>

        <div className="flex-1">
          <p className={`font-semibold text-sm ${!blueWin ? 'text-white' : 'text-gray-400'}`}>
            {game.red_team}
          </p>
          <p className="text-xs text-red-500 mt-0.5">Red · {Math.round(game.red_elo)}</p>
        </div>
      </div>

      {/* Probability bars */}
      <div className="space-y-2">
        <ProbBar blueP={p}  label="Per game" />
        {game.best_of > 1 && (
          <ProbBar blueP={sp} label={`Series (BO${game.best_of})`} />
        )}
      </div>

      {/* Footer: SE + model */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-800">
        <span className="text-xs text-gray-600">
          {game.model_name ?? 'Logistic Regression'}
        </span>
        {sePct !== null && (
          <span className="text-xs text-gray-500">
            ±{sePct}% SE
          </span>
        )}
      </div>
    </div>
  )
}

export default function PredictionsPage() {
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [loading, setLoading]         = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data } = await supabase
        .from('upcoming_predictions')
        .select('*')
        .order('date', { ascending: true })
      setPredictions(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  // Group: league → date → games
  const leagues = ['LCK', 'LEC']
  const byLeagueDate = leagues.reduce<Record<string, Record<string, Prediction[]>>>(
    (acc, lg) => {
      const lgGames = predictions.filter(p => p.league === lg)
      acc[lg] = lgGames.reduce<Record<string, Prediction[]>>((inner, p) => {
        const key = formatDate(p.date)
        ;(inner[key] ??= []).push(p)
        return inner
      }, {})
      return acc
    }, {}
  )

  const LEAGUE_STYLE: Record<string, string> = {
    LCK: 'text-blue-400 border-blue-700',
    LEC: 'text-purple-400 border-purple-700',
  }

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
        <span className="text-sm text-green-400 font-medium">Predictions</span>
      </div>

      <main className="px-6 py-6 max-w-5xl mx-auto">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading predictions…</p>
        ) : (
          <div className="space-y-10">
            {leagues.map(lg => {
              const dateMap = byLeagueDate[lg]
              if (!dateMap || Object.keys(dateMap).length === 0) return null
              return (
                <section key={lg}>
                  <h2 className={`text-lg font-bold mb-4 pb-2 border-b ${LEAGUE_STYLE[lg]}`}>
                    {lg}
                  </h2>
                  <div className="space-y-6">
                    {Object.entries(dateMap).map(([date, games]) => (
                      <div key={date}>
                        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                          {date}
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                          {games.map((g, i) => <MatchCard key={i} game={g} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}

            {predictions.length === 0 && (
              <p className="text-gray-500 text-sm">No upcoming predictions available.</p>
            )}
          </div>
        )}

        <p className="mt-10 text-xs text-gray-600">
          Per-game probability from logistic regression trained on 2024–2025 LCK/LEC/LPL.
          Series probability assumes i.i.d. games at the same per-game rate.
          SE computed via the delta method on the logistic regression fit.
          Updated daily.
        </p>
      </main>
    </div>
  )
}
