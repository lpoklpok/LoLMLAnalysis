'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

interface MmConfigRow {
  id:                 number
  condition_id:       string
  market_type:        string
  outcome_index:      number
  event_slug:         string | null
  event_title:        string | null
  team1:              string | null
  team2:              string | null
  outcome_label:      string | null
  enabled:            boolean
  strategy:           'join_best' | 'penny_back' | 'nbbo_edge'
  bid_enabled:        boolean | null
  offer_enabled:      boolean | null
  fair:               number | null
  edge_threshold_pp:  number | null
  quote_size_shares:  number | null
  quote_size_usd:     number | null
  max_position_shares:number | null
  fair_updated_at:    string | null
  updated_at:         string
}

interface MmStateRow {
  active_order_id:     string | null
  active_price:        number | null
  active_size_shares:  number | null
  fills_today_usd:     number | null
  position_shares:     number | null
  last_book_top_price: number | null
  last_book_top_size:  number | null
  last_quote_ts:       string | null
  paused_reason:       string | null
}

interface PageRow {
  cfg:         MmConfigRow
  state_bid:   MmStateRow | null
  state_offer: MmStateRow | null
}

interface KillSwitch { killed: boolean; reason: string | null; updated_at?: string }
interface ApiResp {
  rows:         PageRow[]
  kill_switch:  KillSwitch
  generated_at: number
}

type SortKey = 'active' | 'event' | 'fair' | 'edge' | 'position' | 'updated'
type ViewMode = 'all' | 'active' | 'enabled' | 'with-edge'

