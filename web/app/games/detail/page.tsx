'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'

interface Game {
  gameid:    string
  date:      string
  league:    string
  split:     string | null
  patch:     string | null
  playoffs:  number
  game:      number
  gamelength: number | null

  blue_team_teamname: string
  red_team_teamname:  string
  blue_team_result:   number

  blue_top_champion: string | null; blue_top_playername: string | null
  blue_jng_champion: string | null; blue_jng_playername: string | null
  blue_mid_champion: string | null; blue_mid_playername: string | null
  blue_bot_champion: string | null; blue_bot_playername: string | null
  blue_sup_champion: string | null; blue_sup_playername: string | null
  red_top_champion:  string | null; red_top_playername:  string | null
  red_jng_champion:  string | null; red_jng_playername:  string | null
  red_mid_champion:  string | null; red_mid_playername:  string | null
  red_bot_champion:  string | null; red_bot_playername:  string | null
  red_sup_champion:  string | null; red_sup_playername:  string | null

  blue_team_kills:   number | null; red_team_kills:   number | null
  blue_team_dragons: number | null; red_team_dragons: number | null
  blue_team_barons:  number | null; red_team_barons:  number | null
  blue_team_towers:  number | null; red_team_towers:  number | null
  blue_team_firstblood: number | null
  blue_team_golddiffat15: number | null

  q_blue_win: number | null
}

const POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup'] as const
const POS_LABEL: Record<string, string> = { top: 'TOP', jng: 'JNG', mid: 'MID', bot: 'BOT', sup: 'SUP' }

function fmtGameLength(secs: number | null): string {
  if (!secs) return '—'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function fmtPct(p: number | null, dec = 1): string {
  return p == null ? '—' : `${(p * 100).toFixed(dec)}%`
}

function StatRow({ label, blue, red, fmt }: {
  label: string; blue: number | null; red: number | null
  fmt?: (v: number | null) => string
}) {
  const f = fmt ?? ((v: number | null) => v == null ? '—' : String(v))
  const blueLed = blue != null && red != null && blue > red
  const redLed  = blue != null && red != null && red > blue
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center py-1.5 border-b border-gray-800/40">
      <div className={`text-right font-mono text-sm ${blueLed ? 'text-blue-400 font-bold' : 'text-gray-300'}`}>
        {f(blue)}
      </div>
      <div className="text-center text-xs text-gray-500 px-3 min-w-[120px]">{label}</div>
      <div className={`text-left font-mono text-sm ${redLed ? 'text-red-400 font-bold' : 'text-gray-300'}`}>
        {f(red)}
      </div>
    </div>
  )
}

