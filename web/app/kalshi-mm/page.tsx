'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

interface StateRow {
  ticker:       string
  slug:         string | null
  market_label: string | null
  outcome:      string | null
  team1:        string | null
  team2:        string | null
  best_of:      number | null
  mode:         'both' | 'bid' | 'ask' | 'off' | null
  fair:         number | null
  pm_bid_depth: number | null
  pm_ask_depth: number | null
  k_bb: number | null; k_bs: number | null
  k_ba: number | null; k_as: number | null
  pm_bb: number | null; pm_ba: number | null
  want_b: number | null; want_a: number | null
  skip_reason: string | null
  pm_ts: number | null
  k_ts:  number | null
  updated_at: string | null
}

interface StateResp { rows: StateRow[]; generated_at: number }

type SortKey = 'event' | 'mode' | 'fair' | 'spread' | 'updated'

interface WorkerHealth {
  ok: boolean
  markets: number
  pm_books: number
  kalshi_books: number
  live_trading: boolean
  live_orders: number
  kill_engaged: boolean
}

export default function KalshiMmPage() {
  const [rows, setRows]       = useState<StateRow[]>([])
  const [genAt, setGenAt]     = useState<number>(0)
  const [err, setErr]         = useState<string | null>(null)
  const [sort, setSort]       = useState<SortKey>('updated')
  const [filter, setFilter]   = useState<string>('')
  const [updating, setUpdating] = useState<Set<string>>(new Set())
  const [health, setHealth]   = useState<WorkerHealth | null>(null)
  const [killing, setKilling] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch('/api/kalshi-mm-state', { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as StateResp
        if (!cancelled) {
          setRows(j.rows ?? [])
          setGenAt(j.generated_at ?? Date.now())
          setErr(null)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const r = await fetch('/api/kalshi-mm-kill', { cache: 'no-store' })
        if (!r.ok) return
        const j = (await r.json()) as WorkerHealth
        if (!cancelled) setHealth(j)
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  async function toggleKill(on: boolean) {
    setKilling(true)
    try {
      const r = await fetch('/api/kalshi-mm-kill', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ on }),
      })
      if (!r.ok) console.error('kill toggle failed', await r.text())
    } finally {
      setKilling(false)
    }
  }

  async function setMode(ticker: string, mode: 'both' | 'bid' | 'ask' | 'off') {
    setUpdating(s => new Set(s).add(ticker))
    // Optimistic local update so the dropdown feels instant; the worker
    // picks up the new mode within the next 5s config poll.
    setRows(rs => rs.map(r => r.ticker === ticker ? { ...r, mode } : r))
    try {
      const r = await fetch('/api/kalshi-mm-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ticker, mode }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    } catch (e) {
      console.error('mode update failed', e)
    } finally {
      setUpdating(s => { const ns = new Set(s); ns.delete(ticker); return ns })
    }
  }

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const out = f
      ? rows.filter(r =>
          (r.ticker || '').toLowerCase().includes(f) ||
          (r.team1 || '').toLowerCase().includes(f) ||
          (r.team2 || '').toLowerCase().includes(f) ||
          (r.market_label || '').toLowerCase().includes(f))
      : rows
    const sorted = [...out]
    const eventKey = (r: StateRow) => `${r.team1 ?? ''} vs ${r.team2 ?? ''} | ${r.market_label ?? ''} | ${r.outcome ?? ''}`
    sorted.sort((a, b) => {
      switch (sort) {
        case 'event': return eventKey(a).localeCompare(eventKey(b))
        case 'mode':  return (a.mode ?? '').localeCompare(b.mode ?? '')
        case 'fair':  return (b.fair ?? -1) - (a.fair ?? -1)
        case 'spread': {
          const sa = (a.k_ba ?? 1) - (a.k_bb ?? 0)
          const sb = (b.k_ba ?? 1) - (b.k_bb ?? 0)
          return sa - sb   // tightest first
        }
        case 'updated':
        default:
          return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      }
    })
    return sorted
  }, [rows, filter, sort])

  const live = rows.filter(r => r.skip_reason == null).length

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-400">
            Kalshi Maker {health?.live_trading ? <span className="text-amber-400 text-sm">(LIVE)</span> : <span className="text-gray-500 text-sm">(dry-run)</span>}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            {live} live / {rows.length} markets.
            {health && <span className="ml-3 text-gray-500">{health.live_orders} resting orders</span>}
            {genAt > 0 && <span className="text-gray-600 ml-2">refresh {new Date(genAt).toLocaleTimeString()}</span>}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {health?.kill_engaged ? (
            <button onClick={() => toggleKill(false)} disabled={killing}
                    className="px-3 py-1.5 rounded bg-red-900 border border-red-600 text-red-200 hover:bg-red-800 text-sm">
              KILL ENGAGED · click to release
            </button>
          ) : (
            <button onClick={() => toggleKill(true)} disabled={killing}
                    className="px-3 py-1.5 rounded bg-gray-900 border border-red-800 text-red-400 hover:bg-red-900/40 text-sm">
              ⏻ Kill (cancel all)
            </button>
          )}
          <nav className="flex gap-5 text-sm">
            <Link href="/"        className="text-gray-400 hover:text-gray-200">Home</Link>
            <Link href="/trader"  className="text-gray-400 hover:text-gray-200">Trader</Link>
            <Link href="/scanner" className="text-gray-400 hover:text-gray-200">Scanner</Link>
            <Link href="/pnl"     className="text-gray-400 hover:text-gray-200">PnL</Link>
          </nav>
        </div>
      </header>

      <main className="px-6 py-5">
        {err && <p className="text-red-400 mb-3">error: {err}</p>}

        <div className="flex items-center gap-3 mb-4">
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter by team / market / ticker"
            className="bg-gray-900 border border-gray-800 rounded px-3 py-1.5 text-sm w-72"
          />
          <span className="text-xs text-gray-500">sort:</span>
          {(['updated','event','mode','fair','spread'] as SortKey[]).map(k => (
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
                <th className="px-3 py-2 text-left">Event</th>
                <th className="px-3 py-2 text-left">Market / Outcome</th>
                <th className="px-3 py-2 text-left">Ticker</th>
                <th className="px-3 py-2 text-center">Mode</th>
                <th className="px-3 py-2 text-right">Fair</th>
                <th className="px-3 py-2 text-right">PM bid</th>
                <th className="px-3 py-2 text-right">PM ask</th>
                <th className="px-3 py-2 text-right">PM depth ◆ b/a</th>
                <th className="px-3 py-2 text-right">K bid (sz)</th>
                <th className="px-3 py-2 text-right">K ask (sz)</th>
                <th className="px-3 py-2 text-right">Want bid</th>
                <th className="px-3 py-2 text-right">Want ask</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const stale  = r.skip_reason != null
                const fairC  = r.fair  != null ? `${(r.fair  * 100).toFixed(1)}¢` : '—'
                const wantBC = r.want_b != null ? `${(r.want_b * 100).toFixed(0)}¢` : '—'
                const wantAC = r.want_a != null ? `${(r.want_a * 100).toFixed(0)}¢` : '—'
                const kBidC  = r.k_bb  != null ? `${(r.k_bb  * 100).toFixed(0)}¢` : '—'
                const kAskC  = r.k_ba  != null ? `${(r.k_ba  * 100).toFixed(0)}¢` : '—'
                const pmBidC = r.pm_bb != null ? `${(r.pm_bb * 100).toFixed(1)}¢` : '—'
                const pmAskC = r.pm_ba != null ? `${(r.pm_ba * 100).toFixed(1)}¢` : '—'
                const mode = r.mode ?? 'both'
                const isOff = mode === 'off'
                return (
                  <tr key={r.ticker}
                      className={`border-t border-gray-800 ${isOff ? 'opacity-40' : ''}`}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.team1} vs {r.team2}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="text-gray-400">{r.market_label}</span>
                      <span className="text-gray-600"> · </span>
                      <span className="text-gray-100">{r.outcome}</span>
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">{r.ticker}</td>
                    <td className="px-3 py-1.5 text-center">
                      <select
                        value={mode}
                        disabled={updating.has(r.ticker)}
                        onChange={e => setMode(r.ticker, e.target.value as 'both'|'bid'|'ask'|'off')}
                        className={`bg-gray-900 border rounded px-1.5 py-0.5 text-xs
                          ${mode === 'both' ? 'border-emerald-700 text-emerald-300' :
                            mode === 'bid'  ? 'border-sky-700     text-sky-300'     :
                            mode === 'ask'  ? 'border-amber-700   text-amber-300'   :
                                              'border-gray-700    text-gray-500'}`}
                      >
                        <option value="both">both</option>
                        <option value="bid">bid</option>
                        <option value="ask">ask</option>
                        <option value="off">off</option>
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-right">{fairC}</td>
                    <td className="px-3 py-1.5 text-right text-sky-200">{pmBidC}</td>
                    <td className="px-3 py-1.5 text-right text-amber-200">{pmAskC}</td>
                    <td className="px-3 py-1.5 text-right text-gray-400">
                      {r.pm_bid_depth != null ? Math.round(r.pm_bid_depth) : '—'}
                      <span className="text-gray-600"> / </span>
                      {r.pm_ask_depth != null ? Math.round(r.pm_ask_depth) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {kBidC} <span className="text-gray-600">({r.k_bs ?? '—'})</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {kAskC} <span className="text-gray-600">({r.k_as ?? '—'})</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={mode === 'ask' || mode === 'off' ? 'text-gray-600' : 'text-sky-300'}>{wantBC}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={mode === 'bid' || mode === 'off' ? 'text-gray-600' : 'text-amber-300'}>{wantAC}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      {stale ? <span className="text-red-400">{r.skip_reason}</span>
                             : <span className="text-emerald-500">live</span>}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-6 text-center text-gray-500">
                  {rows.length === 0
                    ? 'No state rows yet — is the kw-kalshi-mm worker running?'
                    : 'No markets match the filter.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-500 mt-4 max-w-3xl">
          Each row is one (event × market × outcome) where we have both a Polymarket token and a Kalshi ticker.
          <code className="text-gray-400"> Fair</code> is the size-weighted Polymarket microprice, gated to
          ≥&nbsp;500 contracts each side (≈ same liquidity threshold across favorites and underdogs).
          <code className="text-gray-400"> Want bid / Want ask</code> is what we would post on Kalshi —
          rounded to cents, never quoted through fair, improving the BBO by 1¢ when possible.
          Mode picks which side(s) we'd post on; flipping it propagates to the worker within ~5&nbsp;s.
        </p>
      </main>
    </div>
  )
}
