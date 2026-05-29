'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

// ── Types ────────────────────────────────────────────────────────────────
interface BookLevel { price: number; size: number }
interface OutcomeBook { bids: BookLevel[]; asks: BookLevel[] }
interface ScannerOutcome {
  outcome:           string
  fair:              number | null
  token_id:          string | null
  kalshi_ticker:     string | null
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
interface EdgeRow {
  event_title:     string
  market_label:    string
  outcome:         string
  venue:           'pm' | 'kalshi'
  side:            'bid' | 'ask'
  price:           number
  size:            number
  fair:            number
  edge_per_share:  number
  total_edge_usd:  number
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

const roundCent = (p: number) => Math.round(p * 100) / 100

const kalshiFeePerShare = (price: number): number => {
  if (price <= 0 || price >= 1) return 0
  return Math.max(0.01, 0.07 * price * (1 - price))
}

function combineKalshi(own?: OutcomeBook, opp?: OutcomeBook): OutcomeBook {
  const bids = new Map<number, number>()
  const asks = new Map<number, number>()
  for (const l of own?.bids ?? []) { const k = roundCent(l.price); bids.set(k, (bids.get(k) ?? 0) + l.size) }
  for (const l of own?.asks ?? []) { const k = roundCent(l.price); asks.set(k, (asks.get(k) ?? 0) + l.size) }
  for (const l of opp?.asks ?? []) { const k = roundCent(1 - l.price); bids.set(k, (bids.get(k) ?? 0) + l.size) }
  for (const l of opp?.bids ?? []) { const k = roundCent(1 - l.price); asks.set(k, (asks.get(k) ?? 0) + l.size) }
  return {
    bids: Array.from(bids, ([price, size]) => ({ price, size })).filter(l => l.size > 0).sort((a, b) => b.price - a.price),
    asks: Array.from(asks, ([price, size]) => ({ price, size })).filter(l => l.size > 0).sort((a, b) => a.price - b.price),
  }
}

// Invert a YES book into the NO-side view: bids become asks at (1-p), asks
// become bids at (1-p). Used when an outcome is the NO side of a single
// Y/N Kalshi contract (e.g., Under in a Total Maps O/U market — there's one
// ticker, and "Over" is YES while "Under" is NO of the same contract).
function invertBook(book: OutcomeBook): OutcomeBook {
  return {
    bids: book.asks.map(l => ({ price: roundCent(1 - l.price), size: l.size })).sort((a, b) => b.price - a.price),
    asks: book.bids.map(l => ({ price: roundCent(1 - l.price), size: l.size })).sort((a, b) => a.price - b.price),
  }
}

// Decide which book to show for an outcome, handling both 2-ticker
// (match_winner, game_N_winner) and 1-ticker Y/N (Total Maps O/U) cases.
function outcomeKalshiBook(
  ownTicker: string | null,
  oppTicker: string | null,
  isFirstOutcome: boolean,
  books: Map<string, OutcomeBook>,
): OutcomeBook | null {
  const own = ownTicker ? books.get(ownTicker) : undefined
  const opp = oppTicker ? books.get(oppTicker) : undefined
  if (!own && !opp) return null
  // Single ticker Y/N market: outcome[0] is the YES side, outcome[1] is NO.
  // The /api/trader-event endpoint returns the SAME ticker on both sides for
  // this case (e.g. KXLOLTOTALMAPS-…-3 — "did the series end in exactly 3
  // maps"). Both outcomes share one underlying book; we must NOT double-add.
  if (ownTicker && ownTicker === oppTicker && own) {
    return isFirstOutcome ? own : invertBook(own)
  }
  // Two separate tickers — combine team1-YES + team2-YES into team1's space.
  return combineKalshi(own, opp)
}

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

const LEAGUE_COLORS: Record<string, string> = {
  LCK:   'bg-blue-900/60 text-blue-300 border-blue-700/40',
  LEC:   'bg-purple-900/60 text-purple-300 border-purple-700/40',
  LPL:   'bg-red-900/60 text-red-300 border-red-700/40',
  LCS:   'bg-emerald-900/60 text-emerald-300 border-emerald-700/40',
  EWC:   'bg-amber-900/60 text-amber-300 border-amber-700/40',
  LCP:   'bg-cyan-900/60 text-cyan-300 border-cyan-700/40',
  CBLOL: 'bg-fuchsia-900/60 text-fuchsia-300 border-fuchsia-700/40',
}
const leagueClass = (l: string) => LEAGUE_COLORS[l] ?? 'bg-gray-800 text-gray-400 border-gray-700/40'

function edgeBgClass(usd: number): string {
  if (usd >= 500) return 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/50'
  if (usd >= 100) return 'bg-emerald-700/25 text-emerald-300'
  if (usd >= 25)  return 'bg-emerald-900/40 text-emerald-400'
  if (usd > 0)   return 'text-emerald-500'
  return 'text-gray-700'
}

// Per-share edge color band, in DOLLARS per share. 5c+ is great, 2c+ visible.
function epsBgClass(eps: number): string {
  if (eps >= 0.10) return 'bg-amber-500/30 text-amber-100 ring-1 ring-amber-400/60 font-bold'
  if (eps >= 0.05) return 'bg-amber-700/30 text-amber-200 font-semibold'
  if (eps >= 0.02) return 'bg-amber-900/40 text-amber-300'
  if (eps > 0)    return 'text-amber-400'
  return 'text-gray-700'
}

// ── Render: book half-cell (price+size, edge-aware) ─────────────────────
function BookCell({ best, fair, side, venue, hasTicker }: {
  best: { bid: BookLevel | null; ask: BookLevel | null } | null
  fair: number | null
  side: 'bid' | 'ask'
  venue: 'pm' | 'kalshi'
  hasTicker: boolean
}) {
  // Kalshi market doesn't exist for this submarket type — distinct from empty book.
  if (venue === 'kalshi' && !hasTicker) {
    return <span className="text-gray-700 italic text-[10px]">n/a</span>
  }
  if (!best) return <span className="text-gray-700">—</span>
  const lvl = side === 'bid' ? best.bid : best.ask
  if (!lvl) return <span className="text-gray-700">—</span>
  const fee = venue === 'kalshi' ? kalshiFeePerShare(lvl.price) : 0
  const edgePerShare = fair != null
    ? (side === 'bid' ? lvl.price - fair - fee : fair - lvl.price - fee)
    : null
  const hasEdge = edgePerShare != null && edgePerShare >= 0.02
  const baseColor = side === 'bid' ? 'text-green-300' : 'text-red-300'
  const edgeColor =
    edgePerShare == null ? '' :
    edgePerShare >= 0.10 ? 'text-emerald-200 font-bold' :
    edgePerShare >= 0.05 ? 'text-emerald-300 font-semibold' :
    edgePerShare >= 0.02 ? 'text-emerald-400' :
    baseColor
  const title = fair != null && edgePerShare != null
    ? `${venue.toUpperCase()} ${side.toUpperCase()} ${fmtCent(lvl.price)} × ${fmtSize(lvl.size)}` +
      `\nFair ${fmtCent(fair)}` +
      (fee > 0 ? `\nKalshi fee ${(fee*100).toFixed(2)}c/sh` : '') +
      `\nEdge/sh ${(edgePerShare*100).toFixed(2)}c → $${(edgePerShare*lvl.size).toFixed(0)} total`
    : `${venue} ${side} ${fmtCent(lvl.price)}`
  return (
    <span className={`font-mono ${edgeColor}`} title={title}>
      {fmtCent(lvl.price)} <span className="text-gray-600">({fmtSize(lvl.size)})</span>
      {hasEdge && <span className="ml-1 text-amber-300">★</span>}
    </span>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────
export default function ScannerPage() {
  const [events, setEvents] = useState<ScannerEvent[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<number>(0)
  const [pmBooks, setPmBooks]         = useState<Map<string, OutcomeBook>>(new Map())
  const [kalshiBooks, setKalshiBooks] = useState<Map<string, OutcomeBook>>(new Map())
  const pmTokensRef = useRef<string[]>([])
  const kalshiTickersRef = useRef<string[]>([])

  // ── Filter / view controls ──────────────────────────────────────────
  const [minEdge, setMinEdge] = useState<number>(0)
  const [leagueFilter, setLeagueFilter] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState<string>('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [venueFilter, setVenueFilter] = useState<'all' | 'pm' | 'kalshi'>('all')
  // Min-size for the "Substantial Edge" panel — defaults to 100 shares to
  // cut out the tiny resting orders that aren't actionable for real positions.
  const [minTradeSize, setMinTradeSize] = useState<number>(100)

  // ── Initial snapshot from /api/scanner ──────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function pull() {
      try {
        const r = await fetch('/api/scanner', { cache: 'no-store' })
        if (!r.ok) { if (!cancelled) setErr(`server ${r.status}`); return }
        const d = await r.json() as ScannerResponse & {
          events: Array<ScannerEvent & { submarkets: Array<ScannerSubmarket & { outcomes: Array<ScannerOutcome & { pm: OutcomeBook | null }> }> }>
        }
        if (cancelled) return
        setEvents(d.events)
        setErr(null)
        setLastFetched(Date.now())
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
        setKalshiBooks(new Map(Object.entries(d.kalshi_raw_books ?? {})))
      } catch (e) { if (!cancelled) setErr(String(e)) }
    }
    pull()
    const id = setInterval(pull, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // ── Polymarket WSS ───────────────────────────────────────────────────
  useEffect(() => {
    const tokens = pmTokensRef.current
    if (tokens.length === 0) return
    let stopped = false
    let backoff = 500
    let ws: WebSocket | null = null
    function connect() {
      if (stopped) return
      ws = new WebSocket(POLY_WS_URL)
      ws.onopen = () => { backoff = 500; ws?.send(JSON.stringify({ assets_ids: tokens, type: 'market' })) }
      ws.onmessage = (e) => {
        let data: unknown
        try { data = JSON.parse(typeof e.data === 'string' ? e.data : '') } catch { return }
        const evts = Array.isArray(data) ? data : [data]
        setPmBooks(prev => {
          let changed = false
          const next = new Map(prev)
          for (const evt of evts as Array<{ event_type?: string; asset_id?: string; market?: string; bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }>; changes?: Array<{ price: string; size: string; side: 'BUY'|'SELL' }>; }>) {
            const et = evt.event_type
            const tid = evt.asset_id ?? evt.market
            if (!tid) continue
            if (et === 'book') {
              const bids = (evt.bids ?? []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) })).filter(l => l.size > 0).sort((a, b) => b.price - a.price)
              const asks = (evt.asks ?? []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) })).filter(l => l.size > 0).sort((a, b) => a.price - b.price)
              next.set(tid, { bids, asks })
              changed = true
            } else if (et === 'price_change') {
              const cur = next.get(tid) ?? { bids: [], asks: [] }
              const bids = new Map<number, number>(cur.bids.map(l => [l.price, l.size]))
              const asks = new Map<number, number>(cur.asks.map(l => [l.price, l.size]))
              for (const c of evt.changes ?? []) {
                const px = parseFloat(c.price); const sz = parseFloat(c.size)
                const target = c.side === 'BUY' ? bids : asks
                if (sz <= 0) target.delete(px); else target.set(px, sz)
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
      ws.onclose = () => { if (!stopped) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30_000) } }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => { stopped = true; ws?.close() }
  }, [events.length])

  // ── Kalshi book SSE ──────────────────────────────────────────────────
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
    es.onerror = () => {}
    return () => { es.close() }
  }, [events.length])

  // ── Derive everything client-side ───────────────────────────────────
  const { rendered, allEdges, allLiquidity, leagues } = useMemo(() => {
    const allEdges: EdgeRow[] = []
    const allLiquidity: LiquidityRow[] = []
    const leagues = new Set<string>()
    const rendered = events.map(ev => {
      leagues.add(ev.league)
      let eventTotalEdge = 0
      const submarkets = ev.submarkets.map(sm => {
        const outcomes = sm.outcomes.map((o, oIdx) => {
          const pm     = o.token_id ? pmBooks.get(o.token_id) ?? null : null
          // outcomeKalshiBook handles both two-ticker markets (winner side
          // pair) and single-ticker Y/N markets (O/U). For O/U, ownTicker ==
          // oppTicker and the second outcome is the inverted YES book.
          const kalshi = outcomeKalshiBook(o.kalshi_ticker, o.kalshi_opp_ticker, oIdx === 0, kalshiBooks)
          const fair = o.fair
          let pmEdgeUsd = 0
          let kalshiEdgeUsd = 0
          let pmBestEps = 0       // best per-share edge on PM (in $)
          let kalshiBestEps = 0   // best per-share edge on Kalshi (fee-net)
          const venues: Array<['pm' | 'kalshi', OutcomeBook | null]> = [['pm', pm], ['kalshi', kalshi]]
          for (const [venue, book] of venues) {
            if (!book) continue
            const feeFor = venue === 'kalshi' ? kalshiFeePerShare : () => 0
            if (fair != null) {
              for (const l of book.asks) {
                const eps = fair - l.price - feeFor(l.price)
                if (eps <= 0) break
                const totalUsd = eps * l.size
                allEdges.push({ event_title: ev.title, market_label: sm.market_label, outcome: o.outcome, venue, side: 'ask', price: l.price, size: l.size, fair, edge_per_share: eps, total_edge_usd: totalUsd })
                if (venue === 'pm') { pmEdgeUsd += totalUsd; if (eps > pmBestEps) pmBestEps = eps }
                else                 { kalshiEdgeUsd += totalUsd; if (eps > kalshiBestEps) kalshiBestEps = eps }
              }
              for (const l of book.bids) {
                const eps = l.price - fair - feeFor(l.price)
                if (eps <= 0) break
                const totalUsd = eps * l.size
                allEdges.push({ event_title: ev.title, market_label: sm.market_label, outcome: o.outcome, venue, side: 'bid', price: l.price, size: l.size, fair, edge_per_share: eps, total_edge_usd: totalUsd })
                if (venue === 'pm') { pmEdgeUsd += totalUsd; if (eps > pmBestEps) pmBestEps = eps }
                else                 { kalshiEdgeUsd += totalUsd; if (eps > kalshiBestEps) kalshiBestEps = eps }
              }
            }
            const bid = book.bids[0]
            if (bid) {
              const plus1 = book.bids.find(l => Math.abs(l.price - (bid.price - 0.01)) < 0.005)
              allLiquidity.push({ event_title: ev.title, market_label: sm.market_label, outcome: o.outcome, venue, side: 'bid', best_price: bid.price, best_size: bid.size, plus1_size: plus1?.size ?? 0, notional_usd: bid.size * bid.price + (plus1?.size ?? 0) * (bid.price - 0.01) })
            }
            const ask = book.asks[0]
            if (ask) {
              const plus1 = book.asks.find(l => Math.abs(l.price - (ask.price + 0.01)) < 0.005)
              allLiquidity.push({ event_title: ev.title, market_label: sm.market_label, outcome: o.outcome, venue, side: 'ask', best_price: ask.price, best_size: ask.size, plus1_size: plus1?.size ?? 0, notional_usd: ask.size * ask.price + (plus1?.size ?? 0) * (ask.price + 0.01) })
            }
          }
          eventTotalEdge += pmEdgeUsd + kalshiEdgeUsd
          return { ...o, pm, kalshi,
            pm_best: pm ? { bid: pm.bids[0] ?? null, ask: pm.asks[0] ?? null } : null,
            kalshi_best: kalshi ? { bid: kalshi.bids[0] ?? null, ask: kalshi.asks[0] ?? null } : null,
            pm_edge_usd: pmEdgeUsd, kalshi_edge_usd: kalshiEdgeUsd,
            pm_best_eps: pmBestEps, kalshi_best_eps: kalshiBestEps,
          }
        })
        return { ...sm, outcomes }
      })
      return { ...ev, submarkets, total_edge_usd: eventTotalEdge }
    })
    allEdges.sort((a, b) => b.total_edge_usd - a.total_edge_usd)
    allLiquidity.sort((a, b) => b.notional_usd - a.notional_usd)
    return { rendered, allEdges, allLiquidity, leagues }
  }, [events, pmBooks, kalshiBooks])

  // ── Apply filters ───────────────────────────────────────────────────
  const visibleEvents = useMemo(() => {
    return rendered
      .filter(ev => leagueFilter.size === 0 || leagueFilter.has(ev.league))
      .filter(ev => !search || ev.title.toLowerCase().includes(search.toLowerCase()))
      .filter(ev => ev.total_edge_usd >= minEdge)
      .sort((a, b) => b.total_edge_usd - a.total_edge_usd)
  }, [rendered, leagueFilter, search, minEdge])

  const filteredEdges = useMemo(
    () => allEdges
      .filter(e => venueFilter === 'all' || e.venue === venueFilter)
      .filter(e => e.total_edge_usd >= minEdge)
      .slice(0, 30),
    [allEdges, venueFilter, minEdge],
  )
  // Substantial Edges: trades with meaningful size for real position sizing.
  // Sorted by total $ edge so the biggest $-capturable opportunities surface.
  const substantialEdges = useMemo(
    () => allEdges
      .filter(e => e.size >= minTradeSize)
      .filter(e => venueFilter === 'all' || e.venue === venueFilter)
      .filter(e => e.total_edge_usd >= minEdge)
      .slice(0, 30),
    [allEdges, minTradeSize, venueFilter, minEdge],
  )
  const filteredLiquidity = useMemo(
    () => allLiquidity.filter(r => venueFilter === 'all' || r.venue === venueFilter).slice(0, 30),
    [allLiquidity, venueFilter],
  )

  const toggleLeague = (l: string) => {
    setLeagueFilter(s => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n })
  }
  const toggleCollapsed = (slug: string) => {
    setCollapsed(s => { const n = new Set(s); n.has(slug) ? n.delete(slug) : n.add(slug); return n })
  }
  const collapseAll = () => setCollapsed(new Set(rendered.map(e => e.slug)))
  const expandAll = () => setCollapsed(new Set())

