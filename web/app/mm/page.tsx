// force-rebuild 1779670684.7190762
'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'

// ── Types ────────────────────────────────────────────────────────────────

interface MmConfig {
  id: number
  condition_id: string
  market_type: string
  outcome_index: number
  side: 'bid' | 'offer' | 'both'
  event_slug: string | null
  event_title: string | null
  team1: string | null
  team2: string | null
  outcome_label: string | null
  asset_id: string | null
  bid_enabled: boolean
  offer_enabled: boolean
  strategy: 'join_best' | 'penny_back'
  quote_size_usd: number
  quote_size_shares: number | null
  max_size_pct: number
  max_fill_usd: number
  max_position_shares: number
  min_spread_cents: number
  min_level_size_usd: number
  order_ttl_sec: number
}

interface MmState {
  condition_id: string
  outcome_index: number
  side: string
  active_order_id: string | null
  active_price: number | null
  active_size_shares: number | null
  fills_today_usd: number
  position_shares: number
  last_book_top_price: number | null
  last_book_top_size: number | null
  paused_reason: string | null
  updated_at: string
}

interface KillSwitch { id: number; killed: boolean; reason: string | null; updated_at: string }

interface QuoteLogRow {
  id: number; ts: string; condition_id: string; outcome_index: number; side: string
  action: string; price: number | null; size_shares: number | null; reason: string | null; dry_run: boolean
}

// ── Group helper ──────────────────────────────────────────────────────────

interface EventGroup {
  event_slug: string
  event_title: string
  team1: string
  team2: string
  // Map keyed by market_type. Each market_type has TWO configs (outcome 0 + 1)
  // — the team-picker switches which outcome the toggles operate on.
  bySubmarket: Map<string, { outcome0: MmConfig | null; outcome1: MmConfig | null }>
}

// Order submarket types nicely
const SUBMARKET_ORDER = ['match_winner', 'game_1_winner', 'game_2_winner', 'game_3_winner',
                          'game_4_winner', 'game_5_winner', 'game_handicap']
function subOrder(s: string): number {
  const i = SUBMARKET_ORDER.indexOf(s)
  return i < 0 ? 999 : i
}

// Parse the YYYY-MM-DD that Polymarket bakes into event slugs, e.g.
// "lol-ly-tl2-2026-05-24" → 2026-05-24. Returns Infinity for events without
// a parseable date (futures like "lol-lck-2026-season-winner" — note the
// year-only — so we put them at the end of the chronological sort).
function eventTs(slug: string): number {
  const m = slug.match(/-(\d{4})-(\d{2})-(\d{2})(?:\b|$|-)/)
  if (!m) return Number.POSITIVE_INFINITY
  return Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
}

// ── Page ──────────────────────────────────────────────────────────────────

// Short, distinct two-tone "ka-ching" generated via WebAudio so there's no
// audio file to host. Triggered when a new `fill` row arrives via realtime.
let _audioCtx: AudioContext | null = null
function playFillPing() {
  if (typeof window === 'undefined') return
  try {
    type WinAC = Window & {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const w = window as WinAC
    const Ctor = w.AudioContext || w.webkitAudioContext
    if (!Ctor) return
    if (!_audioCtx) _audioCtx = new Ctor()
    const ctx = _audioCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const blip = (freq: number, t0: number, dur = 0.12, gain = 0.18) => {
      const osc = ctx.createOscillator()
      const g   = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + t0)
      g.gain.setValueAtTime(0, now + t0)
      g.gain.linearRampToValueAtTime(gain, now + t0 + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur)
      osc.connect(g).connect(ctx.destination)
      osc.start(now + t0)
      osc.stop(now + t0 + dur + 0.02)
    }
    blip(880, 0)       // C-ish
    blip(1318, 0.08)   // higher follow-up
  } catch { /* autoplay blocked etc — ignore */ }
}

