'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

const POSITIONS = ['All', 'top', 'jng', 'mid', 'bot', 'sup']
const POS_LABEL: Record<string, string> = {
  All: 'All', top: 'Top', jng: 'Jungle', mid: 'Mid', bot: 'Bot', sup: 'Support'
}
const LEAGUES = ['All', 'LCK', 'LEC', 'LCS', 'LPL']

interface PlayerRow {
  player: string
  elo: number
  team: string
  league: string
  pos: string
  last_year: number | null
  last_split: string | null
}

interface RecentGame {
  game_date: string
  game_league: string
  game_year: number
  game_playoffs: number
  blue_team: string
  red_team: string
  blue_win: number
  player_side: string
  player_champion: string
  model_pred: number | null
}

export default function RankingsPage() {
  const [position, setPosition] = useState('All')
  const [league, setLeague] = useState('All')
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [games, setGames] = useState<RecentGame[]>([])
  const [gamesLoading, setGamesLoading] = useState(false)

  const loadPlayers = useCallback(async () => {
    setLoading(true)
    setExpanded(null)
    const { data } = await supabase.rpc('get_player_rankings', {
      p_position: position === 'All' ? null : position,
      p_league:   league   === 'All' ? null : league,
    })
    setPlayers(data ?? [])
    setLoading(false)
  }, [position, league])

  useEffect(() => { loadPlayers() }, [loadPlayers])

  async function togglePlayer(player: string) {
    if (expanded === player) {
      setExpanded(null)
      return
    }
    setExpanded(player)
    setGames([])
    setGamesLoading(true)
    const { data } = await supabase.rpc('get_player_games', {
      p_player: player,
      p_limit: 15,
    })
    setGames(data ?? [])
    setGamesLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/" className="text-gray-400 hover:text-white text-sm transition-colors">← Back</Link>
        <h1 className="text-2xl font-bold text-blue-400">Player ELO Rankings</h1>
        <span className="text-sm text-gray-500 ml-auto">
          {loading ? 'Loading…' : `${players.length} players`}
        </span>
      </header>

      {/* Filters */}
      <div className="px-6 py-4 border-b border-gray-800 flex flex-wrap gap-4 items-center">
        {/* Position tabs */}
        <div className="flex gap-1 bg-gray-900 rounded-lg p-1">
          {POSITIONS.map(p => (
            <button
              key={p}
              onClick={() => setPosition(p)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
                position === p
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {POS_LABEL[p]}
            </button>
          ))}
        </div>

        {/* League select */}
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-400">League</label>
          <select
            value={league}
            onChange={e => setLeague(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            {LEAGUES.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
      </div>

      {/* Table */}
      <main className="px-6 py-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          {loading ? (
            <div className="space-y-px">
              {[...Array(20)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-800/50 animate-pulse" style={{ opacity: 1 - i * 0.04 }} />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 uppercase border-b border-gray-800 bg-gray-900/80">
                  <th className="text-right py-3 px-3 w-12">#</th>
                  <th className="text-left py-3 px-3">Player</th>
                  <th className="text-left py-3 px-3">Team</th>
                  <th className="text-left py-3 px-3">League</th>
                  <th className="text-left py-3 px-3">Position</th>
                  <th className="text-right py-3 px-4">ELO</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => (
                  <>
                    <tr
                      key={p.player}
                      onClick={() => togglePlayer(p.player)}
                      className={`border-b border-gray-800/50 cursor-pointer transition-colors ${
                        expanded === p.player
                          ? 'bg-blue-950/40 border-blue-800/50'
                          : 'hover:bg-gray-800/40'
                      }`}
                    >
                      <td className="py-3 px-3 text-right text-gray-500">{i + 1}</td>
                      <td className="py-3 px-3">
                        <span className="font-semibold text-white">{p.player}</span>
                      </td>
                      <td className="py-3 px-3 text-gray-300">{p.team}</td>
                      <td className="py-3 px-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${leagueBadge(p.league)}`}>
                          {p.league}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-gray-400 capitalize">{POS_LABEL[p.pos] ?? p.pos}</td>
                      <td className="py-3 px-4 text-right">
                        <EloBar elo={p.elo} />
                      </td>
                    </tr>
                    {expanded === p.player && (
                      <tr key={`${p.player}-expanded`} className="bg-gray-950 border-b border-blue-800/30">
                        <td colSpan={6} className="px-6 py-4">
                          <RecentGames
                            player={p.player}
                            games={games}
                            loading={gamesLoading}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  )
}

function EloBar({ elo }: { elo: number }) {
  const color =
    elo >= 1800 ? 'text-yellow-400' :
    elo >= 1700 ? 'text-blue-400' :
    elo >= 1600 ? 'text-green-400' :
    elo >= 1500 ? 'text-gray-300' :
    'text-gray-500'

  return (
    <span className={`font-mono font-bold ${color}`}>
      {Math.round(elo)}
    </span>
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

function RecentGames({
  player, games, loading,
}: {
  player: string
  games: RecentGame[]
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="space-y-1">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-8 bg-gray-800 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  if (!games.length) {
    return <p className="text-gray-500 text-sm">No recent games found.</p>
  }

  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-3 font-medium">
        Recent games — {player}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 uppercase">
            <th className="text-left pb-2 pr-4">Date</th>
            <th className="text-left pb-2 pr-4">League</th>
            <th className="text-left pb-2 pr-4">Opponent</th>
            <th className="text-left pb-2 pr-4">Side</th>
            <th className="text-left pb-2 pr-4">Champion</th>
            <th className="text-left pb-2 pr-4">Model</th>
            <th className="text-left pb-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g, i) => {
            const playerOnBlue = g.player_side === 'blue'
            const won = playerOnBlue ? g.blue_win === 1 : g.blue_win === 0
            const opponent = playerOnBlue ? g.red_team : g.blue_team
            const modelForPlayer = g.model_pred != null
              ? (playerOnBlue ? g.model_pred : 1 - g.model_pred)
              : null

            return (
              <tr key={i} className="border-t border-gray-800/50">
                <td className="py-1.5 pr-4 text-gray-400">
                  {new Date(g.game_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
                <td className="py-1.5 pr-4 text-gray-400">{g.game_league}{g.game_playoffs ? ' PO' : ''}</td>
                <td className="py-1.5 pr-4 text-gray-200">{opponent}</td>
                <td className={`py-1.5 pr-4 font-medium ${playerOnBlue ? 'text-blue-400' : 'text-red-400'}`}>
                  {playerOnBlue ? 'Blue' : 'Red'}
                </td>
                <td className="py-1.5 pr-4 text-gray-300">{g.player_champion ?? '—'}</td>
                <td className="py-1.5 pr-4 text-gray-400">
                  {modelForPlayer != null ? `${(modelForPlayer * 100).toFixed(0)}%` : '—'}
                </td>
                <td className={`py-1.5 font-bold ${won ? 'text-green-400' : 'text-red-400'}`}>
                  {won ? 'W' : 'L'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