  const ageS = Math.round((Date.now() - lastFetched) / 1000)
  const totalEdgeAcrossAll = useMemo(() => allEdges.reduce((s, e) => s + e.total_edge_usd, 0), [allEdges])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Top bar */}
      <div className="sticky top-0 z-20 px-4 md:px-6 py-3 border-b border-gray-800 bg-gray-950/95 backdrop-blur flex items-center gap-3 flex-wrap">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Home</Link>
        <h1 className="text-xl font-bold">Scanner</h1>
        <span className="text-[11px] text-gray-500">PM WSS + Kalshi SSE · {events.length} events · total available {fmtUsd(totalEdgeAcrossAll)}</span>
        <span className="text-[11px] text-gray-600 ml-auto">snapshot {ageS}s</span>
      </div>

      {/* Filter bar */}
      <div className="px-4 md:px-6 py-3 border-b border-gray-800 bg-gray-950 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-gray-500">League:</span>
        {Array.from(leagues).sort().map(l => (
          <button key={l} onClick={() => toggleLeague(l)}
                  className={`px-2 py-1 rounded border text-[10px] uppercase tracking-wide font-semibold transition ${leagueFilter.has(l) || leagueFilter.size === 0 ? leagueClass(l) : 'border-gray-800 text-gray-600 bg-transparent'}`}>
            {l}
          </button>
        ))}
        {leagueFilter.size > 0 && (
          <button onClick={() => setLeagueFilter(new Set())} className="text-[10px] text-gray-500 hover:text-gray-300 underline">clear</button>
        )}
        <div className="h-5 w-px bg-gray-800 mx-1" />
        <span className="text-gray-500">Min edge:</span>
        <input type="number" value={minEdge} onChange={e => setMinEdge(Math.max(0, parseFloat(e.target.value) || 0))}
               className="w-20 px-2 py-1 bg-gray-900 border border-gray-800 rounded text-gray-100 font-mono" placeholder="$0" />
        {[0, 25, 100, 500].map(n => (
          <button key={n} onClick={() => setMinEdge(n)}
                  className={`px-2 py-1 rounded border text-[10px] ${minEdge === n ? 'bg-amber-900/40 border-amber-700 text-amber-200' : 'border-gray-800 text-gray-500 hover:text-gray-300'}`}>
            ≥{n === 0 ? 'any' : `$${n}`}
          </button>
        ))}
        <div className="h-5 w-px bg-gray-800 mx-1" />
        <span className="text-gray-500">Venue:</span>
        {(['all', 'pm', 'kalshi'] as const).map(v => (
          <button key={v} onClick={() => setVenueFilter(v)}
                  className={`px-2 py-1 rounded border text-[10px] uppercase ${venueFilter === v ? (v === 'pm' ? 'bg-blue-900/40 border-blue-700 text-blue-200' : v === 'kalshi' ? 'bg-purple-900/40 border-purple-700 text-purple-200' : 'bg-amber-900/40 border-amber-700 text-amber-200') : 'border-gray-800 text-gray-500'}`}>
            {v}
          </button>
        ))}
        <div className="h-5 w-px bg-gray-800 mx-1" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="search team…"
               className="px-2 py-1 bg-gray-900 border border-gray-800 rounded text-gray-100 w-40" />
        <div className="h-5 w-px bg-gray-800 mx-1" />
        <button onClick={collapseAll} className="text-[10px] text-gray-500 hover:text-gray-300">collapse all</button>
        <button onClick={expandAll} className="text-[10px] text-gray-500 hover:text-gray-300">expand all</button>
      </div>

