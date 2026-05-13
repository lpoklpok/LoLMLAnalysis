'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

interface PlayerStat {
  champion: string
  pos: string
  picks: number
  wins: number
  league: string
  year: number
}

interface SearchResult {
  playername: string
  games: number
}

export default function PlayersPage() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchResult[]>([])
  const [selectedPlayer, setSelectedPlayer] = useState('')
  const [stats, setStats] = useState<PlayerStat[]>([])
  const [loading, setLoading] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (query.length < 2) {
      setSuggestions([])
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const { data } = await supabase.rpc('search_players', { p_query: query })
      setSuggestions(data ?? [])
      setShowSuggestions(true)
    }, 250)
  }, [query])

  async function loadPlayer(name: string) {
    setSelectedPlayer(name)
    setQuery(name)
    setShowSuggestions(false)
    setLoading(true)
    const { data } = await supabase.rpc('get_player_stats', { p_playername: name })
    setStats(data ?? [])
    setLoading(false)
  }

  // Aggregate champion stats across leagues/years
  const champAgg = Object.values(
    stats.reduce<Record<string, { champion: string; position: string; picks: number; wins: number }>>(
      (acc, row) => {
        const key = row.champion
        if (!acc[key]) acc[key] = { champion: row.champion, position: row.pos, picks: 0, wins: 0 }
        acc[key].picks += row.picks
        acc[key].wins += Number(row.wins)
        return acc
      },
      {}
    )
  ).sort((a, b) => b.picks - a.picks)

  const totalGames = champAgg.reduce((s, c) => s + c.picks, 0) / 2 // each game appears twice (blue+red counted once)
  const totalWins = champAgg.reduce((s, c) => s + c.wins, 0) / 2
  const overallWR = totalGames > 0 ? ((totalWins / totalGames) * 100).toFixed(1) : '—'

  // Unique leagues played
  const leagues = [...new Set(stats.map((r) => r.league))].sort()
  const years = [...new Set(stats.map((r) => r.year))].sort().reverse()

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">← Back</Link>
        <h1 className="text-2xl font-bold text-blue-400">Player Lookup</h1>
      </header>

      <main className="px-6 py-6 max-w-4xl">
        {/* Search */}
        <div className="relative mb-8 max-w-md">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="Search player name…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden z-10 shadow-xl">
              {suggestions.map((s) => (
                <button
                  key={s.playername}
                  onClick={() => loadPlayer(s.playername)}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-700 transition-colors flex justify-between items-center"
                >
                  <span className="text-white">{s.playername}</span>
                  <span className="text-xs text-gray-400">{s.games} games</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Player summary */}
        {selectedPlayer && !loading && stats.length > 0 && (
          <>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">{selectedPlayer}</h2>
              <p className="text-sm text-gray-400 mt-1">
                {leagues.join(' · ')} &nbsp;·&nbsp; {years.join(', ')}
              </p>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4 mb-8">
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide">Total Games</p>
                <p className="text-3xl font-bold text-white mt-1">{Math.round(totalGames)}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide">Win Rate</p>
                <p className="text-3xl font-bold text-white mt-1">{overallWR}%</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide">Champions Played</p>
                <p className="text-3xl font-bold text-white mt-1">{champAgg.length}</p>
              </div>
            </div>

            {/* Champion table */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">Champion History</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 uppercase border-b border-gray-800">
                      <th className="text-left py-2 pr-4">#</th>
                      <th className="text-left py-2 pr-4">Champion</th>
                      <th className="text-left py-2 pr-4">Position</th>
                      <th className="text-right py-2 pr-4">Games</th>
                      <th className="text-right py-2">Win Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {champAgg.map((c, i) => {
                      const wr = c.picks > 0 ? (c.wins / c.picks) * 100 : 0
                      return (
                        <tr key={c.champion} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                          <td className="py-2 pr-4 text-gray-500">{i + 1}</td>
                          <td className="py-2 pr-4 font-medium text-white">{c.champion}</td>
                          <td className="py-2 pr-4 text-gray-400 capitalize">{c.position ?? ''}</td>
                          <td className="py-2 pr-4 text-right text-gray-300">{c.picks}</td>
                          <td className="py-2 text-right">
                            <span className={`font-medium ${wr >= 55 ? 'text-green-400' : wr <= 45 ? 'text-red-400' : 'text-gray-300'}`}>
                              {wr.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {loading && (
          <div className="space-y-3 max-w-2xl">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-800 rounded animate-pulse" />
            ))}
          </div>
        )}

        {selectedPlayer && !loading && stats.length === 0 && (
          <p className="text-gray-400">No data found for &quot;{selectedPlayer}&quot;</p>
        )}
      </main>
    </div>
  )
}
