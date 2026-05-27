'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'

type Side = 'blue' | 'red'
type Pos  = 'top' | 'jng' | 'mid' | 'bot' | 'sup'

// Untyped wide row — we just index into game[`blue_top_champion`] etc.
type Game = Record<string, unknown> & {
  gameid: string; date: string; league: string
  blue_team_teamname: string; red_team_teamname: string
  blue_team_result: number
}

const POSITIONS: Pos[] = ['top', 'jng', 'mid', 'bot', 'sup']
const POS_LABEL: Record<Pos, string> = { top: 'TOP', jng: 'JNG', mid: 'MID', bot: 'BOT', sup: 'SUP' }

function num(g: Game, key: string): number | null {
  const v = g[key]
  return (typeof v === 'number') ? v
       : (v == null || v === '') ? null
       : Number.isFinite(Number(v)) ? Number(v) : null
}
function str(g: Game, key: string): string | null {
  const v = g[key]
  return (typeof v === 'string' && v !== '') ? v : null
}
function fmtGameLength(secs: number | null): string {
  if (!secs) return '—'; const m = Math.floor(secs / 60); const s = secs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
function fmtPct(p: number | null, dec = 1): string {
  return p == null ? '—' : `${(p * 100).toFixed(dec)}%`
}
function fmtNum(v: number | null, dec = 0): string {
  return v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: dec, minimumFractionDigits: dec })
}
function fmtSigned(v: number | null, dec = 0): string {
  if (v == null) return '—'
  const s = v.toLocaleString('en-US', { maximumFractionDigits: dec, minimumFractionDigits: dec })
  return v > 0 ? `+${s}` : s
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
      <div className={`text-right font-mono text-sm ${blueLed ? 'text-blue-400 font-bold' : 'text-gray-300'}`}>{f(blue)}</div>
      <div className="text-center text-xs text-gray-500 px-3 min-w-[140px]">{label}</div>
      <div className={`text-left font-mono text-sm ${redLed ? 'text-red-400 font-bold' : 'text-gray-300'}`}>{f(red)}</div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">{title}</h2>
      {children}
    </div>
  )
}

function Draft({ game }: { game: Game }) {
  const firstPickFlag    = num(game, 'blue_team_firstPick')
  const blueOrderFirst   = firstPickFlag === 1
  const firstPickKnown   = firstPickFlag === 0 || firstPickFlag === 1
  const firstPickTeam    = blueOrderFirst ? str(game, 'blue_team_teamname') : str(game, 'red_team_teamname')
  const firstPickColor   = blueOrderFirst ? 'text-blue-300' : 'text-red-300'
  const renderSide = (side: Side, color: string) => (
    <div>
      <div className="grid grid-cols-[40px_1fr] gap-2 mb-3">
        <div className="text-xs text-gray-500 pt-1">Bans</div>
        <div className="flex flex-wrap gap-1.5">
          {[1,2,3,4,5].map(i => {
            const b = str(game, `${side}_team_ban${i}`)
            return b ? (
              <span key={i} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded line-through">{b}</span>
            ) : null
          })}
        </div>
      </div>
      <div className="grid grid-cols-[40px_1fr] gap-2">
        <div className="text-xs text-gray-500 pt-1">Picks</div>
        <div className="flex flex-wrap gap-1.5">
          {[1,2,3,4,5].map(i => {
            const p = str(game, `${side}_team_pick${i}`)
            return p ? (
              <span key={i} className={`text-xs px-2 py-0.5 rounded font-medium ${color}`}>
                {i}. {p}
              </span>
            ) : null
          })}
        </div>
      </div>
    </div>
  )
  return (
    <Panel title="Draft">
      {firstPickKnown && (
        <p className="text-xs text-gray-500 mb-4">
          First pick: <span className={`${firstPickColor} font-semibold`}>{firstPickTeam}</span>
        </p>
      )}
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-xs text-blue-300 font-semibold mb-2 flex items-center gap-2">
            {str(game, 'blue_team_teamname')}
            {blueOrderFirst && <span className="text-[10px] bg-blue-900/70 text-blue-200 px-1.5 py-0.5 rounded">1st pick</span>}
          </h3>
          {renderSide('blue', 'bg-blue-900/40 text-blue-200')}
        </div>
        <div>
          <h3 className="text-xs text-red-300 font-semibold mb-2 flex items-center gap-2">
            {str(game, 'red_team_teamname')}
            {firstPickKnown && !blueOrderFirst && <span className="text-[10px] bg-red-900/70 text-red-200 px-1.5 py-0.5 rounded">1st pick</span>}
          </h3>
          {renderSide('red', 'bg-red-900/40 text-red-200')}
        </div>
      </div>
    </Panel>
  )
}