      {err && <div className="m-4 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">{err}</div>}

      {/* Top rankings */}
      <div className="grid md:grid-cols-3 gap-3 p-3 md:p-4">
        <div className="bg-gray-900 border border-amber-700/30 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wide text-amber-300 font-semibold">Top Edge ($)</span>
            <span className="text-[10px] text-gray-600">{filteredEdges.length} of {allEdges.length}</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-500 sticky top-0 z-10">
                <tr className="border-b border-gray-800">
                  <th className="px-2 py-1.5 text-left font-normal">Event · Market · Outcome</th>
                  <th className="px-2 py-1.5 text-right font-normal">Venue</th>
                  <th className="px-2 py-1.5 text-right font-normal">Side @ Px</th>
                  <th className="px-2 py-1.5 text-right font-normal">Sz</th>
                  <th className="px-2 py-1.5 text-right font-normal">Fair</th>
                  <th className="px-2 py-1.5 text-right font-normal text-amber-300">¢/sh</th>
                  <th className="px-2 py-1.5 text-right font-normal">Edge $</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {filteredEdges.length === 0 && (
                  <tr><td colSpan={7} className="px-2 py-4 text-center text-gray-600">No edge above filter. Lower the Min edge threshold.</td></tr>
                )}
                {filteredEdges.map((e, i) => (
                  <tr key={i} className="hover:bg-gray-900/60 transition">
                    <td className="px-2 py-1.5">
                      <div className="text-gray-300 truncate max-w-[220px]" title={e.event_title}>{e.event_title.replace('LoL: ', '')}</div>
                      <div className="text-[10px] text-gray-500">{e.market_label} · {e.outcome}</div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span className={`text-[10px] uppercase font-semibold ${e.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}`}>{e.venue}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      <span className={e.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{e.side.toUpperCase()}</span>{' '}
                      <span className="text-gray-300">{fmtCent(e.price)}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-400">{fmtSize(e.size)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-amber-300">{fmtCent(e.fair)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${epsBgClass(e.edge_per_share)}`}>
                      {(e.edge_per_share * 100).toFixed(1)}c
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono font-semibold ${edgeBgClass(e.total_edge_usd)}`}>
                      {fmtUsd(e.total_edge_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-gray-900 border border-blue-700/30 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wide text-blue-300 font-semibold">Top Liquidity (NBBO + 1¢)</span>
            <span className="text-[10px] text-gray-600">{filteredLiquidity.length}</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-500 sticky top-0 z-10">
                <tr className="border-b border-gray-800">
                  <th className="px-2 py-1.5 text-left font-normal">Event · Market · Outcome</th>
                  <th className="px-2 py-1.5 text-right font-normal">Venue · Side</th>
                  <th className="px-2 py-1.5 text-right font-normal">Best</th>
                  <th className="px-2 py-1.5 text-right font-normal">+1¢</th>
                  <th className="px-2 py-1.5 text-right font-normal">Notional</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {filteredLiquidity.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-900/60 transition">
                    <td className="px-2 py-1.5">
                      <div className="text-gray-300 truncate max-w-[220px]" title={r.event_title}>{r.event_title.replace('LoL: ', '')}</div>
                      <div className="text-[10px] text-gray-500">{r.market_label} · {r.outcome}</div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span className={`text-[10px] uppercase font-semibold ${r.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}`}>{r.venue}</span>
                      {' '}<span className={r.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{r.side.toUpperCase()}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-300">
                      {fmtCent(r.best_price)} <span className="text-gray-600">({fmtSize(r.best_size)})</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-500">{fmtSize(r.plus1_size)}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold text-blue-300">{fmtUsd(r.notional_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Substantial Edges: filtered to size ≥ N */}
        <div className="bg-gray-900 border border-emerald-700/30 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wide text-emerald-300 font-semibold">Substantial Edge</span>
            <span className="text-[10px] text-gray-500">size ≥</span>
            <input type="number" value={minTradeSize}
                   onChange={e => setMinTradeSize(Math.max(1, parseInt(e.target.value || '1') || 1))}
                   className="w-16 px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-emerald-200 font-mono text-[10px]" />
            <span className="text-[10px] text-gray-600">{substantialEdges.length} hits</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-500 sticky top-0 z-10">
                <tr className="border-b border-gray-800">
                  <th className="px-2 py-1.5 text-left font-normal">Event · Market · Outcome</th>
                  <th className="px-2 py-1.5 text-right font-normal">Venue</th>
                  <th className="px-2 py-1.5 text-right font-normal">Side @ Px</th>
                  <th className="px-2 py-1.5 text-right font-normal">Sz</th>
                  <th className="px-2 py-1.5 text-right font-normal text-amber-300">¢/sh</th>
                  <th className="px-2 py-1.5 text-right font-normal">Edge $</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {substantialEdges.length === 0 && (
                  <tr><td colSpan={6} className="px-2 py-4 text-center text-gray-600">
                    No edges with size ≥ {minTradeSize}. Lower the threshold or wait for thicker books.
                  </td></tr>
                )}
                {substantialEdges.map((e, i) => (
                  <tr key={i} className="hover:bg-gray-900/60 transition">
                    <td className="px-2 py-1.5">
                      <div className="text-gray-300 truncate max-w-[220px]" title={e.event_title}>{e.event_title.replace('LoL: ', '')}</div>
                      <div className="text-[10px] text-gray-500">{e.market_label} · {e.outcome}</div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span className={`text-[10px] uppercase font-semibold ${e.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}`}>{e.venue}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      <span className={e.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{e.side.toUpperCase()}</span>{' '}
                      <span className="text-gray-300">{fmtCent(e.price)}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-300 font-semibold">{fmtSize(e.size)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${epsBgClass(e.edge_per_share)}`}>
                      {(e.edge_per_share * 100).toFixed(1)}c
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono font-semibold ${edgeBgClass(e.total_edge_usd)}`}>
                      {fmtUsd(e.total_edge_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Event cards */}
      <div className="p-3 md:p-4 space-y-3">
        {visibleEvents.length === 0 && events.length > 0 && (
          <div className="text-sm text-gray-500 text-center p-6">
            No events match these filters. Try clearing or lowering Min edge.
          </div>
        )}
        {visibleEvents.map(ev => {
          const isCollapsed = collapsed.has(ev.slug)
          return (
            <div key={ev.slug} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <button onClick={() => toggleCollapsed(ev.slug)} className="w-full px-4 py-3 border-b border-gray-800 flex items-center gap-3 hover:bg-gray-900/80 transition">
                <span className="text-gray-500 w-3 text-center">{isCollapsed ? '▸' : '▾'}</span>
                <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${leagueClass(ev.league)}`}>{ev.league}</span>
                <span className="text-[10px] text-gray-500">Bo{ev.best_of}</span>
                <span className="text-sm font-medium text-gray-100">{ev.team1} <span className="text-gray-600 mx-1">vs</span> {ev.team2}</span>
                <span className="ml-auto flex items-center gap-3 text-[11px]">
                  <span className="text-gray-500">G1 prior <span className="text-gray-300 font-mono">{fmtCent(ev.pred_blue_win)}</span></span>
                  {ev.total_edge_usd > 0 && (
                    <span className={`px-2 py-0.5 rounded-md font-semibold font-mono ${edgeBgClass(ev.total_edge_usd)}`}>
                      Total edge {fmtUsd(ev.total_edge_usd)}
                    </span>
                  )}
                </span>
              </button>

              {!isCollapsed && (
                <table className="w-full text-xs">
                  <thead className="text-gray-500 bg-gray-950/40">
                    <tr>
                      <th className="px-3 py-2 text-left font-normal">Market</th>
                      <th className="px-3 py-2 text-left font-normal">Outcome</th>
                      <th className="px-3 py-2 text-right font-normal">Fair</th>
                      <th className="px-3 py-2 text-right font-normal border-l border-gray-800" colSpan={4}>
                        <span className="text-blue-300">Polymarket</span>
                      </th>
                      <th className="px-3 py-2 text-right font-normal border-l border-gray-800" colSpan={4}>
                        <span className="text-purple-300">Kalshi</span> <span className="text-gray-600 normal-case text-[10px]">(combined, fee-net)</span>
                      </th>
                    </tr>
                    <tr className="text-[10px] text-gray-600 border-b border-gray-800">
                      <th></th><th></th><th></th>
                      <th className="px-3 pb-1.5 text-right font-normal"><span className="text-green-500">BID</span></th>
                      <th className="px-3 pb-1.5 text-right font-normal"><span className="text-red-400">ASK</span></th>
                      <th className="px-3 pb-1.5 text-right font-normal text-amber-300">Edge ¢/sh</th>
                      <th className="px-3 pb-1.5 text-right font-normal text-emerald-400">Edge $</th>
                      <th className="px-3 pb-1.5 text-right font-normal border-l border-gray-800"><span className="text-green-500">BID</span></th>
                      <th className="px-3 pb-1.5 text-right font-normal"><span className="text-red-400">ASK</span></th>
                      <th className="px-3 pb-1.5 text-right font-normal text-amber-300">Edge ¢/sh</th>
                      <th className="px-3 pb-1.5 text-right font-normal text-emerald-400">Edge $</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {ev.submarkets.flatMap((sm, smIdx) =>
                      sm.outcomes.map((o, oIdx) => {
                        const pmEdge = (o as { pm_edge_usd?: number }).pm_edge_usd ?? 0
                        const ksEdge = (o as { kalshi_edge_usd?: number }).kalshi_edge_usd ?? 0
                        const pmEps  = (o as { pm_best_eps?: number }).pm_best_eps ?? 0
                        const ksEps  = (o as { kalshi_best_eps?: number }).kalshi_best_eps ?? 0
                        const hasKalshiTicker = !!o.kalshi_ticker || !!o.kalshi_opp_ticker
                        return (
                        <tr key={`${smIdx}-${oIdx}`} className={oIdx === 0 ? 'bg-gray-900/40' : ''}>
                          <td className="px-3 py-2 text-gray-400">{oIdx === 0 ? sm.market_label : ''}</td>
                          <td className="px-3 py-2 text-gray-200">{o.outcome}</td>
                          <td className="px-3 py-2 text-right font-mono text-amber-300 font-semibold">{fmtCent(o.fair)}</td>
                          <td className="px-3 py-2 text-right border-l border-gray-800">
                            <BookCell best={o.pm_best} fair={o.fair} side="bid" venue="pm" hasTicker={true} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <BookCell best={o.pm_best} fair={o.fair} side="ask" venue="pm" hasTicker={true} />
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${epsBgClass(pmEps)}`}>
                            {pmEps > 0 ? `${(pmEps * 100).toFixed(1)}c` : '—'}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${edgeBgClass(pmEdge)}`}>
                            {pmEdge > 0 ? fmtUsd(pmEdge) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right border-l border-gray-800">
                            <BookCell best={o.kalshi_best} fair={o.fair} side="bid" venue="kalshi" hasTicker={hasKalshiTicker} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <BookCell best={o.kalshi_best} fair={o.fair} side="ask" venue="kalshi" hasTicker={hasKalshiTicker} />
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${epsBgClass(ksEps)}`}>
                            {hasKalshiTicker ? (ksEps > 0 ? `${(ksEps * 100).toFixed(1)}c` : '—') : <span className="text-gray-700 italic text-[10px]">n/a</span>}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${edgeBgClass(ksEdge)}`}>
                            {hasKalshiTicker ? (ksEdge > 0 ? fmtUsd(ksEdge) : '—') : <span className="text-gray-700 italic text-[10px]">n/a</span>}
                          </td>
                        </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
