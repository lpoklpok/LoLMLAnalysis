'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

// ── Types ────────────────────────────────────────────────────────────────
interface BookLevel { price: number; size: number }
interface OutcomeBook { bids: BookLevel[]; asks: BookLevel[] }

// /api/scanner shape — includes token_ids and kalshi tickers per outcome so
// the client knows which WSS/SSE streams to merge into.
interface ScannerOutcome {
  outcome:        string
  fair:           number | null
  token_id:       string | null
  kalshi_ticker:  string | null
  kalshi_opp_ticker: string | null
}
interface ScannerSubmarket {
  market_type:  string
  market_label: string
  outcomes:     ScannerOutcome[]
}
interface ScannerEvent {
  slug:           string
  title:          string
  league:         string
  team1:          string
  team2:          string
  best_of:        number
  pred_blue_win:  number | null
  pred_blue_team: string
  date:           string
  submarkets:     ScannerSubmarket[]
}
interface ScannerResponse {
  events:           ScannerEvent[]
  kalshi_raw_books: Record<string, OutcomeBook>
  generated_at:     number
  ms_elapsed:       number
}

// Kalshi fee per share, matches server formula
const kalshiFeePerShare = (price: number): number => {
  if (price <= 0 || price >= 1) return 0
  return Math.max(0.01, 0.07 * price * (1 - price))
}

interface EdgeRow {
  event_title:    string
  market_label:   string
  outcome:        string
  venue:          'pm' | 'kalshi'
  side:           'bid' | 'ask'
  price:          number
  size:           number
  fair:           number
  total_edge_usd: number
}
interface LiquidityRow {
  event_title:    string
  market_label:   string
  outcome:        string
  venue:          'pm' | 'kalshi'
  side:           'bid' | 'ask'
  best_price:     number
  best_size:      number
  plus1_size:     number
  notional_usd:   number
}

// ── Helpers ──────────────────────────────────────────────────────────────
const fmtUsd = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—'
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
const fmtCent = (p: number | null | undefined): string => {
  if (p == null || !Number.isFinite(p)) return '—'
  return (p * 100).toFixed(1) + 'c'
}
const fmtSize = (s: number): string => s >= 1000 ? `${(s/1000).toFixed(1)}k` : Math.round(s).toString()

function edgeClass(edgePerShare: number | null | undefined): string {
  if (edgePerShare == null || !Number.isFinite(edgePerShare)) return ''
  if (edgePerShare >= 0.10) return 'text-emerald-300 font-bold'
  if (edgePerShare >= 0.05) return 'text-emerald-400 font-semibold'
  if (edgePerShare >= 0.02) return 'text-emerald-500'
  return ''
}

function roundCent(p: number): number { return Math.round(p * 100) / 100 }

// Combine team1-YES + team2-YES Kalshi books into team1's price space.
//   team2 bids at $q → team1 asks at $(1−q)
//   team2 asks at $q → team1 bids at $(1−q)
function combineKalshi(own?: OutcomeBook, opp?: OutcomeBook): OutcomeBook {
  const bids = new Map<number, number>()
  const asks = new Map<number, number>()
  for (const l of own?.bids ?? []) {
    const k = roundCent(l.price); bids.set(k, (bids.get(k) ?? 0) + l.size)
  }
  for (const l of own?.asks ?? []) {
    const k = roundCent(l.price); asks.set(k, (asks.get(k) ?? 0) + l.size)
  }
  for (const l of opp?.asks ?? []) {
    const k = roundCent(1 - l.price); bids.set(k, (bids.get(k) ?? 0) + l.size)
  }
  for (const l of opp?.bids ?? []) {
    const k = roundCent(1 - l.price); asks.set(k, (asks.get(k) ?? 0) + l.size)
  }
  return {
    bids: Array.from(bids, ([price, size]) => ({ price, size })).filter(l => l.size > 0).sort((a, b) => b.price - a.price),
    asks: Array.from(asks, ([price, size]) => ({ price, size })).filter(l => l.size > 0).sort((a, b) => a.price - b.price),
  }
}

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

