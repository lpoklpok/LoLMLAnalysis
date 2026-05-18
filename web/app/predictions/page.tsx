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
  date: string
}

const LEAGUE_COLORS: Record<string, string> = {
  LCK: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  LEC: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC'
}

function ProbBar({ prob }: { prob: number }) {
  const bluePct  = Math.round(prob * 100)
  const redPct   = 100 - bluePct

  return (
    <div className="w-full">
      <div className="flex text-xs font-semibold mb-1">
        <span className="text-blue-400">{bluePct}%</span>
        <span className="ml-auto text-red-400">{redPct}%</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-gray-700 flex">
        <div
          className="h-full bg-blue-500 transition-all"
          style={{ width: `${bluePct}%` }}
        />
        <div
          className="h-full bg-red-500 transition-all"
          style={{ width: `${redPct}%` }}
        />
      </div>
    </div>
  )
}

function MatchCard({ game }: { game: Prediction }) {
  const blueWin = game.pred_blue_win >= 0.5
  const leagueClass = LEAGUE_COLORS[game.league] ?? 'text-gray-400 bg-gray-400/10 border-gray-400/20'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-500">{formatTime(game.date)}</span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded border ${leagueClass}`}>
          {game.league}
        </span>
      </div>

      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 text-right">
          <p className={`font-semibold text-sm truncate ${blueWin ? 'text-white' : 'text-gray-400'}`}>
            {game.blue_team}
          </p>
          <p className="text-xs text-gray-500">Blue side · {Math.round(game.blue_elo)} ELO</p>
        </div>

        <span className="text-gray-600 text-xs font-mono shrink-0">vs</span>

        <div className="flex-1">
          <p className={`font-semibold text-sm truncate ${!blueWin ? 'text-white' : 'text-gray-400'}`}>
            {game.red_team}
          </p>
          <p className="text-xs text-gray-500">Red side · {Math.round(game.red_elo)} ELO</p>
        </div>
      </div>

      <ProbBar prob={game.pred_blue_win} />
    </div>
  )
}

export default function PredictionsPage() {
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [loading, setLoading]         = useState(true)
  const [league, setLeague]           = useState<'All' | 'LCK' | 'LEC'>('All')

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

  const filtered = league === 'All' ? predictions : predictions.filter(p => p.league === league)

  // Group by UTC date string
  const byDate = filtered.reduce<Record<string, Prediction[]>>((acc, p) => {
    const key = formatDate(p.date)
    ;(acc[key] ??= []).push(p)
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">LCK · LEC · LCS · LPL · 2024–2026</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-4 flex-wrap items-center">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
        <Link href="/players" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Player Lookup</Link>
        <Link href="/model" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        <span className="text-sm text-blue-400 font-medium">Predictions</span>

        <div className="ml-auto flex gap-2">
          {(['All', 'LCK', 'LEC'] as const).map(l => (
            <button
              key={l}
              onClick={() => setLeague(l)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                league === l
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <main className="px-6 py-6 max-w-4xl mx-auto">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading predictions…</p>
        ) : filtered.length === 0 ? (
          <p className="text-gray-500 text-sm">No upcoming predictions available.</p>
        ) : (
          <div className="space-y-8">
            {Object.entries(byDate).map(([date, games]) => (
              <section key={date}>
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">{date}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {games.map((g, i) => <MatchCard key={i} game={g} />)}
                </div>
              </section>
            ))}
          </div>
        )}

        <p className="mt-10 text-xs text-gray-600">
          Predictions generated by logistic regression trained on 2024–2025 LCK/LEC/LPL.
          Blue-side win probability shown. Updated daily.
        </p>
      </main>
    </div>
  )
}