export default function MmPage() {
  const [configs, setConfigs] = useState<MmConfig[]>([])
  const [states,  setStates]  = useState<Record<string, MmState>>({})
  const [kill,    setKill]    = useState<KillSwitch | null>(null)
  const [logs,    setLogs]    = useState<QuoteLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search,  setSearch]  = useState('')
  const [filter,  setFilter]  = useState<'all' | 'active'>('active')

  // Per-event anchor team — local UI state, defaults to team1 (outcome 0).
  // Stored in localStorage so the choice persists between sessions.
  const [anchorTeam, setAnchorTeam] = useState<Record<string, 0 | 1>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('mm_anchor') || '{}') } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('mm_anchor', JSON.stringify(anchorTeam)) } catch {}
  }, [anchorTeam])

  // Pinned events — stay in the Active tab even when all sides are toggled off.
  const [pinned, setPinned] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try { return new Set(JSON.parse(localStorage.getItem('mm_pinned') || '[]')) } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('mm_pinned', JSON.stringify([...pinned])) } catch {}
  }, [pinned])
  const togglePin = (slug: string) =>
    setPinned(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug); else next.add(slug)
      return next
    })

  const stateKey = (c: { condition_id: string; outcome_index: number; side: string }) =>
    `${c.condition_id}|${c.outcome_index}|${c.side}`

  const refresh = useCallback(async () => {
    const [cfg, st, ks, lg] = await Promise.all([
      supabase.from('mm_config').select('*'),
      supabase.from('mm_state').select('*'),
      supabase.from('mm_kill_switch').select('*').eq('id', 1).single(),
      supabase.from('mm_quotes_log').select('*').order('ts', { ascending: false }).limit(40),
    ])
    setConfigs((cfg.data ?? []) as MmConfig[])
    const sMap: Record<string, MmState> = {}
    for (const s of (st.data ?? []) as MmState[]) sMap[stateKey(s)] = s
    setStates(sMap)
    setKill(ks.data as KillSwitch | null)
    setLogs((lg.data ?? []) as QuoteLogRow[])
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    // Realtime: prepend new mm_quotes_log rows the instant the worker
    // writes them (instead of waiting up to 5s for the next poll).
    const ch = supabase
      .channel('mm-quotes-log')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mm_quotes_log' },
        (p) => {
          const row = p.new as QuoteLogRow
          setLogs(prev => [row, ...prev].slice(0, 40))
          if (row.action === 'fill') playFillPing()
        })
      // mm_state changes (live book top, active quote, fills, pause reason)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'mm_state' },
        (p) => {
          const row = (p.new ?? p.old) as MmState
          if (!row) return
          const key = `${row.condition_id}|${row.outcome_index}|${row.side}`
          setStates(prev => ({ ...prev, [key]: row }))
        })
      .subscribe()
    // Safety-net poll at 15s for configs (realtime covers those too,
    // but a slow heartbeat catches any dropped subscriptions).
    const id = setInterval(refresh, 15_000)
    return () => { clearInterval(id); supabase.removeChannel(ch) }
  }, [refresh])

  // Group configs by event_slug
  const groups = useMemo<EventGroup[]>(() => {
    const m = new Map<string, EventGroup>()
    for (const c of configs) {
      const slug = c.event_slug ?? c.condition_id
      if (!m.has(slug)) {
        m.set(slug, {
          event_slug: slug, event_title: c.event_title ?? '',
          team1: c.team1 ?? '', team2: c.team2 ?? '',
          bySubmarket: new Map(),
        })
      }
      const g = m.get(slug)!
      const row = g.bySubmarket.get(c.market_type) ?? { outcome0: null, outcome1: null }
      if (c.outcome_index === 0) row.outcome0 = c
      else if (c.outcome_index === 1) row.outcome1 = c
      g.bySubmarket.set(c.market_type, row)
    }
    return Array.from(m.values())
  }, [configs])

  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase()
    return groups.filter(g => {
      if (filter === 'active') {
        const anyOn = [...g.bySubmarket.values()].some(r =>
          r.outcome0?.bid_enabled || r.outcome0?.offer_enabled
          || r.outcome1?.bid_enabled || r.outcome1?.offer_enabled
        )
        if (!anyOn && !pinned.has(g.event_slug)) return false
      }
      if (q && !`${g.event_title} ${g.team1} ${g.team2}`.toLowerCase().includes(q)) return false
      return true
    }).sort((a, b) => {
      // 1. Active or pinned first
      const aAny = [...a.bySubmarket.values()].some(r => r.outcome0?.bid_enabled || r.outcome0?.offer_enabled || r.outcome1?.bid_enabled || r.outcome1?.offer_enabled)
      const bAny = [...b.bySubmarket.values()].some(r => r.outcome0?.bid_enabled || r.outcome0?.offer_enabled || r.outcome1?.bid_enabled || r.outcome1?.offer_enabled)
      const aActive = aAny || pinned.has(a.event_slug)
      const bActive = bAny || pinned.has(b.event_slug)
      if (aActive !== bActive) return aActive ? -1 : 1
      // 2. Upcoming (today / future) ABOVE past
      const now = Date.now()
      const da = eventTs(a.event_slug), db = eventTs(b.event_slug)
      const aFuture = da >= now - 86400000
      const bFuture = db >= now - 86400000
      if (aFuture !== bFuture) return aFuture ? -1 : 1
      // 3. Soonest-first if both upcoming; most-recent first if both past
      if (aFuture) {
        if (da !== db) return da - db
      } else {
        if (da !== db) return db - da
      }
      return a.event_title.localeCompare(b.event_title)
    })
  }, [groups, search, filter])

  async function flipKill() {
    if (!kill) return
    const newKilled = !kill.killed
    const reason = newKilled ? (prompt('Reason for emergency stop?', 'manual stop') || 'manual stop') : null
    await supabase.from('mm_kill_switch').update({ killed: newKilled, reason, updated_at: new Date().toISOString() }).eq('id', 1)
    refresh()
  }

  // Optimistic patch: flip local state IMMEDIATELY, then send the update to
  // Supabase in the background. The realtime subscription will reconcile any
  // drift if the write fails or differs. This makes toggles feel instant
  // instead of waiting for the 150-300ms Supabase round-trip.
  const updateConfig = useCallback(async (id: number, patch: Partial<MmConfig>) => {
    setConfigs(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
    await supabase.from('mm_config')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
  }, [])

  async function toggleFlag(cfg: MmConfig | null, flag: 'bid_enabled' | 'offer_enabled') {
    if (!cfg) return
    await updateConfig(cfg.id, { [flag]: !cfg[flag] })
  }

  async function bulkSetEventOff(g: EventGroup) {
    const ids = [...g.bySubmarket.values()].flatMap(r => [r.outcome0?.id, r.outcome1?.id]).filter(Boolean) as number[]
    if (!ids.length) return
    setConfigs(prev => prev.map(c => ids.includes(c.id) ? { ...c, bid_enabled: false, offer_enabled: false } : c))
    await supabase.from('mm_config')
      .update({ bid_enabled: false, offer_enabled: false, updated_at: new Date().toISOString() })
      .in('id', ids)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-blue-400">Market Maker</h1>
            <p className="text-sm text-gray-400 mt-1">Polymarket LoL · DRY_RUN until you flip MM_LIVE on the worker</p>
          </div>
          {kill && (
            <button onClick={flipKill}
              className={`px-6 py-3 rounded-lg font-bold text-sm border-2 ${
                kill.killed ? 'bg-gray-800 border-gray-700 text-gray-400 hover:border-green-500 hover:text-green-400'
                            : 'bg-red-700/40 border-red-600 text-red-200 hover:bg-red-700/60'
              }`}>
              {kill.killed ? '▶ ENABLE MM' : '■ EMERGENCY STOP'}
            </button>
          )}
        </div>
        {kill && (
          <p className={`text-xs mt-2 font-mono ${kill.killed ? 'text-yellow-500' : 'text-green-400'}`}>
            kill_switch: {kill.killed ? `KILLED — ${kill.reason ?? '(no reason)'}` : 'ACTIVE — orders may be placed'}
            <span className="text-gray-600 ml-3">{new Date(kill.updated_at).toLocaleString()}</span>
          </p>
        )}
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"        className="text-sm text-gray-400 hover:text-gray-200">Dashboard</Link>
        <Link href="/games"   className="text-sm text-gray-400 hover:text-gray-200">Game Explorer</Link>
        <Link href="/trader"  className="text-sm text-gray-400 hover:text-gray-200">Trader</Link>
        <Link href="/flow"    className="text-sm text-gray-400 hover:text-gray-200">Order Flow</Link>
        <span className="text-sm text-yellow-400 font-medium">Market Maker</span>
      </div>

      <div className="px-6 py-3 border-b border-gray-800 flex gap-4 flex-wrap items-center">
        <input type="text" placeholder="Search team / event…"
          value={search} onChange={e => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm w-56" />
        <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
          <button onClick={() => setFilter('active')}
            className={`px-3 py-1.5 ${filter==='active' ? 'bg-yellow-500 text-gray-900 font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
            Active</button>
          <button onClick={() => setFilter('all')}
            className={`px-3 py-1.5 ${filter==='all' ? 'bg-yellow-500 text-gray-900 font-semibold' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
            All events ({groups.length})</button>
        </div>
        <span className="text-xs text-gray-500 ml-auto">{loading ? 'Loading…' : `${filteredGroups.length} events`}</span>
      </div>

      <main className="px-6 py-6 max-w-5xl mx-auto">
        <section className="space-y-4">
          {filteredGroups.map(g => (
            <EventCard
              key={g.event_slug}
              group={g}
              states={states}
              anchor={anchorTeam[g.event_slug] ?? 0}
              pinned={pinned.has(g.event_slug)}
              onAnchorChange={(team) => setAnchorTeam(prev => ({ ...prev, [g.event_slug]: team }))}
              onToggle={(cfg, flag) => toggleFlag(cfg, flag)}
              onTurnOffAll={() => bulkSetEventOff(g)}
              onTogglePin={() => togglePin(g.event_slug)}
              onUpdateConfig={updateConfig}
            />
          ))}
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold text-gray-200 mb-3">Recent activity</h2>
          {logs.length === 0 ? (
            <p className="text-gray-500 text-xs">No activity yet.</p>
          ) : (
            <table className="w-full text-xs whitespace-nowrap">
              <thead><tr className="border-b border-gray-800">
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500 w-28">When</th>
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500 w-20">Action</th>
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500 w-16">Side</th>
                <th className="text-right py-1.5 pr-4 font-medium text-gray-500 w-20">Price</th>
                <th className="text-right py-1.5 pr-4 font-medium text-gray-500 w-20">Size</th>
                <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Reason</th>
              </tr></thead>
              <tbody>
                {logs.map(l => (
                  <tr key={l.id} className="border-b border-gray-800/30">
                    <td className="py-1 pr-4 font-mono text-gray-500">{new Date(l.ts).toLocaleTimeString()}</td>
                    <td className={`py-1 pr-4 font-mono ${
                      l.action === 'quote'  ? 'text-green-400' :
                      l.action === 'cancel' ? 'text-yellow-300' :
                      l.action === 'fill'   ? 'text-blue-300' :
                      l.action === 'pause'  ? 'text-red-300' : 'text-gray-300'
                    }`}>{l.action}{l.dry_run ? ' (dry)' : ''}</td>
                    <td className="py-1 pr-4 font-mono text-gray-400">{l.side}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300 text-right">{l.price?.toFixed(3) ?? '—'}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300 text-right">{l.size_shares != null ? Math.round(l.size_shares).toLocaleString() : '—'}</td>
                    <td className="py-1 pr-4 text-gray-500">{l.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  )
}

// ── Event card ────────────────────────────────────────────────────────────

function EventCard({
  group, states, anchor, pinned, onAnchorChange, onToggle, onTurnOffAll, onTogglePin, onUpdateConfig,
}: {
  group: EventGroup
  states: Record<string, MmState>
  anchor: 0 | 1
  pinned: boolean
  onAnchorChange: (team: 0 | 1) => void
  onToggle: (cfg: MmConfig | null, flag: 'bid_enabled' | 'offer_enabled') => void
  onTurnOffAll: () => void
  onTogglePin: () => void
  onUpdateConfig: (id: number, patch: Partial<MmConfig>) => Promise<void>
}) {
  const anchorTeam = anchor === 0 ? group.team1 : group.team2

  const submarketKeys = useMemo(() =>
    [...group.bySubmarket.keys()].sort((a, b) => subOrder(a) - subOrder(b)),
  [group.bySubmarket])

  const anyActive = [...group.bySubmarket.values()].some(r =>
    r.outcome0?.bid_enabled || r.outcome0?.offer_enabled
    || r.outcome1?.bid_enabled || r.outcome1?.offer_enabled
  )

  return (
    <div className={`border rounded-lg ${anyActive ? 'border-green-700/60 bg-green-950/10' : pinned ? 'border-yellow-700/60 bg-yellow-950/10' : 'border-gray-800 bg-gray-900/30'}`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between gap-4">
        <button
          onClick={onTogglePin}
          title={pinned ? 'Unpin from Active tab' : 'Pin to Active tab (stays visible even when no sides toggled on)'}
          className={`text-base ${pinned ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-300'}`}
        >{pinned ? '★' : '☆'}</button>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-100 truncate">
            {group.team1} vs {group.team2}
            {(() => {
              const ts = eventTs(group.event_slug)
              if (!Number.isFinite(ts)) return null
              const days = Math.round((ts - Date.now()) / 86400000)
              const label = days < 0 ? `${Math.abs(days)}d ago`
                          : days === 0 ? 'today'
                          : days === 1 ? 'tomorrow'
                          : `in ${days}d`
              return <span className="ml-2 text-xs font-normal text-gray-500">· {new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ({label})</span>
            })()}
          </div>
          <div className="text-xs text-gray-500 truncate">{group.event_title}</div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">Anchor:</span>
          <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
            <button onClick={() => onAnchorChange(0)}
              className={`px-3 py-1 ${anchor === 0 ? 'bg-blue-700/60 text-blue-100' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {group.team1}</button>
            <button onClick={() => onAnchorChange(1)}
              className={`px-3 py-1 ${anchor === 1 ? 'bg-red-700/60 text-red-100' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {group.team2}</button>
          </div>
          {anyActive && (
            <button onClick={onTurnOffAll}
              className="text-xs text-red-400 hover:text-red-300 ml-2">Turn off all</button>
          )}
        </div>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800/50 text-gray-500">
            <th className="text-left  py-1.5 px-4 font-medium w-40">Submarket</th>
            <th className="text-center py-1.5 px-2 font-medium w-16">Bid</th>
            <th className="text-center py-1.5 px-2 font-medium w-16">Offer</th>
            <th className="text-center py-1.5 px-2 font-medium w-20" title="Quote size in shares">Size (sh)</th>
            <th className="text-center py-1.5 px-2 font-medium w-20" title="Pricing strategy: Join the best level vs penny one cent behind">Strat</th>
            <th className="text-center py-1.5 px-2 font-medium w-20" title="min_level_size_usd: skip quoting if top-of-book size × price is less than this $ value">Min Lvl $</th>
            <th className="text-center py-1.5 px-2 font-medium w-20" title="max_fill_usd: pause once today's fills reach this $ value">Fill Cap $</th>
            <th className="text-center py-1.5 px-2 font-medium w-20" title="max_position_shares: pause once |position| reaches this share count">Pos Cap sh</th>
            <th className="text-left  py-1.5 px-4 font-medium text-[10px]">State (book top · active quote · fills · pos)</th>
          </tr>
        </thead>
        <tbody>
          {submarketKeys.map(mt => {
            const row = group.bySubmarket.get(mt)!
            const cfg = anchor === 0 ? row.outcome0 : row.outcome1
            const stateBid    = cfg ? states[`${cfg.condition_id}|${cfg.outcome_index}|bid`]   : null
            const stateOffer  = cfg ? states[`${cfg.condition_id}|${cfg.outcome_index}|offer`] : null
            return (
              <tr key={mt} className="border-b border-gray-800/30 hover:bg-gray-900/30">
                <td className="py-2 px-4 font-mono text-gray-300">{mt}</td>
                <td className="py-2 px-2 text-center">
                  <ToggleBtn on={!!cfg?.bid_enabled} onClick={() => onToggle(cfg, 'bid_enabled')} />
                </td>
                <td className="py-2 px-2 text-center">
                  <ToggleBtn on={!!cfg?.offer_enabled} onClick={() => onToggle(cfg, 'offer_enabled')} />
                </td>
                <td className="py-2 px-2 text-center">
                  {cfg && <SizeEditor cfg={cfg} onUpdateConfig={onUpdateConfig} />}
                </td>
                <td className="py-2 px-2 text-center">
                  {cfg && <StrategyToggle cfg={cfg} onUpdateConfig={onUpdateConfig} />}
                </td>
                <td className="py-2 px-2 text-center">
                  {cfg && <NumEditor cfg={cfg} field="min_level_size_usd" step={50} onUpdateConfig={onUpdateConfig} />}
                </td>
                <td className="py-2 px-2 text-center">
                  {cfg && <NumEditor cfg={cfg} field="max_fill_usd"       step={50} onUpdateConfig={onUpdateConfig} />}
                </td>
                <td className="py-2 px-2 text-center">
                  {cfg && <NumEditor cfg={cfg} field="max_position_shares" step={50} onUpdateConfig={onUpdateConfig} />}
                </td>
                <td className="py-2 px-4 font-mono text-[10px] text-gray-500 truncate">
                  <SideState side="bid"   state={stateBid}   />
                  <SideState side="offer" state={stateOffer} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Per-row size editor. Always shares — exact count, price-agnostic.
function SizeEditor({ cfg, onUpdateConfig }: {
  cfg: MmConfig
  onUpdateConfig: (id: number, patch: Partial<MmConfig>) => Promise<void>
}) {
  const value = cfg.quote_size_shares ?? ''
  const save = (raw: string) => {
    const v = parseFloat(raw)
    if (isNaN(v) || v <= 0) return
    void onUpdateConfig(cfg.id, { quote_size_shares: v })
  }
  return (
    <input type="number" step={10} min={1}
      key={value}
      defaultValue={value}
      onBlur={e => save(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs font-mono text-right" />
  )
}

// Generic numeric editor for any numeric MmConfig field. Lets the user
// override worker-side thresholds (min_level_size_usd, max_fill_usd,
// max_position_shares) inline so trades aren't blocked by static caps.
type NumericMmField = 'min_level_size_usd' | 'max_fill_usd' | 'max_position_shares' | 'max_size_pct'
function NumEditor({ cfg, field, step, onUpdateConfig }: {
  cfg: MmConfig
  field: NumericMmField
  step: number
  onUpdateConfig: (id: number, patch: Partial<MmConfig>) => Promise<void>
}) {
  const value = (cfg[field] as number | undefined) ?? ''
  const save = (raw: string) => {
    const v = parseFloat(raw)
    if (isNaN(v) || v < 0) return
    void onUpdateConfig(cfg.id, { [field]: v } as Partial<MmConfig>)
  }
  return (
    <input type="number" step={step} min={0}
      key={String(value)}
      defaultValue={value}
      onBlur={e => save(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs font-mono text-right" />
  )
}

// Per-row strategy toggle: Join the best level vs penny one cent behind.
function StrategyToggle({ cfg, onUpdateConfig }: {
  cfg: MmConfig
  onUpdateConfig: (id: number, patch: Partial<MmConfig>) => Promise<void>
}) {
  const isPenny = cfg.strategy === 'penny_back'
  const flip = () => {
    void onUpdateConfig(cfg.id, { strategy: isPenny ? 'join_best' : 'penny_back' })
  }
  return (
    <button onClick={flip}
      title={isPenny
        ? 'Penny back: bid 1¢ below top / offer 1¢ above. Click to switch to Join.'
        : 'Join best: match the top level. Click to switch to Penny-back.'}
      className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
        isPenny
          ? 'bg-purple-700/40 border-purple-600 text-purple-200'
          : 'bg-blue-700/40 border-blue-600 text-blue-200'
      }`}>
      {isPenny ? 'Pny' : 'Join'}
    </button>
  )
}

function ToggleBtn({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-0.5 rounded text-[10px] font-semibold border ${
        on
          ? 'bg-green-700/40 border-green-600 text-green-200'
          : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
      }`}>{on ? 'ON' : 'OFF'}</button>
  )
}

function SideState({ side, state }: { side: 'bid' | 'offer'; state: MmState | null }) {
  if (!state) return null
  const isPaused = !!state.paused_reason
  return (
    <div className="flex flex-wrap gap-x-3">
      <span className="text-gray-600">{side}:</span>
      <span>top {state.last_book_top_price?.toFixed(3) ?? '—'} × {state.last_book_top_size?.toFixed(0) ?? '—'}</span>
      <span className={state.active_price ? 'text-yellow-300' : 'text-gray-700'}>
        active {state.active_price ? `${state.active_price.toFixed(3)} × ${state.active_size_shares?.toFixed(0)}` : 'none'}
      </span>
      <span>fills ${state.fills_today_usd.toFixed(0)}</span>
      <span>pos {state.position_shares.toFixed(0)}</span>
      {isPaused && <span className="text-red-400 truncate">PAUSED: {state.paused_reason}</span>}
    </div>
  )
}