function BookCell({ best, fair, side, venue }: {
  best: { bid: BookLevel | null; ask: BookLevel | null } | null
  fair: number | null
  side: 'bid' | 'ask'
  venue: 'pm' | 'kalshi'
}) {
  if (!best) return <span className="text-gray-700">—</span>
  const lvl = side === 'bid' ? best.bid : best.ask
  if (!lvl) return <span className="text-gray-700">—</span>
  const edgePerShare = fair != null
    ? (side === 'bid' ? lvl.price - fair : fair - lvl.price)
    : null
  const hasEdge = edgePerShare != null && edgePerShare >= 0.02
  const cls = side === 'bid' ? 'text-green-300' : 'text-red-300'
  return (
    <span className={`font-mono ${hasEdge ? edgeClass(edgePerShare) : cls}`}
          title={`${venue} ${side} @ ${fmtCent(lvl.price)} x ${fmtSize(lvl.size)} shares`}>
      {fmtCent(lvl.price)} <span className="text-gray-600">({fmtSize(lvl.size)})</span>
      {hasEdge && <span className="ml-1 text-amber-300">*</span>}
    </span>
  )
}

export default function ScannerPage() {
  const [events, setEvents] = useState<ScannerEvent[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<number>(0)
  // Books indexed by token (PM) and ticker (Kalshi). Updated by WSS/SSE
  // independently of the events snapshot.
  const [pmBooks, setPmBooks]         = useState<Map<string, OutcomeBook>>(new Map())
  const [kalshiBooks, setKalshiBooks] = useState<Map<string, OutcomeBook>>(new Map())
  const pmTokensRef = useRef<string[]>([])
  const kalshiTickersRef = useRef<string[]>([])

  // ── Initial + periodic snapshot from /api/scanner ──────────────────────
  // This gives us the event list + initial books to seed the maps. After
  // that we keep the books fresh via push (PM WSS + Kalshi book-stream).
  useEffect(() => {
    let cancelled = false
    async function pull() {
      try {
        const r = await fetch('/api/scanner', { cache: 'no-store' })
        if (!r.ok) { if (!cancelled) setErr(`server ${r.status}`); return }
        const d = await r.json() as ScannerResponse & {
          events: Array<ScannerEvent & {
            submarkets: Array<ScannerSubmarket & {
              outcomes: Array<ScannerOutcome & { pm: OutcomeBook | null; kalshi: OutcomeBook | null }>
            }>
          }>
        }
        if (cancelled) return
        setEvents(d.events)
        setErr(null)
        setLastFetched(Date.now())
        // Seed local books with what the server saw — gives the page
        // something to render before WSS/SSE deltas start landing.
        const newPm = new Map<string, OutcomeBook>()
        const tokens: string[] = []
        const tickers = new Set<string>()
        for (const ev of d.events) {
          for (const sm of ev.submarkets) {
            for (const o of sm.outcomes) {
              if (o.token_id) {
                tokens.push(o.token_id)
                const raw = (o as unknown as { pm?: OutcomeBook }).pm
                if (raw) newPm.set(o.token_id, raw)
              }
              if (o.kalshi_ticker) tickers.add(o.kalshi_ticker)
              if (o.kalshi_opp_ticker) tickers.add(o.kalshi_opp_ticker)
            }
          }
        }
        pmTokensRef.current = tokens
        kalshiTickersRef.current = [...tickers]
        setPmBooks(newPm)
        // Seed Kalshi books from the server-returned raw per-ticker map so
        // the page has real data on first paint (the EventSource will then
        // keep them fresh).
        const newKalshi = new Map<string, OutcomeBook>(
          Object.entries(d.kalshi_raw_books ?? {})
        )
        setKalshiBooks(newKalshi)
      } catch (e) { if (!cancelled) setErr(String(e)) }
    }
    pull()
    // Refresh the snapshot less often now that WSS/SSE drives book freshness.
    const id = setInterval(pull, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // ── Polymarket WSS: subscribe to every token in view; merge book + price_change deltas ──
  useEffect(() => {
    const tokens = pmTokensRef.current
    if (tokens.length === 0) return
    let stopped = false
    let backoff = 500
    let ws: WebSocket | null = null
    function connect() {
      if (stopped) return
      ws = new WebSocket(POLY_WS_URL)
      ws.onopen = () => {
        backoff = 500
        ws?.send(JSON.stringify({ assets_ids: tokens, type: 'market' }))
      }
      ws.onmessage = (e) => {
        let data: unknown
        try { data = JSON.parse(typeof e.data === 'string' ? e.data : '') } catch { return }
        const evts = Array.isArray(data) ? data : [data]
        setPmBooks(prev => {
          let changed = false
          const next = new Map(prev)
          for (const evt of evts as Array<{ event_type?: string; asset_id?: string; market?: string;
                                            bids?: Array<{ price: string; size: string }>;
                                            asks?: Array<{ price: string; size: string }>;
                                            changes?: Array<{ price: string; size: string; side: 'BUY'|'SELL' }>; }>) {
            const et = evt.event_type
            const tid = evt.asset_id ?? evt.market
            if (!tid) continue
            if (et === 'book') {
              const bids = (evt.bids ?? []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                .filter(l => l.size > 0).sort((a, b) => b.price - a.price)
              const asks = (evt.asks ?? []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                .filter(l => l.size > 0).sort((a, b) => a.price - b.price)
              next.set(tid, { bids, asks })
              changed = true
            } else if (et === 'price_change') {
              const cur = next.get(tid) ?? { bids: [], asks: [] }
              const bids = new Map<number, number>(cur.bids.map(l => [l.price, l.size]))
              const asks = new Map<number, number>(cur.asks.map(l => [l.price, l.size]))
              for (const c of evt.changes ?? []) {
                const px = parseFloat(c.price)
                const sz = parseFloat(c.size)
                const side = c.side
                const target = side === 'BUY' ? bids : asks
                if (sz <= 0) target.delete(px)
                else target.set(px, sz)
              }
              next.set(tid, {
                bids: Array.from(bids, ([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price),
                asks: Array.from(asks, ([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price),
              })
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      ws.onclose = () => {
        if (stopped) return
        setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => { stopped = true; ws?.close() }
  }, [events.length])

  // ── Kalshi book SSE: subscribe to every ticker; merge full snapshots ───
  useEffect(() => {
    const tickers = kalshiTickersRef.current
    if (tickers.length === 0) return
    const es = new EventSource(`/api/kalshi/book-stream?tickers=${encodeURIComponent(tickers.join(','))}`)
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data) as { ticker: string; bids?: [number, number][]; asks?: [number, number][] }
        if (!d.ticker) return
        setKalshiBooks(prev => {
          const next = new Map(prev)
          const bids = (d.bids ?? []).map(([p, sz]) => ({ price: p, size: sz })).filter(l => l.size > 0).sort((a, b) => b.price - a.price)
          const asks = (d.asks ?? []).map(([p, sz]) => ({ price: p, size: sz })).filter(l => l.size > 0).sort((a, b) => a.price - b.price)
          next.set(d.ticker, { bids, asks })
          return next
        })
      } catch { /* swallow */ }
    }
    es.onerror = () => { /* auto-reconnect */ }
    return () => { es.close() }
  }, [events.length])

  // ── Derive everything client-side from { events, pmBooks, kalshiBooks } ─
  const { rendered, topEdges, topLiquidity } = useMemo(() => {
    const edges: EdgeRow[] = []
    const liquidity: LiquidityRow[] = []

    const rendered = events.map(ev => ({
      ...ev,
      submarkets: ev.submarkets.map(sm => ({
        ...sm,
        outcomes: sm.outcomes.map(o => {
          const pm     = o.token_id ? pmBooks.get(o.token_id) ?? null : null
          const ksOwn  = o.kalshi_ticker ? kalshiBooks.get(o.kalshi_ticker) : undefined
          const ksOpp  = o.kalshi_opp_ticker ? kalshiBooks.get(o.kalshi_opp_ticker) : undefined
          const kalshi = ksOwn || ksOpp ? combineKalshi(ksOwn, ksOpp) : null
          const fair = o.fair

          // Track the per-outcome $ edge totals for the submarket display.
          let pmEdgeUsd     = 0
          let kalshiEdgeUsd = 0

          const venues: Array<['pm' | 'kalshi', OutcomeBook | null]> = [['pm', pm], ['kalshi', kalshi]]
          for (const [venue, book] of venues) {
            if (!book) continue
            const feeFor = venue === 'kalshi' ? kalshiFeePerShare : () => 0

            if (fair != null) {
              for (const l of book.asks) {
                const eps = fair - l.price - feeFor(l.price)
                if (eps <= 0) break
                const totalUsd = eps * l.size
                edges.push({
                  event_title: ev.title, market_label: sm.market_label, outcome: o.outcome,
                  venue, side: 'ask', price: l.price, size: l.size, fair,
                  total_edge_usd: totalUsd,
                })
                if (venue === 'pm') pmEdgeUsd += totalUsd; else kalshiEdgeUsd += totalUsd
              }
              for (const l of book.bids) {
                const eps = l.price - fair - feeFor(l.price)
                if (eps <= 0) break
                const totalUsd = eps * l.size
                edges.push({
                  event_title: ev.title, market_label: sm.market_label, outcome: o.outcome,
                  venue, side: 'bid', price: l.price, size: l.size, fair,
                  total_edge_usd: totalUsd,
                })
                if (venue === 'pm') pmEdgeUsd += totalUsd; else kalshiEdgeUsd += totalUsd
              }
            }
            const bid = book.bids[0]
            if (bid) {
              const plus1 = book.bids.find(l => Math.abs(l.price - (bid.price - 0.01)) < 0.005)
              liquidity.push({
                event_title: ev.title, market_label: sm.market_label, outcome: o.outcome,
                venue, side: 'bid',
                best_price: bid.price, best_size: bid.size,
                plus1_size: plus1?.size ?? 0,
                notional_usd: bid.size * bid.price + (plus1?.size ?? 0) * (bid.price - 0.01),
              })
            }
            const ask = book.asks[0]
            if (ask) {
              const plus1 = book.asks.find(l => Math.abs(l.price - (ask.price + 0.01)) < 0.005)
              liquidity.push({
                event_title: ev.title, market_label: sm.market_label, outcome: o.outcome,
                venue, side: 'ask',
                best_price: ask.price, best_size: ask.size,
                plus1_size: plus1?.size ?? 0,
                notional_usd: ask.size * ask.price + (plus1?.size ?? 0) * (ask.price + 0.01),
              })
            }
          }

          return {
            ...o,
            pm,
            kalshi,
            pm_best:     pm     ? { bid: pm.bids[0]     ?? null, ask: pm.asks[0]     ?? null } : null,
            kalshi_best: kalshi ? { bid: kalshi.bids[0] ?? null, ask: kalshi.asks[0] ?? null } : null,
            pm_edge_usd:     pmEdgeUsd,
            kalshi_edge_usd: kalshiEdgeUsd,
            total_edge_usd:  pmEdgeUsd + kalshiEdgeUsd,
          }
        }),
      })),
    }))

    edges.sort((a, b) => b.total_edge_usd - a.total_edge_usd)
    liquidity.sort((a, b) => b.notional_usd - a.notional_usd)
    return { rendered, topEdges: edges.slice(0, 25), topLiquidity: liquidity.slice(0, 25) }
  }, [events, pmBooks, kalshiBooks])

  const ageS = Math.round((Date.now() - lastFetched) / 1000)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="px-4 md:px-6 py-3 border-b border-gray-800 flex items-baseline gap-4">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Home</Link>
        <h1 className="text-xl font-bold">Scanner</h1>
        <span className="text-xs text-gray-500">PM WSS + Kalshi SSE driven · click-fresh books</span>
        <span className="ml-auto text-xs text-gray-500">
          {events.length} events · snapshot {ageS}s ago
        </span>
      </div>

      {err && <div className="m-4 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">{err}</div>}

      {events.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 text-xs uppercase tracking-wide text-amber-300 font-semibold">
              Top Edge Opportunities ($ PnL vs resting book)
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 text-gray-500 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Event · Market · Outcome</th>
                    <th className="px-2 py-1.5 text-right">Venue · Side</th>
                    <th className="px-2 py-1.5 text-right">Px</th>
                    <th className="px-2 py-1.5 text-right">Sz</th>
                    <th className="px-2 py-1.5 text-right">Fair</th>
                    <th className="px-2 py-1.5 text-right">Edge $</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-900">
                  {topEdges.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-3 text-center text-gray-600">No edge ≥ 0.02 right now.</td></tr>
                  )}
                  {topEdges.map((e, i) => (
                    <tr key={i} className="hover:bg-gray-900/60">
                      <td className="px-2 py-1.5">
                        <div className="text-gray-300 truncate max-w-[260px]" title={e.event_title}>{e.event_title}</div>
                        <div className="text-[10px] text-gray-500">{e.market_label} · {e.outcome}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400">
                        <span className={e.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}>{e.venue.toUpperCase()}</span>{' '}
                        <span className={e.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{e.side.toUpperCase()}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtCent(e.price)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-400">{fmtSize(e.size)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300">{fmtCent(e.fair)}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold text-emerald-300">{fmtUsd(e.total_edge_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 text-xs uppercase tracking-wide text-blue-300 font-semibold">
              Top Liquidity at NBBO + 1c (notional $)
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 text-gray-500 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Event · Market · Outcome</th>
                    <th className="px-2 py-1.5 text-right">Venue · Side</th>
                    <th className="px-2 py-1.5 text-right">Best</th>
                    <th className="px-2 py-1.5 text-right">+1c</th>
                    <th className="px-2 py-1.5 text-right">Notional</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-900">
                  {topLiquidity.length === 0 && (
                    <tr><td colSpan={5} className="px-2 py-3 text-center text-gray-600">No liquidity yet.</td></tr>
                  )}
                  {topLiquidity.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-900/60">
                      <td className="px-2 py-1.5">
                        <div className="text-gray-300 truncate max-w-[260px]" title={r.event_title}>{r.event_title}</div>
                        <div className="text-[10px] text-gray-500">{r.market_label} · {r.outcome}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400">
                        <span className={r.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}>{r.venue.toUpperCase()}</span>{' '}
                        <span className={r.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{r.side.toUpperCase()}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-300">
                        {fmtCent(r.best_price)} <span className="text-gray-600">({fmtSize(r.best_size)})</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-500">{fmtSize(r.plus1_size)}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtUsd(r.notional_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="p-4 space-y-4">
        {rendered.map(ev => (
          <div key={ev.slug} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-baseline gap-3">
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                ev.league === 'LCK' ? 'bg-blue-900/60 text-blue-300' :
                ev.league === 'LEC' ? 'bg-purple-900/60 text-purple-300' :
                ev.league === 'LPL' ? 'bg-red-900/60 text-red-300' :
                ev.league === 'LCS' ? 'bg-emerald-900/60 text-emerald-300' :
                'bg-gray-800 text-gray-400'
              }`}>{ev.league}</span>
              <span className="text-[10px] text-gray-500">Bo{ev.best_of}</span>
              <span className="text-sm font-medium text-gray-100">{ev.team1} <span className="text-gray-600 mx-1">vs</span> {ev.team2}</span>
              <span className="ml-auto text-[10px] text-gray-500">
                G1 prior ({ev.pred_blue_team.slice(0, 12)}): <span className="font-mono text-gray-300">{fmtCent(ev.pred_blue_win)}</span>
              </span>
            </div>

            <table className="w-full text-xs">
              <thead className="text-gray-500 bg-gray-950/40">
                <tr>
                  <th className="px-3 py-2 text-left font-normal">Market</th>
                  <th className="px-3 py-2 text-left font-normal">Outcome</th>
                  <th className="px-3 py-2 text-right font-normal">Fair</th>
                  <th className="px-3 py-2 text-right font-normal border-l border-gray-800" colSpan={3}>Polymarket</th>
                  <th className="px-3 py-2 text-right font-normal border-l border-gray-800" colSpan={3}>Kalshi (combined, fee-net)</th>
                </tr>
                <tr className="text-[10px] text-gray-600 border-b border-gray-800">
                  <th></th><th></th><th></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-green-500">BID (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-red-400">ASK (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-emerald-400">Edge $</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal border-l border-gray-800"><span className="text-green-500">BID (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-red-400">ASK (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-emerald-400">Edge $</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {ev.submarkets.flatMap((sm, smIdx) =>
                  sm.outcomes.map((o, oIdx) => {
                    const pmEdge = (o as { pm_edge_usd?: number }).pm_edge_usd ?? 0
                    const ksEdge = (o as { kalshi_edge_usd?: number }).kalshi_edge_usd ?? 0
                    return (
                    <tr key={`${smIdx}-${oIdx}`} className={oIdx === 0 ? 'bg-gray-900/40' : ''}>
                      <td className="px-3 py-2 text-gray-400">{oIdx === 0 ? sm.market_label : ''}</td>
                      <td className="px-3 py-2 text-gray-200">{o.outcome}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-300 font-semibold">{fmtCent(o.fair)}</td>
                      <td className="px-3 py-2 text-right border-l border-gray-800">
                        <BookCell best={o.pm_best} fair={o.fair} side="bid" venue="pm" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <BookCell best={o.pm_best} fair={o.fair} side="ask" venue="pm" />
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${pmEdge >= 100 ? 'text-emerald-300 font-bold' : pmEdge >= 10 ? 'text-emerald-400' : pmEdge > 0 ? 'text-emerald-500' : 'text-gray-700'}`}>
                        {pmEdge > 0 ? fmtUsd(pmEdge) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right border-l border-gray-800">
                        <BookCell best={o.kalshi_best} fair={o.fair} side="bid" venue="kalshi" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <BookCell best={o.kalshi_best} fair={o.fair} side="ask" venue="kalshi" />
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${ksEdge >= 100 ? 'text-emerald-300 font-bold' : ksEdge >= 10 ? 'text-emerald-400' : ksEdge > 0 ? 'text-emerald-500' : 'text-gray-700'}`}>
                        {ksEdge > 0 ? fmtUsd(ksEdge) : '—'}
                      </td>
                    </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        ))}
        {events.length === 0 && (
          <div className="text-sm text-gray-500 text-center p-6">
            No events in the next 48h. Check back when LCK/LEC/LCS markets open.
          </div>
        )}
      </div>
    </div>
  )
}
