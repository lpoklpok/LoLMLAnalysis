'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import RollingLogLossChart from './RollingLogLossChart'

type GameRow = {
  date: string
  league: string
  playoffs: number
  blue_win: number
  q_blue_win: number
}

function logLoss(y: number, p: number): number {
  const c = Math.max(1e-7, Math.min(1 - 1e-7, p))
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c))
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-3xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

export default function ModelPage() {
  const [games, setGames] = useState<GameRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.rpc('get_market_game_data').limit(10000).then(({ data, error }) => {
      if (error) { setError(error.message); setLoading(false); return }
      setGames(data as GameRow[])
      setLoading(false)
    })
  }, [])

  const marketLL = games.length > 0
    ? games.reduce((s, g) => s + logLoss(g.blue_win, g.q_blue_win), 0) / games.length
    : null

  const byLeague = ['LCK', 'LEC', 'LPL'].map(l => {
    const lg = games.filter(g => g.league === l)
    const ll = lg.length > 0
      ? lg.reduce((s, g) => s + logLoss(g.blue_win, g.q_blue_win), 0) / lg.length
      : null
    return { league: l, games: lg.length, ll }
  })

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-10">

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-4 mb-2">
            <a href="/" className="text-sm text-gray-500 hover:text-gray-300">← Dashboard</a>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Market Baseline</h1>
          <p className="text-gray-400 max-w-2xl text-sm leading-relaxed">
            Before building a model, we need to understand what we&apos;re trying to beat.
            The betting market aggregates sharp money from thousands of bettors and represents
            the best publicly available pre-game probability. Its log loss is our benchmark —
            any model we build needs to get below this number to have real predictive value.
          </p>
        </div>

        {/* Stat cards */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {[0,1,2].map(i => <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse h-24" />)}
          </div>
        ) : error ? (
          <p className="text-red-400 mb-8">Error loading data: {error}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <StatCard
              label="Games with Odds"
              value={games.length.toLocaleString()}
              sub="LCK / LEC / LPL — 2024 to 2026"
            />
            <StatCard
              label="Coin Flip Log Loss"
              value="0.6931"
              sub="Baseline — always predict 50%"
            />
            <StatCard
              label="Market Log Loss"
              value={marketLL != null ? marketLL.toFixed(4) : '—'}
              sub="Vig-free closing odds"
            />
          </div>
        )}

        {/* Rolling chart */}
        {!loading && !error && games.length > 0 && (
          <div className="mb-8">
            <RollingLogLossChart games={games} />
          </div>
        )}

        {/* Per-league breakdown */}
        {!loading && !error && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">League</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Games</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Market Log Loss</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">vs Coin Flip</th>
                </tr>
              </thead>
              <tbody>
                {byLeague.map(({ league, games: n, ll }) => (
                  <tr key={league} className="border-b border-gray-800 last:border-0">
                    <td className="px-5 py-3 font-medium text-white">{league}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{n.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{ll != null ? ll.toFixed(4) : '—'}</td>
                    <td className={`px-5 py-3 text-right font-medium ${ll != null && ll < 0.6931 ? 'text-green-400' : 'text-gray-400'}`}>
                      {ll != null ? (ll - 0.6931).toFixed(4) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