function AtTimeTable({ game, stat, label, fmt = fmtNum }: {
  game: Game; stat: string; label: string; fmt?: (v: number | null, d?: number) => string
}) {
  const TIMES = [10, 15, 20, 25]
  return (
    <div className="mb-4">
      <h4 className="text-xs text-gray-500 mb-1">{label}</h4>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-gray-600">
            <th className="text-left w-32"></th>
            {TIMES.map(t => <th key={t} className="text-right pr-3">@{t}</th>)}
          </tr>
        </thead>
        <tbody>
          {(['blue', 'red'] as Side[]).map(side => (
            <tr key={side}>
              <td className={`py-0.5 ${side === 'blue' ? 'text-blue-300' : 'text-red-300'}`}>{str(game, `${side}_team_teamname`)?.slice(0, 18)}</td>
              {TIMES.map(t => {
                const b = num(game, `blue_team_${stat}${t}`)
                const r = num(game, `red_team_${stat}${t}`)
                const v = side === 'blue' ? b : r
                const leading = b != null && r != null && (side === 'blue' ? b > r : r > b)
                return (
                  <td key={t} className={`text-right pr-3 ${leading ? 'text-gray-100 font-semibold' : 'text-gray-400'}`}>
                    {fmt(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PerPosGoldDiff({ game }: { game: Game }) {
  const TIMES = [10, 15, 20, 25]
  return (
    <table className="w-full text-xs font-mono">
      <thead>
        <tr className="text-gray-600 border-b border-gray-800">
          <th className="text-left pb-1 w-20">Lane</th>
          <th className="text-left pb-1">Matchup</th>
          {TIMES.map(t => <th key={t} className="text-right pr-3 pb-1">GD@{t}</th>)}
        </tr>
      </thead>
      <tbody>
        {POSITIONS.map(pos => {
          const bPlayer = str(game, `blue_${pos}_playername`)
          const rPlayer = str(game, `red_${pos}_playername`)
          const bChamp  = str(game, `blue_${pos}_champion`)
          const rChamp  = str(game, `red_${pos}_champion`)
          return (
            <tr key={pos} className="border-b border-gray-800/40">
              <td className="py-1 text-gray-500">{POS_LABEL[pos]}</td>
              <td className="py-1 text-gray-300">
                <span className="text-blue-400">{bPlayer ?? '—'}</span>
                <span className="text-gray-600 italic ml-1">{bChamp ?? ''}</span>
                <span className="text-gray-600 mx-2">vs</span>
                <span className="text-red-400">{rPlayer ?? '—'}</span>
                <span className="text-gray-600 italic ml-1">{rChamp ?? ''}</span>
              </td>
              {TIMES.map(t => {
                // gold diff is blue-perspective in OE — show from blue side
                const v = num(game, `blue_${pos}_golddiffat${t}`)
                const color = v == null ? 'text-gray-600'
                            : v > 0 ? 'text-blue-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
                return <td key={t} className={`text-right pr-3 py-1 ${color}`}>{fmtSigned(v)}</td>
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
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
      setError('Missing query parameters (d, b, r)'); setLoading(false); return
    }
    const isoDay = date.slice(0, 10)
    const filter = `and(date.gte.${isoDay}T00:00:00,date.lt.${isoDay}T23:59:59)`
    supabase.from('games').select('*').or(filter).then(({ data, error }) => {
      if (error) { setError(error.message); setLoading(false); return }
      // Match the EXACT game by full timestamp + teams. A series can have G1/G2/G3
      // with the same blue/red sides on the same day, so date-only match returns
      // the wrong game (always the first).
      const exact = (data ?? []).find(g =>
        g.date === date && g.blue_team_teamname === blue && g.red_team_teamname === red
      ) as Game | undefined
      // Fallback: if exact timestamp doesn't match (e.g. minor format diff), use
      // first matching pair (old behavior — but warn in console)
      const fallback = (data ?? []).find(g =>
        g.blue_team_teamname === blue && g.red_team_teamname === red
      ) as Game | undefined
      const chosen = exact ?? fallback
      if (!exact && fallback) console.warn(`Exact timestamp ${date} not matched; using first ${blue} vs ${red} of day`)
      if (!chosen) setError(`No matching game in 'games' table for ${blue} vs ${red} on ${isoDay}`)
      else setGame(chosen)
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

  const blueWon  = num(game, 'blue_team_result') === 1
  const d        = new Date(game.date)
  const qBlue    = num(game, 'q_blue_win')
  const hasDraft = !!str(game, 'blue_team_pick1') || !!str(game, 'blue_team_ban1')

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
          {game.league}{str(game, 'split') && <span> · {str(game, 'split')}</span>}
          {num(game, 'playoffs') ? <span className="text-yellow-400 ml-1">· Playoffs</span> : null}
          <span> · Patch {str(game, 'patch') ?? '—'}</span>
          <span> · Game {num(game, 'game') ?? '?'}</span>
          <span> · {d.toLocaleString()}</span>
          <span> · {fmtGameLength(num(game, 'gamelength'))}</span>
        </p>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {qBlue != null && (
          <Panel title="Pre-game market">
            <div className="flex rounded overflow-hidden h-7 text-sm font-semibold">
              <div className="flex items-center justify-end pr-2 bg-blue-600" style={{ width: `${qBlue * 100}%` }}>
                <span className="text-white text-xs">{fmtPct(qBlue)}</span>
              </div>
              <div className="flex items-center justify-start pl-2 bg-red-600" style={{ width: `${(1 - qBlue) * 100}%` }}>
                <span className="text-white text-xs">{fmtPct(1 - qBlue)}</span>
              </div>
            </div>
          </Panel>
        )}

        {hasDraft && <Draft game={game} />}

        <Panel title="Per-lane gold diff (blue perspective)">
          <PerPosGoldDiff game={game} />
        </Panel>

        <Panel title="Team stats — outcomes">
          <StatRow label="Kills"       blue={num(game, 'blue_team_kills')}   red={num(game, 'red_team_kills')}   />
          <StatRow label="Dragons"     blue={num(game, 'blue_team_dragons')} red={num(game, 'red_team_dragons')} />
          <StatRow label="Barons"      blue={num(game, 'blue_team_barons')}  red={num(game, 'red_team_barons')}  />
          <StatRow label="Towers"      blue={num(game, 'blue_team_towers')}  red={num(game, 'red_team_towers')}  />
          <StatRow label="First Blood" blue={num(game, 'blue_team_firstblood') ?? 0} red={(num(game, 'blue_team_firstblood') ?? 0) === 1 ? 0 : 1} fmt={v => v ? '✓' : '—'} />
          <StatRow label="First Dragon"  blue={num(game, 'blue_team_firstdragon')} red={num(game, 'red_team_firstdragon')} fmt={v => v === 1 ? '✓' : v === 0 ? '—' : '—'} />
          <StatRow label="First Herald"  blue={num(game, 'blue_team_firstherald')} red={num(game, 'red_team_firstherald')} fmt={v => v === 1 ? '✓' : v === 0 ? '—' : '—'} />
          <StatRow label="First Baron"   blue={num(game, 'blue_team_firstbaron')}  red={num(game, 'red_team_firstbaron')}  fmt={v => v === 1 ? '✓' : v === 0 ? '—' : '—'} />
          <StatRow label="First Tower"   blue={num(game, 'blue_team_firsttower')}  red={num(game, 'red_team_firsttower')}  fmt={v => v === 1 ? '✓' : v === 0 ? '—' : '—'} />
        </Panel>

        <Panel title="Team stats — totals">
          <StatRow label="Total gold"       blue={num(game, 'blue_team_totalgold')}          red={num(game, 'red_team_totalgold')}          fmt={v => fmtNum(v, 0)} />
          <StatRow label="Earned gold"      blue={num(game, 'blue_team_earnedgold')}         red={num(game, 'red_team_earnedgold')}         fmt={v => fmtNum(v, 0)} />
          <StatRow label="Damage to champs" blue={num(game, 'blue_team_damagetochampions')}  red={num(game, 'red_team_damagetochampions')}  fmt={v => fmtNum(v, 0)} />
          <StatRow label="Minion kills"     blue={num(game, 'blue_team_minionkills')}        red={num(game, 'red_team_minionkills')}        />
          <StatRow label="Monster kills"    blue={num(game, 'blue_team_monsterkills')}       red={num(game, 'red_team_monsterkills')}       />
          <StatRow label="Vision score"     blue={num(game, 'blue_team_visionscore')}        red={num(game, 'red_team_visionscore')}        />
          <StatRow label="Wards placed"     blue={num(game, 'blue_team_wardsplaced')}        red={num(game, 'red_team_wardsplaced')}        />
          <StatRow label="Wards killed"     blue={num(game, 'blue_team_wardskilled')}        red={num(game, 'red_team_wardskilled')}        />
          <StatRow label="Control wards"    blue={num(game, 'blue_team_controlwardsbought')} red={num(game, 'red_team_controlwardsbought')} />
        </Panel>

        <Panel title="Team @ time benchmarks">
          <AtTimeTable game={game} stat="gold"     label="Gold"      fmt={v => fmtNum(v, 0)} />
          <AtTimeTable game={game} stat="golddiff" label="Gold diff" fmt={v => fmtSigned(v)} />
          <AtTimeTable game={game} stat="xp"       label="XP"        fmt={v => fmtNum(v, 0)} />
          <AtTimeTable game={game} stat="cs"       label="CS"        fmt={v => fmtNum(v, 0)} />
          <AtTimeTable game={game} stat="kills"    label="Kills"     />
          <AtTimeTable game={game} stat="assists"  label="Assists"   />
          <AtTimeTable game={game} stat="deaths"   label="Deaths"    />
        </Panel>

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