const cents = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(1)}¢`
const usd   = (v: number | null | undefined) => v == null ? '—' : `$${v.toFixed(2)}`
const num   = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('en-US',{maximumFractionDigits:0})

function isActive(s: MmStateRow | null): boolean {
  return !!(s && s.active_order_id && s.active_size_shares && s.active_size_shares > 0)
}

// Realtime patch helpers — mutate the ApiResp in response to a single
// Postgres row event so the cockpit shows changes the instant the worker
// writes them, without polling. Each helper returns a new ApiResp.

function patchCfgEvent(d: ApiResp, p: RealtimePostgresChangesPayload<MmConfigRow>): ApiResp {
  if (p.eventType === 'DELETE') {
    const oldId = (p.old as Partial<MmConfigRow>)?.id
    return oldId == null ? d : { ...d, rows: d.rows.filter(r => r.cfg.id !== oldId) }
  }
  const nw = p.new as MmConfigRow
  if (p.eventType === 'INSERT') {
    if (d.rows.some(r => r.cfg.id === nw.id)) return d
    return { ...d, rows: [...d.rows, { cfg: nw, state_bid: null, state_offer: null }] }
  }
  return { ...d, rows: d.rows.map(r => r.cfg.id === nw.id ? { ...r, cfg: nw } : r) }
}

interface MmStateDbRow extends MmStateRow {
  condition_id:  string
  outcome_index: number
  side:          'bid' | 'offer'
}

function patchStateEvent(d: ApiResp, p: RealtimePostgresChangesPayload<MmStateDbRow>): ApiResp {
  const ref = (p.eventType === 'DELETE' ? p.old : p.new) as Partial<MmStateDbRow>
  const { condition_id, outcome_index, side } = ref
  if (!condition_id || outcome_index == null || (side !== 'bid' && side !== 'offer')) return d
  const next = p.eventType === 'DELETE' ? null : (p.new as MmStateDbRow)
  return {
    ...d,
    rows: d.rows.map(r => {
      if (r.cfg.condition_id !== condition_id || r.cfg.outcome_index !== outcome_index) return r
      return side === 'bid' ? { ...r, state_bid: next } : { ...r, state_offer: next }
    }),
  }
}

function patchKillEvent(d: ApiResp, p: RealtimePostgresChangesPayload<KillSwitch>): ApiResp {
  if (p.eventType === 'DELETE') return d
  return { ...d, kill_switch: p.new as KillSwitch }
}

export default function PolymarketMmPage() {
  const [data,    setData]    = useState<ApiResp | null>(null)
  const [err,     setErr]     = useState<string | null>(null)
  const [filter,  setFilter]  = useState('')
  const [sort,    setSort]    = useState<SortKey>('active')
  const [view,    setView]    = useState<ViewMode>('all')
  const [busy,    setBusy]    = useState<Set<number>>(new Set())

  async function load() {
    try {
      const r = await fetch('/api/polymarket-mm-state', { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as ApiResp
      setData(j); setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => {
    // One initial fetch to seed config + state + scanner pm_best merge.
    load()
    // Slow safety-net refresh (also re-pulls scanner pm_best which the
    // API route merges in and which Realtime can't push).
    const t = setInterval(load, 30_000)

    // Realtime patches the fast-changing Supabase tables in-place so the
    // 2s polling cadence is no longer needed for live state updates.
    const ch = supabase.channel('polymarket-mm-cockpit')
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'mm_config' },
          (p) => setData(d => d ? patchCfgEvent(d, p as RealtimePostgresChangesPayload<MmConfigRow>) : d))
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'mm_state' },
          (p) => setData(d => d ? patchStateEvent(d, p as RealtimePostgresChangesPayload<MmStateDbRow>) : d))
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'mm_kill_switch' },
          (p) => setData(d => d ? patchKillEvent(d, p as RealtimePostgresChangesPayload<KillSwitch>) : d))
      .subscribe()

    return () => {
      clearInterval(t)
      supabase.removeChannel(ch)
    }
  }, [])

  async function patchCfg(id: number, updates: Record<string, unknown>) {
    setBusy(s => new Set(s).add(id))
    setData(d => d ? {
      ...d,
      rows: d.rows.map(r => r.cfg.id === id ? { ...r, cfg: { ...r.cfg, ...updates } as MmConfigRow } : r),
    } : d)
    try {
      const r = await fetch('/api/polymarket-mm-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(`patch failed: ${j.error ?? r.status}`)
      }
    } finally {
      setBusy(s => { const n = new Set(s); n.delete(id); return n })
      load()
    }
  }

  async function toggleKill(killed: boolean) {
    const r = await fetch('/api/polymarket-mm-kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killed, reason: killed ? 'cockpit kill' : 'cockpit release' }),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      alert(`kill toggle failed: ${j.error ?? r.status}`)
    }
    load()
  }

  const visible = useMemo(() => {
    if (!data) return []
    const f = filter.trim().toLowerCase()
    let xs = data.rows
    if (f) xs = xs.filter(r =>
      (r.cfg.event_title || '').toLowerCase().includes(f) ||
      (r.cfg.team1 || '').toLowerCase().includes(f) ||
      (r.cfg.team2 || '').toLowerCase().includes(f) ||
      (r.cfg.market_type || '').toLowerCase().includes(f) ||
      (r.cfg.outcome_label || '').toLowerCase().includes(f))

    if (view === 'active') {
      xs = xs.filter(r => isActive(r.state_bid) || isActive(r.state_offer))
    } else if (view === 'enabled') {
      xs = xs.filter(r => r.cfg.enabled)
    } else if (view === 'with-edge') {
      xs = xs.filter(r => {
        const fair = r.cfg.fair
        const bid = r.state_bid?.last_book_top_price ?? null
        const ask = r.state_offer?.last_book_top_price ?? null
        const thr = (r.cfg.edge_threshold_pp ?? 5) / 100
        if (fair == null) return false
        const be = bid != null ? fair - bid : -1
        const ae = ask != null ? ask - fair : -1
        return be >= thr || ae >= thr
      })
    }

    const edgeFor = (r: PageRow) => {
      const f_ = r.cfg.fair
      const b = r.state_bid?.last_book_top_price ?? null
      const a = r.state_offer?.last_book_top_price ?? null
      if (f_ == null) return 0
      const be = b != null ? f_ - b : 0
      const ae = a != null ? a - f_ : 0
      return Math.max(be, ae)
    }
    xs = [...xs].sort((a, b) => {
      const aActive = (isActive(a.state_bid) ? 1 : 0) + (isActive(a.state_offer) ? 1 : 0)
      const bActive = (isActive(b.state_bid) ? 1 : 0) + (isActive(b.state_offer) ? 1 : 0)
      switch (sort) {
        case 'active':   return bActive - aActive || edgeFor(b) - edgeFor(a)
        case 'event':    return (a.cfg.event_title || '').localeCompare(b.cfg.event_title || '')
        case 'fair':     return (b.cfg.fair ?? -1) - (a.cfg.fair ?? -1)
        case 'edge':     return edgeFor(b) - edgeFor(a)
        case 'position': return Math.abs((b.state_bid?.position_shares ?? 0) + (b.state_offer?.position_shares ?? 0))
                              - Math.abs((a.state_bid?.position_shares ?? 0) + (a.state_offer?.position_shares ?? 0))
        case 'updated':
        default:         return (b.cfg.updated_at || '').localeCompare(a.cfg.updated_at || '')
      }
    })
    return xs
  }, [data, filter, sort, view])

  const stats = useMemo(() => {
    const rows = data?.rows ?? []
    let bids = 0, asks = 0, restingUsd = 0, posShares = 0, fillsUsd = 0
    for (const r of rows) {
      if (isActive(r.state_bid)) {
        bids++
        restingUsd += (r.state_bid?.active_price ?? 0) * (r.state_bid?.active_size_shares ?? 0)
      }
      if (isActive(r.state_offer)) {
        asks++
        restingUsd += (r.state_offer?.active_price ?? 0) * (r.state_offer?.active_size_shares ?? 0)
      }
      posShares += Math.abs((r.state_bid?.position_shares ?? 0) + (r.state_offer?.position_shares ?? 0))
      fillsUsd  += (r.state_bid?.fills_today_usd ?? 0) + (r.state_offer?.fills_today_usd ?? 0)
    }
    return { bids, asks, restingUsd, posShares, fillsUsd,
             enabled: rows.filter(r => r.cfg.enabled).length, total: rows.length }
  }, [data])

  const killed = data?.kill_switch.killed ?? true

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-4">
          <h1 className="text-2xl font-bold text-emerald-400">Polymarket Maker</h1>
          {err && <span className="text-red-400 text-sm">error: {err}</span>}
        </div>
        <div className="flex items-center gap-3">
          {killed ? (
            <button onClick={() => toggleKill(false)}
                    className="px-3 py-1.5 rounded bg-red-900 border border-red-600 text-red-200 hover:bg-red-800 text-sm">
              KILL ENGAGED · release
            </button>
          ) : (
            <button onClick={() => toggleKill(true)}
                    className="px-3 py-1.5 rounded bg-gray-900 border border-red-800 text-red-400 hover:bg-red-900/40 text-sm">
              ⏻ Kill
            </button>
          )}
          <nav className="flex gap-4 text-sm">
            <Link href="/"          className="text-gray-400 hover:text-gray-200">Home</Link>
            <Link href="/scanner"   className="text-gray-400 hover:text-gray-200">Scanner</Link>
            <Link href="/kalshi-mm" className="text-gray-400 hover:text-gray-200">Kalshi</Link>
          </nav>
        </div>
      </header>

      {/* Top stat cards */}
      <section className="grid grid-cols-2 md:grid-cols-6 gap-3 px-6 py-4 border-b border-gray-800">
        <StatCard label="🟢 Resting bids"  value={stats.bids.toString()}  hint={`${stats.enabled} enabled / ${stats.total}`} />
        <StatCard label="🔴 Resting asks"  value={stats.asks.toString()} />
        <StatCard label="$ resting"        value={usd(stats.restingUsd)} hint="aggregate notional" />
        <StatCard label="|Net position|"   value={`${num(stats.posShares)} sh`} />
        <StatCard label="Fills today"      value={usd(stats.fillsUsd)} />
        <StatCard label="Last refresh"     value={data ? new Date(data.generated_at).toLocaleTimeString().slice(0,8) : '—'} hint="auto every 2s" />
      </section>

      <main className="px-6 py-4">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <input value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="filter team / event / outcome"
                 className="bg-gray-900 border border-gray-800 rounded px-3 py-1.5 text-sm w-72" />
          <span className="text-xs text-gray-500 ml-2">view:</span>
          {(['all','active','enabled','with-edge'] as ViewMode[]).map(v => (
            <button key={v} onClick={() => setView(v)}
                    className={`px-2 py-0.5 text-xs rounded ${view === v ? 'bg-emerald-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {v}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-3">sort:</span>
          {(['active','edge','position','fair','event','updated'] as SortKey[]).map(k => (
            <button key={k} onClick={() => setSort(k)}
                    className={`px-2 py-0.5 text-xs rounded ${sort === k ? 'bg-emerald-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {k}
            </button>
          ))}
          <span className="ml-auto text-xs text-gray-500">{visible.length} of {stats.total} rows</span>
        </div>

        <div className="overflow-x-auto border border-gray-800 rounded-lg">
          <table className="w-full text-xs font-mono">
            <thead className="bg-gray-900 text-gray-400 uppercase tracking-wide text-[10px]">
              <tr>
                <th className="px-2 py-2 text-center">Status</th>
                <th className="px-2 py-2 text-left">Event · outcome</th>
                <th className="px-2 py-2 text-center">Strategy</th>
                <th className="px-2 py-2 text-center">On / Bid / Ask</th>
                <th className="px-2 py-2 text-right">Fair</th>
                <th className="px-2 py-2 text-right">Edge thr.</th>
                <th className="px-2 py-2 text-right">PM bid (sz)</th>
                <th className="px-2 py-2 text-right">PM ask (sz)</th>
                <th className="px-2 py-2 text-right">Edge $</th>
                <th className="px-2 py-2 text-right">Our bid</th>
                <th className="px-2 py-2 text-right">Our ask</th>
                <th className="px-2 py-2 text-right">Size (sh)</th>
                <th className="px-2 py-2 text-right">Pos</th>
                <th className="px-2 py-2 text-right">Fills$</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const c = r.cfg
                const sb = r.state_bid
                const so = r.state_offer
                const fair = c.fair
                const bid     = sb?.last_book_top_price ?? null
                const ask     = so?.last_book_top_price ?? null
                const bidSize = sb?.last_book_top_size  ?? null
                const askSize = so?.last_book_top_size  ?? null
                const bidEdge = fair != null && bid != null ? fair - bid : null
                const askEdge = fair != null && ask != null ? ask - fair : null
                const edgeThr = (c.edge_threshold_pp ?? 5) / 100
                const bidGood = bidEdge != null && bidEdge >= edgeThr
                const askGood = askEdge != null && askEdge >= edgeThr
                const activeBid   = isActive(sb)
                const activeAsk   = isActive(so)
                const ourBidPx    = sb?.active_price ?? null
                const ourBidSz    = sb?.active_size_shares ?? null
                const ourAskPx    = so?.active_price ?? null
                const ourAskSz    = so?.active_size_shares ?? null
                const pos         = (sb?.position_shares ?? 0) + (so?.position_shares ?? 0)
                const fillsTotal  = (sb?.fills_today_usd ?? 0) + (so?.fills_today_usd ?? 0)
                const isBusy      = busy.has(c.id)
                const hasActive   = activeBid || activeAsk
                const pausedBits: string[] = []
                if (sb?.paused_reason) pausedBits.push(`B: ${sb.paused_reason}`)
                if (so?.paused_reason) pausedBits.push(`O: ${so.paused_reason}`)
                return (
                  <tr key={c.id} className={`border-t border-gray-800 align-middle ${
                    hasActive       ? 'bg-emerald-950/30 hover:bg-emerald-950/40'
                                    : c.enabled ? 'hover:bg-gray-900/40'
                                                : 'opacity-50 hover:opacity-70 hover:bg-gray-900/40'}`}>
                    {/* Status: bid/ask LED dots */}
                    <td className="px-2 py-1.5 text-center whitespace-nowrap">
                      <div className="flex items-center gap-1 justify-center">
                        <Dot kind={activeBid ? 'live' : (sb?.paused_reason ? 'paused' : 'off')} title="bid" />
                        <Dot kind={activeAsk ? 'live' : (so?.paused_reason ? 'paused' : 'off')} title="ask" />
                      </div>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="text-gray-200">{c.team1} vs {c.team2}</div>
                      <div className="text-[10px] text-gray-500">{c.market_type} · {c.outcome_label}</div>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <select value={c.strategy} disabled={isBusy}
                              onChange={e => patchCfg(c.id, { strategy: e.target.value })}
                              className="bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[10px]">
                        <option value="join_best">join_best</option>
                        <option value="penny_back">penny_back</option>
                        <option value="nbbo_edge">nbbo_edge</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <div className="flex items-center gap-2 justify-center">
                        <label className="flex items-center gap-0.5">
                          <input type="checkbox" checked={c.enabled}        disabled={isBusy}
                                 onChange={e => patchCfg(c.id, { enabled: e.target.checked })} />
                        </label>
                        <span className="text-gray-700">·</span>
                        <input type="checkbox" checked={!!c.bid_enabled}    disabled={isBusy}
                               onChange={e => patchCfg(c.id, { bid_enabled: e.target.checked })} title="bid enabled" />
                        <input type="checkbox" checked={!!c.offer_enabled}  disabled={isBusy}
                               onChange={e => patchCfg(c.id, { offer_enabled: e.target.checked })} title="ask enabled" />
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">{fair != null ? cents(fair) : <span className="text-gray-600">—</span>}</td>
                    <td className="px-2 py-1.5 text-right">
                      <input type="number" step="0.5" min="0" max="50"
                             value={c.edge_threshold_pp ?? 5}
                             onChange={e => patchCfg(c.id, { edge_threshold_pp: parseFloat(e.target.value) })}
                             className="bg-gray-950 border border-gray-700 rounded px-1 py-0.5 text-xs w-12 text-right" />
                      <span className="ml-0.5 text-gray-600 text-[10px]">pp</span>
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {cents(bid)}
                      {bidSize != null && <span className="text-gray-500 text-[10px] ml-1">({num(bidSize)})</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {cents(ask)}
                      {askSize != null && <span className="text-gray-500 text-[10px] ml-1">({num(askSize)})</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <div className={bidGood ? 'text-emerald-400' : 'text-gray-500'}>
                        b {bidEdge != null ? `${(bidEdge * 100).toFixed(1)}` : '—'}
                      </div>
                      <div className={askGood ? 'text-emerald-400' : 'text-gray-500'}>
                        a {askEdge != null ? `${(askEdge * 100).toFixed(1)}` : '—'}
                      </div>
                    </td>
                    {/* Our resting bid */}
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {activeBid ? (
                        <span className="text-emerald-300">
                          {cents(ourBidPx)} <span className="text-emerald-500/70 text-[10px]">×{num(ourBidSz)}</span>
                        </span>
                      ) : <span className="text-gray-700">—</span>}
                    </td>
                    {/* Our resting ask */}
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {activeAsk ? (
                        <span className="text-amber-300">
                          {cents(ourAskPx)} <span className="text-amber-500/70 text-[10px]">×{num(ourAskSz)}</span>
                        </span>
                      ) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input type="number" step="1" min="0"
                             value={c.quote_size_shares ?? ''} placeholder="auto"
                             onChange={e => patchCfg(c.id, { quote_size_shares: e.target.value === '' ? null : parseFloat(e.target.value) })}
                             className="bg-gray-950 border border-gray-700 rounded px-1 py-0.5 text-xs w-14 text-right" />
                    </td>
                    <td className={`px-2 py-1.5 text-right ${pos > 0 ? 'text-emerald-300' : pos < 0 ? 'text-red-300' : 'text-gray-500'}`}>
                      {pos !== 0 ? pos.toFixed(0) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-gray-400">{fillsTotal > 0 ? usd(fillsTotal) : '—'}</td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr><td colSpan={14} className="px-2 py-8 text-center text-gray-500">
                  {data?.rows.length === 0
                    ? 'No mm_config rows yet — apply migration + wait for the worker fair_sync_loop.'
                    : `No markets match this filter (${view}).`}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-500 mt-3 max-w-3xl">
          🟢 dots = active resting orders. Rows with green tint = currently quoting.
          Use the <code>active</code> view to filter to only what&apos;s on the book.
          <code className="text-gray-400"> Our bid / Our ask</code> show your resting price × size.
          <code className="text-gray-400"> Edge $ b/a</code> show per-side edge (¢); emerald = above your threshold.
          Click <code className="text-gray-400">On</code> to enable; Bid/Ask checkboxes toggle each side.
        </p>
      </main>
    </div>
  )
}


function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
      <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-lg font-semibold text-gray-100 mt-0.5">{value}</p>
      {hint && <p className="text-[10px] text-gray-500">{hint}</p>}
    </div>
  )
}

function Dot({ kind, title }: { kind: 'live' | 'paused' | 'off'; title: string }) {
  const cls = kind === 'live'
    ? 'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.7)]'
    : kind === 'paused' ? 'bg-amber-500' : 'bg-gray-700'
  return <span title={title} className={`inline-block w-2 h-2 rounded-full ${cls}`} />
}
