'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

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

type SortKey = 'event' | 'fair' | 'edge' | 'position' | 'updated'

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const cents = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(1)}¢`
const usd = (v: number | null | undefined) =>
  v == null ? '—' : `$${v.toFixed(2)}`

export default function PolymarketMmPage() {
  const [data,   setData]   = useState<ApiResp | null>(null)
  const [err,    setErr]    = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [sort,   setSort]   = useState<SortKey>('edge')
  const [busy,   setBusy]   = useState<Set<number>>(new Set())

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
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [])

  async function patchCfg(id: number, updates: Record<string, unknown>) {
    setBusy(s => new Set(s).add(id))
    // Optimistic local update
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
      (r.cfg.outcome_label || '').toLowerCase().includes(f) ||
      (r.cfg.event_slug || '').toLowerCase().includes(f))
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
      switch (sort) {
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
  }, [data, filter, sort])

  const enabledCount = data?.rows.filter(r => r.cfg.enabled).length ?? 0
  const nbboCount    = data?.rows.filter(r => r.cfg.strategy === 'nbbo_edge').length ?? 0
  const killed       = data?.kill_switch.killed ?? true

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-400">Polymarket Maker</h1>
          <p className="text-sm text-gray-400 mt-1">
            {enabledCount} enabled · {nbboCount} on nbbo_edge ·
            {data?.rows.length ?? 0} markets total
            {data && <span className="text-gray-600 ml-2">refresh {new Date(data.generated_at).toLocaleTimeString()}</span>}
            {err && <span className="text-red-400 ml-3">error: {err}</span>}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {killed ? (
            <button onClick={() => toggleKill(false)}
                    className="px-3 py-1.5 rounded bg-red-900 border border-red-600 text-red-200 hover:bg-red-800 text-sm">
              KILL ENGAGED · click to release
            </button>
          ) : (
            <button onClick={() => toggleKill(true)}
                    className="px-3 py-1.5 rounded bg-gray-900 border border-red-800 text-red-400 hover:bg-red-900/40 text-sm">
              ⏻ Kill (cancel all)
            </button>
          )}
          <nav className="flex gap-5 text-sm">
            <Link href="/"          className="text-gray-400 hover:text-gray-200">Home</Link>
            <Link href="/scanner"   className="text-gray-400 hover:text-gray-200">Scanner</Link>
            <Link href="/kalshi-mm" className="text-gray-400 hover:text-gray-200">Kalshi-MM</Link>
          </nav>
        </div>
      </header>

      <main className="px-6 py-5">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <input value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="filter by team / event / market"
                 className="bg-gray-900 border border-gray-800 rounded px-3 py-1.5 text-sm w-72" />
          <span className="text-xs text-gray-500">sort:</span>
          {(['edge', 'fair', 'position', 'event', 'updated'] as SortKey[]).map(k => (
            <button key={k} onClick={() => setSort(k)}
                    className={`px-2 py-0.5 text-xs rounded ${sort === k ? 'bg-emerald-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {k}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto border border-gray-800 rounded-lg">
          <table className="w-full text-xs font-mono">
            <thead className="bg-gray-900 text-gray-400 uppercase tracking-wide">
              <tr>
                <th className="px-2 py-2 text-left">Event / outcome</th>
                <th className="px-2 py-2 text-left">Strategy</th>
                <th className="px-2 py-2 text-center">On</th>
                <th className="px-2 py-2 text-center">Bid</th>
                <th className="px-2 py-2 text-center">Ask</th>
                <th className="px-2 py-2 text-right">Fair</th>
                <th className="px-2 py-2 text-right">Edge thr.</th>
                <th className="px-2 py-2 text-right">PM bid</th>
                <th className="px-2 py-2 text-right">PM ask</th>
                <th className="px-2 py-2 text-right">Bid edge</th>
                <th className="px-2 py-2 text-right">Ask edge</th>
                <th className="px-2 py-2 text-right">Size (sh)</th>
                <th className="px-2 py-2 text-right">Pos</th>
                <th className="px-2 py-2 text-right">Fills $</th>
                <th className="px-2 py-2 text-left">Status</th>
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
                const bidSize = sb?.last_book_top_size ?? null
                const askSize = so?.last_book_top_size ?? null
                const bidEdge = fair != null && bid != null ? fair - bid : null
                const askEdge = fair != null && ask != null ? ask - fair : null
                const edgeThr = (c.edge_threshold_pp ?? 5) / 100
                const bidGood = bidEdge != null && bidEdge >= edgeThr
                const askGood = askEdge != null && askEdge >= edgeThr
                const pos = (sb?.position_shares ?? 0) + (so?.position_shares ?? 0)
                const fillsTotal = (sb?.fills_today_usd ?? 0) + (so?.fills_today_usd ?? 0)
                const isBusy = busy.has(c.id)
                const statusBits: string[] = []
                if (sb?.paused_reason) statusBits.push(`B:${sb.paused_reason}`)
                if (so?.paused_reason) statusBits.push(`O:${so.paused_reason}`)
                return (
                  <tr key={c.id} className={`border-t border-gray-800 ${c.enabled ? '' : 'opacity-50'}`}>
                    <td className="px-2 py-1 whitespace-nowrap">
                      <div className="text-gray-200">{c.team1} vs {c.team2}</div>
                      <div className="text-[10px] text-gray-500">{c.market_type} · {c.outcome_label}</div>
                    </td>
                    <td className="px-2 py-1">
                      <select value={c.strategy} disabled={isBusy}
                              onChange={e => patchCfg(c.id, { strategy: e.target.value })}
                              className="bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-xs">
                        <option value="join_best">join_best</option>
                        <option value="penny_back">penny_back</option>
                        <option value="nbbo_edge">nbbo_edge</option>
                      </select>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input type="checkbox" checked={c.enabled} disabled={isBusy}
                             onChange={e => patchCfg(c.id, { enabled: e.target.checked })} />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input type="checkbox" checked={!!c.bid_enabled} disabled={isBusy}
                             onChange={e => patchCfg(c.id, { bid_enabled: e.target.checked })} />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input type="checkbox" checked={!!c.offer_enabled} disabled={isBusy}
                             onChange={e => patchCfg(c.id, { offer_enabled: e.target.checked })} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      {fair != null ? pct(fair) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input type="number" step="0.5" min="0" max="50"
                             value={c.edge_threshold_pp ?? 5}
                             onChange={e => patchCfg(c.id, { edge_threshold_pp: parseFloat(e.target.value) })}
                             className="bg-gray-950 border border-gray-700 rounded px-1 py-0.5 text-xs w-14 text-right" />
                      <span className="ml-0.5 text-gray-600">pp</span>
                    </td>
                    <td className="px-2 py-1 text-right">
                      {cents(bid)}
                      {bidSize != null && <span className="text-gray-500 text-[10px] ml-1">({bidSize.toLocaleString('en-US',{maximumFractionDigits:0})})</span>}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {cents(ask)}
                      {askSize != null && <span className="text-gray-500 text-[10px] ml-1">({askSize.toLocaleString('en-US',{maximumFractionDigits:0})})</span>}
                    </td>
                    <td className={`px-2 py-1 text-right ${bidGood ? 'text-emerald-400' : 'text-gray-500'}`}>
                      {bidEdge != null ? `${(bidEdge * 100).toFixed(1)}c` : '—'}
                    </td>
                    <td className={`px-2 py-1 text-right ${askGood ? 'text-emerald-400' : 'text-gray-500'}`}>
                      {askEdge != null ? `${(askEdge * 100).toFixed(1)}c` : '—'}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input type="number" step="1" min="0"
                             value={c.quote_size_shares ?? ''} placeholder="auto"
                             onChange={e => patchCfg(c.id, { quote_size_shares: e.target.value === '' ? null : parseFloat(e.target.value) })}
                             className="bg-gray-950 border border-gray-700 rounded px-1 py-0.5 text-xs w-16 text-right" />
                    </td>
                    <td className={`px-2 py-1 text-right ${pos > 0 ? 'text-emerald-300' : pos < 0 ? 'text-red-300' : ''}`}>
                      {pos.toFixed(0)}
                    </td>
                    <td className="px-2 py-1 text-right text-gray-400">{usd(fillsTotal)}</td>
                    <td className="px-2 py-1 text-[10px] text-amber-300">
                      {statusBits.join(' / ') || (c.enabled ? '' : 'disabled')}
                    </td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr><td colSpan={15} className="px-2 py-6 text-center text-gray-500">
                  {data?.rows.length === 0
                    ? 'No mm_config rows yet — apply migration + let the worker auto-populate from poly_market_balance.'
                    : 'No markets match the filter.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-500 mt-4 max-w-3xl">
          Each row is a (market × outcome). <code className="text-gray-400">strategy=nbbo_edge</code> means
          the worker joins NBBO at <strong>1/3 of depth</strong> when |fair − market price| ≥ <code className="text-gray-400">edge_threshold_pp</code> on each
          side independently — quotes only the side(s) with edge. <code className="text-gray-400">Fair</code> auto-syncs from
          the scanner every 60s. <code className="text-gray-400">On</code> is master enable; <code className="text-gray-400">Bid</code>/<code className="text-gray-400">Ask</code> toggle per side. Leave <code className="text-gray-400">size</code> empty for the 1/3-depth default.
        </p>
      </main>
    </div>
  )
}
