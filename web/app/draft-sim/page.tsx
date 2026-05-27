'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

// ===== Types =====
type Side = 'blue' | 'red'
type Role = 'top' | 'jng' | 'mid' | 'bot' | 'sup'
const ROLES: Role[] = ['top', 'jng', 'mid', 'bot', 'sup']
const ROLE_LABEL: Record<Role, string> = { top: 'Top', jng: 'Jungle', mid: 'Mid', bot: 'ADC', sup: 'Support' }

interface Team       { team: string; league: string | null; last: string | null }
interface Roster     { player: string; n: number; last: string }
interface ChampPool  { champ: string; n: number; w: number }
interface PlayerList { player: string; n: number; w: number; last: string | null }

interface DraftLookups {
  generated:        string
  window_days:      number
  n_games:          number
  teams:            Team[]
  rosters:          Record<string, Record<Role, Roster[]>>
  players_by_role:  Record<Role, PlayerList[]>
  champ_pool:       Record<string, ChampPool[]>            // f"{player}|{role}"
  player_champ_wr:  Record<string, [number, number]>       // f"{player}|{role}|{champ}" -> [n,w]
  champ_role_wr:    Record<string, [number, number]>       // f"{role}|{champ}" -> [n,w]
  champ_matchup_wr: Record<string, [number, number]>       // f"{role}|{champA}|{champB}"
  player_h2h_wr:    Record<string, [number, number]>       // f"{role}|{playerA}|{playerB}"
}

interface Slot { player: string | null; champ: string | null }
type SideState = { team: string | null; slots: Record<Role, Slot> }

// ===== Helpers =====
const wr = (nw: [number, number] | undefined): number | null =>
  nw && nw[0] > 0 ? nw[1] / nw[0] : null

const fmtPct = (p: number | null, n?: number): string =>
  p == null ? '—' : `${(p * 100).toFixed(0)}%${n != null ? ` (n=${n})` : ''}`

const conf = (n: number): string => n >= 20 ? 'text-zinc-50' : n >= 5 ? 'text-zinc-300' : 'text-zinc-500 italic'

function emptySide(): SideState {
  return {
    team: null,
    slots: { top: { player: null, champ: null }, jng: { player: null, champ: null },
             mid: { player: null, champ: null }, bot: { player: null, champ: null },
             sup: { player: null, champ: null } },
  }
}