function GameDetail() {
  const sp = useSearchParams()
  const date = sp.get('d')
  const blue = sp.get('b')
  const red  = sp.get('r')

  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!date || !blue || !red) {
      setError('Missing query parameters (d, b, r)')
      setLoading(false)
      return
    }
    // Match games table by date + teams. Try BOTH orientations because the same
    // physical match exists as one row only (whichever was blue side).
    const isoDay = date.slice(0, 10)
    const filter = `and(date.gte.${isoDay}T00:00:00,date.lt.${isoDay}T23:59:59)`
    supabase.from('games').select('*').or(filter).then(({ data, error }) => {
      if (error) { setError(error.message); setLoading(false); return }
      const exact = (data ?? []).find(g =>
        g.blue_team_teamname === blue && g.red_team_teamname === red
      )
      if (!exact) {
        setError(`No matching game in 'games' table for ${blue} vs ${red} on ${isoDay}`)
      } else {
        setGame(exact as Game)
      }
      setLoading(false)
    })
  }, [date, blue, red])

  if (loading) return <p className="text-gray-400 p-8">Loading…</p>
  if (error || !game) return (
    <div className="p-8">
      <Link href="/games" className="text-blue-400 hover:text-blue-300 text-sm">← Back to games explorer</Link>
      <p className="text-red-400 mt-4">{error ?? 'Game not found'}</p>
    </div>
  )

  const blueWon = game.blue_team_result === 1
  const d = new Date(game.date)

  return (
    <>
      <header className="border-b border-gray-800 px-6 py-4">
        <Link href="/games" className="text-gray-500 hover:text-gray-300 text-xs">← Back to games explorer</Link>
        <div className="flex items-baseline gap-3 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold">
            <span className="text-blue-400">{game.blue_team_teamname}</span>
            <span className="text-gray-500 mx-3">vs</span>
            <span className="text-red-400">{game.red_team_teamname}</span>
          </h1>
          <span className={`text-sm font-semibold ${blueWon ? 'text-blue-400' : 'text-red-400'}`}>
            {blueWon ? `${game.blue_team_teamname} won` : `${game.red_team_teamname} won`}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {game.league}
          {game.split && <span> · {game.split}</span>}
          {game.playoffs ? <span className="text-yellow-400 ml-1">· Playoffs</span> : null}
          <span> · Patch {game.patch ?? '—'}</span>
          <span> · Game {game.game}</span>
          <span> · {d.toLocaleString()}</span>
          <span> · {fmtGameLength(game.gamelength)}</span>
        </p>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {game.q_blue_win != null && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Pre-game market</h2>
            <div className="flex rounded overflow-hidden h-7 text-sm font-semibold">
              <div className="flex items-center justify-end pr-2 bg-blue-600" style={{ width: `${game.q_blue_win * 100}%` }}>
                <span className="text-white text-xs">{fmtPct(game.q_blue_win)}</span>
              </div>
              <div className="flex items-center justify-start pl-2 bg-red-600" style={{ width: `${(1 - game.q_blue_win) * 100}%` }}>
                <span className="text-white text-xs">{fmtPct(1 - game.q_blue_win)}</span>
              </div>
            </div>
          </div>
        )}

        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-300 mb-4">Lineup</h2>
          <div className="grid grid-cols-[1fr_auto_1fr] gap-x-4 gap-y-2 items-center">
            <div className="text-right text-xs text-blue-300 font-semibold">{game.blue_team_teamname}</div>
            <div className="text-center text-xs text-gray-500 font-mono w-12"></div>
            <div className="text-left text-xs text-red-300 font-semibold">{game.red_team_teamname}</div>

            {POSITIONS.map(pos => {
              const bChamp  = (game as unknown as Record<string, string | null>)[`blue_${pos}_champion`]
              const bPlayer = (game as unknown as Record<string, string | null>)[`blue_${pos}_playername`]
              const rChamp  = (game as unknown as Record<string, string | null>)[`red_${pos}_champion`]
              const rPlayer = (game as unknown as Record<string, string | null>)[`red_${pos}_playername`]
              return (
                <div key={pos} className="contents">
                  <div className="text-right">
                    <span className="text-gray-200 font-medium">{bPlayer ?? '—'}</span>{' '}
                    <span className="text-gray-500 text-xs italic">{bChamp ?? ''}</span>
                  </div>
                  <div className="text-center text-xs font-mono text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
                    {POS_LABEL[pos]}
                  </div>
                  <div className="text-left">
                    <span className="text-gray-200 font-medium">{rPlayer ?? '—'}</span>{' '}
                    <span className="text-gray-500 text-xs italic">{rChamp ?? ''}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Game stats</h2>
          <StatRow label="Kills"        blue={game.blue_team_kills}   red={game.red_team_kills}   />
          <StatRow label="Dragons"      blue={game.blue_team_dragons} red={game.red_team_dragons} />
          <StatRow label="Barons"       blue={game.blue_team_barons}  red={game.red_team_barons}  />
          <StatRow label="Towers"       blue={game.blue_team_towers}  red={game.red_team_towers}  />
          <StatRow label="First Blood"  blue={game.blue_team_firstblood ?? 0} red={(game.blue_team_firstblood ?? 0) === 1 ? 0 : 1}
                   fmt={v => v ? '✓' : '—'} />
          {game.blue_team_golddiffat15 != null && (
            <StatRow label="Gold @ 15 (diff)" blue={game.blue_team_golddiffat15} red={-game.blue_team_golddiffat15}
                     fmt={v => v == null ? '—' : (v > 0 ? '+' : '') + v.toLocaleString()} />
          )}
        </div>

        <p className="text-xs text-gray-600 text-center">
          gameid: <code className="text-gray-500">{game.gameid}</code>
        </p>
      </div>
    </>
  )
}

export default function GameDetailPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Suspense fallback={<p className="text-gray-400 p-8">Loading…</p>}>
        <GameDetail />
      </Suspense>
    </div>
  )
}