// ===== Page =====
export default function DraftSimPage() {
  const [data, setData]   = useState<DraftLookups | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blue, setBlue]   = useState<SideState>(emptySide())
  const [red,  setRed]    = useState<SideState>(emptySide())

  useEffect(() => {
    fetch('/draft_lookups.json')
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [])

  // ----- Champion universe (sorted by overall popularity) -----
  const champUniverse = useMemo<Record<Role, string[]>>(() => {
    if (!data) return { top: [], jng: [], mid: [], bot: [], sup: [] }
    const out: Record<Role, [string, number][]> = { top: [], jng: [], mid: [], bot: [], sup: [] }
    for (const k of Object.keys(data.champ_role_wr)) {
      const [role, champ] = k.split('|') as [Role, string]
      if (ROLES.includes(role)) out[role].push([champ, data.champ_role_wr[k][0]])
    }
    return ROLES.reduce((acc, r) => {
      acc[r] = out[r].sort((a, b) => b[1] - a[1]).map(x => x[0])
      return acc
    }, {} as Record<Role, string[]>)
  }, [data])

  // ----- Team list sorted by league + recency -----
  const teamOptions = useMemo<Team[]>(() => {
    if (!data) return []
    return [...data.teams].sort((a, b) => {
      if (a.last && b.last) return b.last.localeCompare(a.last)
      return (a.team || '').localeCompare(b.team || '')
    })
  }, [data])

  // ----- Autofill roster on team change -----
  function pickTeam(side: Side, team: string | null) {
    const setter = side === 'blue' ? setBlue : setRed
    setter(prev => {
      if (!team || !data) return { ...prev, team }
      const r = data.rosters[team] ?? {} as Record<Role, Roster[]>
      const slots = { ...prev.slots }
      for (const role of ROLES) {
        const candidates = r[role] ?? []
        slots[role] = { ...slots[role], player: candidates[0]?.player ?? null }
      }
      return { team, slots }
    })
  }

  function updateSlot(side: Side, role: Role, patch: Partial<Slot>) {
    const setter = side === 'blue' ? setBlue : setRed
    setter(prev => ({ ...prev, slots: { ...prev.slots, [role]: { ...prev.slots[role], ...patch } } }))
  }

  // ----- Per-slot derived stats -----
  function slotStats(side: Side, role: Role) {
    if (!data) return null
    const own = side === 'blue' ? blue : red
    const opp = side === 'blue' ? red  : blue
    const s   = own.slots[role]
    const oS  = opp.slots[role]
    if (!s.player && !s.champ) return null

    const player_champ = s.player && s.champ ? data.player_champ_wr[`${s.player}|${role}|${s.champ}`] : undefined
    const champ_role   = s.champ ? data.champ_role_wr[`${role}|${s.champ}`] : undefined
    // Aggregate "player overall in role" by summing all entries in their champ_pool
    let player_overall: [number, number] | undefined
    if (s.player) {
      const pool = data.champ_pool[`${s.player}|${role}`] ?? []
      const n = pool.reduce((a, x) => a + x.n, 0)
      const w = pool.reduce((a, x) => a + x.w, 0)
      if (n > 0) player_overall = [n, w]
    }
    const champ_matchup = s.champ && oS?.champ ? data.champ_matchup_wr[`${role}|${s.champ}|${oS.champ}`] : undefined
    const player_h2h    = s.player && oS?.player ? data.player_h2h_wr[`${role}|${s.player}|${oS.player}`] : undefined

    return { player_champ, champ_role, player_overall, champ_matchup, player_h2h }
  }

  // ----- Player's top champs (suggestions) -----
  function topChampsFor(player: string | null, role: Role): ChampPool[] {
    if (!player || !data) return []
    return (data.champ_pool[`${player}|${role}`] ?? []).slice(0, 12)
  }

  // ----- Aggregate prediction (delta-based) -----
  const aggregate = useMemo(() => {
    if (!data) return null
    let blueLogit = 0
    let denom = 0
    let weightedLanes = 0
    const breakdown: { role: Role; delta: number; basis: string }[] = []

    for (const role of ROLES) {
      const bs = blue.slots[role]
      const rs = red.slots[role]
      // Player-on-champ vs player-overall: champion suitability
      const bPC = bs.player && bs.champ ? data.player_champ_wr[`${bs.player}|${role}|${bs.champ}`] : undefined
      const rPC = rs.player && rs.champ ? data.player_champ_wr[`${rs.player}|${role}|${rs.champ}`] : undefined
      const bPool = bs.player ? data.champ_pool[`${bs.player}|${role}`] ?? [] : []
      const rPool = rs.player ? data.champ_pool[`${rs.player}|${role}`] ?? [] : []
      const bPlayerN = bPool.reduce((a, x) => a + x.n, 0)
      const bPlayerW = bPool.reduce((a, x) => a + x.w, 0)
      const rPlayerN = rPool.reduce((a, x) => a + x.n, 0)
      const rPlayerW = rPool.reduce((a, x) => a + x.w, 0)
      const bWR = bPC && bPC[0] >= 5 ? bPC[1] / bPC[0] : (bPlayerN > 0 ? bPlayerW / bPlayerN : null)
      const rWR = rPC && rPC[0] >= 5 ? rPC[1] / rPC[0] : (rPlayerN > 0 ? rPlayerW / rPlayerN : null)
      if (bWR == null || rWR == null) continue
      // Symmetric logit diff
      const lb = Math.log(Math.max(0.02, bWR) / Math.max(0.02, 1 - bWR))
      const lr = Math.log(Math.max(0.02, rWR) / Math.max(0.02, 1 - rWR))
      const delta = (lb - lr) / 2
      blueLogit += delta
      denom += 1
      weightedLanes += 1
      breakdown.push({ role, delta, basis: bPC && bPC[0] >= 5 ? 'player-on-champ' : 'player-overall' })
    }

    if (denom === 0) return null
    const p = 1 / (1 + Math.exp(-blueLogit))
    return { p, breakdown, lanes: weightedLanes }
  }, [blue, red, data])

  if (error) return <div className="p-8 text-red-400">Failed to load lookups: {error}</div>
  if (!data) return <div className="p-8 text-zinc-400">Loading draft lookups…</div>

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-8">
      <header className="max-w-7xl mx-auto mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Draft Simulator</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Pick teams, players, and champions to see win rates and matchups.
            Data: last {data.window_days}d · {data.n_games.toLocaleString()} games · updated {new Date(data.generated).toLocaleDateString()}.
          </p>
        </div>
        <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-100">← back</Link>
      </header>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
        <SidePanel
          side="blue" state={blue} oppState={red} data={data}
          teamOptions={teamOptions} champUniverse={champUniverse}
          onTeam={t => pickTeam('blue', t)}
          onSlot={(role, patch) => updateSlot('blue', role, patch)}
          slotStats={role => slotStats('blue', role)}
          topChampsFor={topChampsFor}
        />
        <SidePanel
          side="red" state={red} oppState={blue} data={data}
          teamOptions={teamOptions} champUniverse={champUniverse}
          onTeam={t => pickTeam('red', t)}
          onSlot={(role, patch) => updateSlot('red', role, patch)}
          slotStats={role => slotStats('red', role)}
          topChampsFor={topChampsFor}
        />
      </div>

      {aggregate && (
        <div className="max-w-7xl mx-auto mt-6 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <div className="flex items-baseline gap-4 mb-3">
            <div className="text-xs uppercase tracking-wide text-zinc-400">Aggregate (champion-only)</div>
            <div className="text-xs text-zinc-500">
              Sum of per-lane logit deltas. Uses player-on-champ when n≥5, else player overall.
              Lanes counted: {aggregate.lanes}/5
            </div>
          </div>
          <div className="flex items-baseline gap-6">
            <div>
              <div className="text-3xl font-mono font-semibold">
                <span className="text-blue-400">{(aggregate.p * 100).toFixed(0)}%</span>
                <span className="text-zinc-500 mx-2">·</span>
                <span className="text-red-400">{((1 - aggregate.p) * 100).toFixed(0)}%</span>
              </div>
              <div className="text-xs text-zinc-500 mt-1">blue · red</div>
            </div>
            <div className="flex-1 text-xs text-zinc-400 grid grid-cols-5 gap-2">
              {aggregate.breakdown.map(b => (
                <div key={b.role} className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1">
                  <div className="text-zinc-500">{ROLE_LABEL[b.role]}</div>
                  <div className={b.delta > 0 ? 'text-blue-400' : b.delta < 0 ? 'text-red-400' : 'text-zinc-300'}>
                    {b.delta >= 0 ? '+' : ''}{b.delta.toFixed(2)}
                  </div>
                  <div className="text-zinc-600 text-[10px]">{b.basis}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== Subcomponents =====

interface SidePanelProps {
  side:           Side
  state:          SideState
  oppState:       SideState
  data:           DraftLookups
  teamOptions:    Team[]
  champUniverse:  Record<Role, string[]>
  onTeam:         (t: string | null) => void
  onSlot:         (role: Role, patch: Partial<Slot>) => void
  slotStats:      (role: Role) => ReturnType<typeof slotStatsType> | null
  topChampsFor:   (player: string | null, role: Role) => ChampPool[]
}

// helper just for typing
function slotStatsType(): {
  player_champ?:   [number, number]
  champ_role?:     [number, number]
  player_overall?: [number, number]
  champ_matchup?:  [number, number]
  player_h2h?:     [number, number]
} { return {} }

function SidePanel(p: SidePanelProps) {
  const ringClass  = p.side === 'blue' ? 'border-blue-900/60' : 'border-red-900/60'
  const labelClass = p.side === 'blue' ? 'text-blue-400'     : 'text-red-400'
  return (
    <section className={`rounded-lg bg-zinc-900 border ${ringClass} p-5`}>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className={`text-lg font-semibold ${labelClass}`}>{p.side.toUpperCase()}</h2>
        <select
          className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm min-w-[14rem]"
          value={p.state.team ?? ''}
          onChange={e => p.onTeam(e.target.value || null)}
        >
          <option value="">— pick team —</option>
          {p.teamOptions.map(t => (
            <option key={t.team} value={t.team}>
              {t.team}{t.league ? ` · ${t.league}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        {ROLES.map(role => (
          <RoleRow
            key={role}
            side={p.side} role={role}
            slot={p.state.slots[role]}
            data={p.data}
            playerOptions={p.data.players_by_role[role] ?? []}
            rosterForTeam={p.state.team ? (p.data.rosters[p.state.team]?.[role] ?? []) : []}
            topChamps={p.topChampsFor(p.state.slots[role].player, role)}
            allChamps={p.champUniverse[role]}
            stats={p.slotStats(role)}
            onChange={patch => p.onSlot(role, patch)}
          />
        ))}
      </div>
    </section>
  )
}

interface RoleRowProps {
  side:           Side
  role:           Role
  slot:           Slot
  data:           DraftLookups
  playerOptions:  PlayerList[]
  rosterForTeam:  Roster[]
  topChamps:      ChampPool[]
  allChamps:      string[]
  stats:          ReturnType<typeof slotStatsType> | null
  onChange:       (patch: Partial<Slot>) => void
}

function RoleRow(p: RoleRowProps) {
  // Player options: roster first, then full pool (limit to keep dropdown sane)
  const rosterNames = new Set(p.rosterForTeam.map(r => r.player))
  const playerList: { player: string; n: number; tag?: string }[] = [
    ...p.rosterForTeam.map(r => ({ player: r.player, n: r.n, tag: 'roster' })),
    ...p.playerOptions.filter(o => !rosterNames.has(o.player)).slice(0, 200).map(o => ({ player: o.player, n: o.n })),
  ]
  const champList: { champ: string; n: number; tag?: string }[] = [
    ...p.topChamps.map(c => ({ champ: c.champ, n: c.n, tag: 'pool' })),
    ...p.allChamps.filter(c => !p.topChamps.find(t => t.champ === c)).map(c => ({ champ: c, n: 0 })),
  ]

  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2 py-1">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{ROLE_LABEL[p.role]}</div>
      <select
        className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm min-w-0"
        value={p.slot.player ?? ''}
        onChange={e => p.onChange({ player: e.target.value || null, champ: null })}
      >
        <option value="">— player —</option>
        {playerList.map(o => (
          <option key={o.player} value={o.player}>
            {o.player}{o.tag === 'roster' ? ' ★' : ''}{o.n > 0 ? ` (${o.n})` : ''}
          </option>
        ))}
      </select>
      <select
        className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm min-w-0"
        value={p.slot.champ ?? ''}
        onChange={e => p.onChange({ champ: e.target.value || null })}
      >
        <option value="">— champion —</option>
        {champList.map(c => (
          <option key={c.champ} value={c.champ}>
            {c.champ}{c.tag === 'pool' ? ' ★' : ''}{c.n > 0 ? ` (${c.n})` : ''}
          </option>
        ))}
      </select>
      <StatChips stats={p.stats} />
    </div>
  )
}

function StatChips({ stats }: { stats: ReturnType<typeof slotStatsType> | null }) {
  if (!stats) return <div className="text-xs text-zinc-600">—</div>
  return (
    <div className="flex flex-wrap gap-1 text-[11px]">
      <Chip label="player+champ"  nw={stats.player_champ}   tone="emerald" />
      <Chip label="player overall" nw={stats.player_overall} tone="zinc" />
      <Chip label="champ in role" nw={stats.champ_role}     tone="zinc" />
      <Chip label="matchup champ" nw={stats.champ_matchup}  tone="amber" />
      <Chip label="vs opponent"   nw={stats.player_h2h}     tone="amber" />
    </div>
  )
}

function Chip({ label, nw, tone }: { label: string; nw?: [number, number]; tone: 'emerald' | 'amber' | 'zinc' }) {
  const p = wr(nw)
  const n = nw?.[0] ?? 0
  const toneCls =
    tone === 'emerald' ? 'border-emerald-800/60 bg-emerald-950/40' :
    tone === 'amber'   ? 'border-amber-800/60   bg-amber-950/40'   :
                         'border-zinc-800/60    bg-zinc-950'
  const valCls =
    p == null     ? 'text-zinc-600' :
    n  < 5        ? 'text-zinc-500 italic' :
    p >= 0.55     ? 'text-emerald-400' :
    p <= 0.45     ? 'text-rose-400' :
                    'text-zinc-200'
  return (
    <span className={`px-2 py-0.5 rounded border ${toneCls} flex items-center gap-1`}>
      <span className="text-zinc-500">{label}</span>
      <span className={`font-mono ${valCls}`}>
        {p == null ? '—' : `${(p * 100).toFixed(0)}%`}
        {n > 0 && <span className="text-zinc-600"> · n={n}</span>}
      </span>
    </span>
  )
}
