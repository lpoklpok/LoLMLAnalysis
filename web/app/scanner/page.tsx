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
// Snapshot from kw-lol-live-predictor (one entry per active game). Used to
// override the static pre-match fair while a game is in progress.
interface LiveSnapshot {
  game_id: string
  team_a_name: string
  team_b_name: string
  blue_team_id: string | null
  red_team_id: string | null
  team_a_id: string
  team_b_id: string
  game_number: number
  state: string
  p_adj: number              // adjusted in-game win prob for blue team
  updated_ts: number
}

interface EventRef {
  team1: string
  team2: string
  best_of: number
  league: string
  mkt_t1?: number | null  // PM match-winner midpoint for team1 (series price), used for /predict ?mkt= deep-link
  date?: string           // ISO match start time — used to filter out already-started matches
}
interface EdgeRow extends EventRef {
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
// One bucket = one (event, market, outcome, venue, side). Aggregates every
// positive-edge price level so the row represents "what you'd capture if
// you took the full stack" — best, +1¢, +2¢, etc. all rolled together.
interface CumulativeEdgeRow extends EventRef {
  market_label:    string
  outcome:         string
  venue:           'pm' | 'kalshi'
  side:            'bid' | 'ask'
  best_price:      number   // top-of-book price (lowest ask / highest bid)
  best_eps:        number   // ¢/sh at top of book
  worst_price:     number   // furthest price where edge stays positive
  cum_size:        number   // total stackable size across all positive-edge levels
  cum_edge_usd:    number   // sum of (eps * size) across all positive-edge levels
  avg_eps:         number   // cum_edge_usd / cum_size — blended ¢/sh
  num_levels:      number
}
interface LiquidityRow extends EventRef {
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

// Top-tier tournaments. Everything else (LCP, CBLOL, NACL, qualifiers,
// academy/challengers) is treated as "minor" and hidden by default — the
// model has thin signal there so fair values are unreliable.
const MAJOR_LEAGUES = new Set(['LCK', 'LPL', 'LEC', 'LCS', 'EWC', 'MSI', 'Worlds', 'First Stand'])

// ELO-shift helpers for the per-event slider on event cards. Mirrors the
// /predict snap math: logit shift in 400-point ELO space, then re-derive
// series probability via the Bo3/Bo5 polynomial. Approximate because the
// model has many features beyond ELO, but a useful sanity check.
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))
const logit   = (p: number) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p))

function applyEloShift(pGame: number, deltaElo: number): number {
  return sigmoid(logit(pGame) + deltaElo * Math.log(10) / 400)
}

function pSeriesFromGame(pGame: number, bestOf: number): number {
  if (bestOf <= 1) return pGame
  const p = pGame
  if (bestOf === 3) return p * p * (3 - 2 * p)
  if (bestOf === 5) return p * p * p * (10 - 15 * p + 6 * p * p)
  return p
}

// Inverse: solve pGame such that seriesProb(pGame, bestOf) == target.
function pGameFromSeries(target: number, bestOf: number): number {
  if (bestOf <= 1) return target
  let lo = 0.0001, hi = 0.9999
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (pSeriesFromGame(mid, bestOf) < target) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

// Series distribution math — must match route.ts:seriesDistribution so the
// slider's adjusted fairs are on the same scale as the API's base fairs.
const ALPHA_G2 = 0.897
const BETA_DA  = 0.0929
function seriesDistribution(pG1: number, bestOf: number): Map<string, number> {
  const dist = new Map<string, number>()
  if (bestOf <= 1) { dist.set('t1_1', pG1); dist.set('t2_1', 1 - pG1); return dist }
  const z = Math.log(pG1 / (1 - pG1))
  const g2_t1won = 1 / (1 + Math.exp(-(ALPHA_G2 * z - BETA_DA)))
  const g2_t2won = 1 / (1 + Math.exp(-(ALPHA_G2 * z + BETA_DA)))
  const needed = Math.ceil(bestOf / 2)
  function walk(t1w: number, t2w: number, prob: number, prev: 't1' | 't2' | null) {
    if (t1w === needed) { const k = `t1_${t1w + t2w}`; dist.set(k, (dist.get(k) ?? 0) + prob); return }
    if (t2w === needed) { const k = `t2_${t1w + t2w}`; dist.set(k, (dist.get(k) ?? 0) + prob); return }
    const gnum = t1w + t2w + 1
    let p: number
    if      (gnum === 1) p = pG1
    else if (gnum === 2) p = prev === 't1' ? g2_t1won : g2_t2won
    else                 p = pG1
    walk(t1w + 1, t2w, prob * p,       't1')
    walk(t1w, t2w + 1, prob * (1 - p), 't2')
  }
  walk(0, 0, 1, null)
  return dist
}

// Like seriesDistribution but overrides game `liveGameNum` with `pLive` (the
// in-game team1 win prob from the live model). Other games use the static
// G2-shrinkage formula. Use when a specific game in the series is live and
// you want fairs to reflect the current in-game state.
function seriesDistributionLive(
  pStatic: number, bestOf: number,
  startT1Wins: number, startT2Wins: number,
  liveGameNum: number, pLive: number,
): Map<string, number> {
  const dist = new Map<string, number>()
  if (bestOf <= 1) { dist.set('t1_1', pLive); dist.set('t2_1', 1 - pLive); return dist }
  const z = Math.log(pStatic / (1 - pStatic))
  const g2_t1won = 1 / (1 + Math.exp(-(ALPHA_G2 * z - BETA_DA)))
  const g2_t2won = 1 / (1 + Math.exp(-(ALPHA_G2 * z + BETA_DA)))
  const needed = Math.ceil(bestOf / 2)
  function walk(t1w: number, t2w: number, prob: number, prev: 't1' | 't2' | null) {
    if (t1w === needed) { const k = `t1_${t1w + t2w}`; dist.set(k, (dist.get(k) ?? 0) + prob); return }
    if (t2w === needed) { const k = `t2_${t1w + t2w}`; dist.set(k, (dist.get(k) ?? 0) + prob); return }
    const gnum = t1w + t2w + 1
    let p: number
    if      (gnum === liveGameNum) p = pLive
    else if (gnum === 1)           p = pStatic
    else if (gnum === 2)           p = prev === 't1' ? g2_t1won : g2_t2won
    else                           p = pStatic
    walk(t1w + 1, t2w, prob * p,       't1')
    walk(t1w, t2w + 1, prob * (1 - p), 't2')
  }
  walk(startT1Wins, startT2Wins, 1, null)
  return dist
}

function pHandicap(dist: Map<string, number>, bestOf: number, handicapTeam1: number): number {
  const neededT1 = Math.ceil(bestOf / 2)
  let p = 0
  for (const [k, v] of dist) {
    const [winner, gamesStr] = k.split('_')
    const totalGames = parseInt(gamesStr, 10)
    let margin: number
    if (winner === 't1') {
      const t1Wins = neededT1
      const t2Wins = totalGames - t1Wins
      margin = t1Wins - t2Wins
    } else {
      const t2Wins = neededT1
      const t1Wins = totalGames - t2Wins
      margin = t1Wins - t2Wins
    }
    if (margin + handicapTeam1 > 0) p += v
  }
  return p
}

function pOverGames(dist: Map<string, number>, n: number): number {
  let p = 0
  for (const [k, v] of dist) {
    const games = parseInt(k.split('_')[1], 10)
    if (games > n) p += v
  }
  return p
}

const normName = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Does this outcome name represent the given team? Handles plain names and
// handicap-suffixed names like "JD Gaming (-1.5)". Uses otherTeam to break
// ties when one team's name is a prefix of the other.
function outcomeIsTeam(outcomeName: string, team: string, otherTeam: string): boolean {
  const o = normName(outcomeName); const t = normName(team); const ot = normName(otherTeam)
  if (o === t) return true
  return o.includes(t) && !o.includes(ot)
}

// Compute the adjusted fair for outcome[oIdx] of submarket sm, given the
// adjusted per-game prob (team1 perspective) and the resulting distribution.
// Returns null if the submarket type isn't recognized (caller falls back to API fair).
function adjustedFair(
  sm: { market_label: string; outcomes: Array<{ outcome: string }> },
  oIdx: number,
  team1: string,
  team2: string,
  bestOf: number,
  adjPGameT1: number,
  adjDist: Map<string, number>,
  liveGameNum: number | null = null,
  pLiveT1: number | null = null,
): number | null {
  const label = sm.market_label
  const out0  = sm.outcomes[0]?.outcome ?? ''
  const out0IsT1 = outcomeIsTeam(out0, team1, team2)

  if (label === 'Match Winner') {
    let pT1 = 0; for (const [k, v] of adjDist) if (k.startsWith('t1_')) pT1 += v
    const f0 = out0IsT1 ? pT1 : 1 - pT1
    return oIdx === 0 ? f0 : 1 - f0
  }
  if (label.startsWith('Game ') && label.endsWith(' Winner')) {
    // For the in-progress game, use the live per-game prob; for other games,
    // the static (ELO-adjusted) prob.
    const gameNumMatch = /Game (\d+) Winner/.exec(label)
    const gnum = gameNumMatch ? parseInt(gameNumMatch[1], 10) : null
    const useLive = liveGameNum != null && pLiveT1 != null && gnum === liveGameNum
    const pT1 = useLive ? pLiveT1 : adjPGameT1
    const f0 = out0IsT1 ? pT1 : 1 - pT1
    return oIdx === 0 ? f0 : 1 - f0
  }
  if (label.startsWith('Game Handicap')) {
    // outcome[0] now arrives as e.g. "JD Gaming (-1.5)" — paren-anchored regex
    // pulls the handicap value belonging to outcome[0].
    const m = /\(([+-]?\d+\.?\d*)\)/.exec(out0)
    const h0 = m ? parseFloat(m[1]) : (bestOf === 5 ? -2.5 : -1.5)
    const hT1 = out0IsT1 ? h0 : -h0
    const pT1 = pHandicap(adjDist, bestOf, hT1)
    const f0  = out0IsT1 ? pT1 : 1 - pT1
    return oIdx === 0 ? f0 : 1 - f0
  }
  if (label.startsWith('Total Games O/U')) {
    const m = /([\d.]+)/.exec(label)
    const threshold = m ? parseFloat(m[1]) : (bestOf === 5 ? 3.5 : 2.5)
    const pOver = pOverGames(adjDist, threshold)
    const out0IsOver = out0.toLowerCase().includes('over')
    const f0 = out0IsOver ? pOver : 1 - pOver
    return oIdx === 0 ? f0 : 1 - f0
  }
  return null
}

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

// ── Ranking table cell: matchup chip + bet line, team names link to /predict ─
function MatchupCell({ row, bet }: {
  row: EventRef & { market_label: string; outcome: string }
  bet?: { side: 'bid' | 'ask'; price: number }
}) {
  const mkt = row.mkt_t1 != null && Number.isFinite(row.mkt_t1)
    ? `&mkt=${row.mkt_t1.toFixed(4)}` : ''
  const href =
    `/predict?team1=${encodeURIComponent(row.team1)}` +
    `&team2=${encodeURIComponent(row.team2)}` +
    `&bo=${row.best_of}${mkt}`
  return (
    <td className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`text-[9px] uppercase px-1 py-0.5 rounded border ${leagueClass(row.league)}`}>{row.league}</span>
        <Link
          href={href}
          target="_blank"
          className="text-gray-200 font-medium truncate max-w-[200px] hover:text-cyan-300 hover:underline"
          title={`Open ${row.team1} vs ${row.team2} in /predict →`}
        >
          {row.team1} <span className="text-gray-600">vs</span> {row.team2}
        </Link>
        <span className="text-[9px] text-gray-500">Bo{row.best_of}</span>
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[260px]">
        <span className="text-gray-500">{row.market_label}:</span>{' '}
        <span className="text-gray-300">{row.outcome}</span>
        {bet && (
          <span className={bet.side === 'ask' ? 'text-red-400' : 'text-green-400'}>
            {' '}· {bet.side === 'ask' ? 'BUY' : 'SELL'} {fmtCent(bet.price)}
          </span>
        )}
      </div>
    </td>
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
  const [majorOnly, setMajorOnly] = useState(true)
  // Per-event relative ELO delta on team1 (in 400-point ELO units).
  // Positive = team1 stronger than model thinks. Affects the Match Winner
  // fair only (other submarkets keep the API fair).
  const [eloAdj, setEloAdj] = useState<Record<string, number>>({})
  // Live snapshots keyed by game_id, populated by SSE from kw-lol-live-predictor.
  const [liveSnaps, setLiveSnaps] = useState<Map<string, LiveSnapshot>>(new Map())
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

  // ── LoL live predictor SSE ──────────────────────────────────────────
  // Subscribes to /api/lol/live-stream → kw-lol-live-predictor /stream.
  // Each message is a GameSnapshot for one active game. We index by game_id
  // so we can look up the live state for an event in render.
  useEffect(() => {
    const es = new EventSource('/api/lol/live-stream')
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data) as LiveSnapshot
        if (!d.game_id) return
        setLiveSnaps(prev => { const n = new Map(prev); n.set(d.game_id, d); return n })
      } catch { /* swallow */ }
    }
    es.onerror = () => {}
    // Safety: also pull /live-state every 30s in case SSE quietly disconnects.
    let stopped = false
    const safety = setInterval(async () => {
      if (stopped) return
      try {
        const r = await fetch('/api/lol/live-state', { cache: 'no-store' })
        if (!r.ok) return
        const d = await r.json() as { games: Record<string, LiveSnapshot> }
        const m = new Map<string, LiveSnapshot>()
        for (const [k, v] of Object.entries(d.games ?? {})) m.set(k, v)
        if (!stopped) setLiveSnaps(m)
      } catch { /* swallow */ }
    }, 30_000)
    return () => { stopped = true; es.close(); clearInterval(safety) }
  }, [])

  // Match an event to its live snapshot by team-pair (normalize names since
  // lolesports / Polymarket / OE all have slightly different spellings).
  const liveForEvent = useMemo(() => {
    const out = new Map<string, LiveSnapshot>()
    if (liveSnaps.size === 0) return out
    for (const ev of events) {
      const e1 = normName(ev.team1); const e2 = normName(ev.team2)
      // Pick the freshest snapshot matching this team-pair.
      let best: LiveSnapshot | null = null
      for (const s of liveSnaps.values()) {
        if (s.state !== 'in_game') continue
        const a = normName(s.team_a_name); const b = normName(s.team_b_name)
        const matches =
          (a.includes(e1) && b.includes(e2)) || (b.includes(e1) && a.includes(e2)) ||
          (e1.includes(a) && e2.includes(b)) || (e1.includes(b) && e2.includes(a))
        if (matches && (!best || s.updated_ts > best.updated_ts)) best = s
      }
      if (best) out.set(ev.slug, best)
    }
    return out
  }, [liveSnaps, events])

  // ── Derive everything client-side ───────────────────────────────────
  const { rendered, allEdges, allLiquidity, leagues } = useMemo(() => {
    const allEdges: EdgeRow[] = []
    const allLiquidity: LiquidityRow[] = []
    const leagues = new Set<string>()
    const rendered = events.map(ev => {
      leagues.add(ev.league)
      let eventTotalEdge = 0
      // Pre-compute team1's PM match-winner midpoint to deep-link into /predict ?mkt=
      let mktT1: number | null = null
      const mwSm = ev.submarkets.find(sm => sm.market_label === 'Match Winner')
      const t1Tok = mwSm?.outcomes?.[0]?.token_id
      const t1Book = t1Tok ? pmBooks.get(t1Tok) : null
      if (t1Book) {
        const bid = t1Book.bids[0]?.price
        const ask = t1Book.asks[0]?.price
        if (bid != null && ask != null) mktT1 = (bid + ask) / 2
        else if (bid != null) mktT1 = bid
        else if (ask != null) mktT1 = ask
      }
      const evRef = { team1: ev.team1, team2: ev.team2, best_of: ev.best_of, league: ev.league, mkt_t1: mktT1, date: ev.date }
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
                allEdges.push({ ...evRef, market_label: sm.market_label, outcome: o.outcome, venue, side: 'ask', price: l.price, size: l.size, fair, edge_per_share: eps, total_edge_usd: totalUsd })
                if (venue === 'pm') { pmEdgeUsd += totalUsd; if (eps > pmBestEps) pmBestEps = eps }
                else                 { kalshiEdgeUsd += totalUsd; if (eps > kalshiBestEps) kalshiBestEps = eps }
              }
              for (const l of book.bids) {
                const eps = l.price - fair - feeFor(l.price)
                if (eps <= 0) break
                const totalUsd = eps * l.size
                allEdges.push({ ...evRef, market_label: sm.market_label, outcome: o.outcome, venue, side: 'bid', price: l.price, size: l.size, fair, edge_per_share: eps, total_edge_usd: totalUsd })
                if (venue === 'pm') { pmEdgeUsd += totalUsd; if (eps > pmBestEps) pmBestEps = eps }
                else                 { kalshiEdgeUsd += totalUsd; if (eps > kalshiBestEps) kalshiBestEps = eps }
              }
            }
            const bid = book.bids[0]
            if (bid) {
              const plus1 = book.bids.find(l => Math.abs(l.price - (bid.price - 0.01)) < 0.005)
              allLiquidity.push({ ...evRef, market_label: sm.market_label, outcome: o.outcome, venue, side: 'bid', best_price: bid.price, best_size: bid.size, plus1_size: plus1?.size ?? 0, notional_usd: bid.size * bid.price + (plus1?.size ?? 0) * (bid.price - 0.01) })
            }
            const ask = book.asks[0]
            if (ask) {
              const plus1 = book.asks.find(l => Math.abs(l.price - (ask.price + 0.01)) < 0.005)
              allLiquidity.push({ ...evRef, market_label: sm.market_label, outcome: o.outcome, venue, side: 'ask', best_price: ask.price, best_size: ask.size, plus1_size: plus1?.size ?? 0, notional_usd: ask.size * ask.price + (plus1?.size ?? 0) * (ask.price + 0.01) })
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
  // Already-started events with NO live data clog up the view (pre-match
  // model fair is unreliable once a game starts). Keep them only when we
  // have a live snapshot for the matchup — then fairs come from the live
  // predictor and the event is still actionable.
  const isPreMatchOrLive = (slug: string | undefined, date?: string) => {
    if (!date) return true
    if (new Date(date).getTime() > Date.now()) return true
    return slug != null && liveForEvent.has(slug)
  }
  const isPreMatch = (date?: string) => isPreMatchOrLive(undefined, date)

  const visibleEvents = useMemo(() => {
    return rendered
      .filter(ev => isPreMatchOrLive(ev.slug, ev.date))
      .filter(ev => !majorOnly || MAJOR_LEAGUES.has(ev.league))
      .filter(ev => leagueFilter.size === 0 || leagueFilter.has(ev.league))
      .filter(ev => !search || ev.title.toLowerCase().includes(search.toLowerCase()))
      .filter(ev => ev.total_edge_usd >= minEdge)
      // Soonest first — the next match to play sits at the top of the page.
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  }, [rendered, leagueFilter, search, minEdge, majorOnly])

  // Cumulative per (event, market, outcome, venue, side). One row per bucket,
  // aggregated across every positive-edge price level (BBO + penny-through +
  // deeper). Ranked by total $ you'd capture if you took the full stack.
  const cumulativeEdges = useMemo(() => {
    const groups = new Map<string, CumulativeEdgeRow>()
    for (const e of allEdges) {
      if (!isPreMatch(e.date)) continue
      if (majorOnly && !MAJOR_LEAGUES.has(e.league)) continue
      if (venueFilter !== 'all' && e.venue !== venueFilter) continue
      const k = `${e.team1}|${e.team2}|${e.market_label}|${e.outcome}|${e.venue}|${e.side}`
      const existing = groups.get(k)
      if (!existing) {
        groups.set(k, {
          team1: e.team1, team2: e.team2, best_of: e.best_of, league: e.league, mkt_t1: e.mkt_t1,
          market_label: e.market_label, outcome: e.outcome, venue: e.venue, side: e.side,
          best_price: e.price, best_eps: e.edge_per_share,
          worst_price: e.price,
          cum_size: e.size, cum_edge_usd: e.total_edge_usd, avg_eps: e.edge_per_share, num_levels: 1,
        })
      } else {
        // For ASK (BUY): best = lowest price, worst = highest you'd still take.
        // For BID (SELL): best = highest price, worst = lowest you'd still take.
        if (e.side === 'ask') {
          if (e.price < existing.best_price) { existing.best_price = e.price; existing.best_eps = e.edge_per_share }
          if (e.price > existing.worst_price) existing.worst_price = e.price
        } else {
          if (e.price > existing.best_price) { existing.best_price = e.price; existing.best_eps = e.edge_per_share }
          if (e.price < existing.worst_price) existing.worst_price = e.price
        }
        existing.cum_size     += e.size
        existing.cum_edge_usd += e.total_edge_usd
        existing.num_levels   += 1
      }
    }
    // Compute blended avg ¢/sh per bucket, filter by minEdge, rank, cap at 30.
    return Array.from(groups.values())
      .map(g => ({ ...g, avg_eps: g.cum_size > 0 ? g.cum_edge_usd / g.cum_size : 0 }))
      .filter(g => g.cum_edge_usd >= minEdge)
      .sort((a, b) => b.cum_edge_usd - a.cum_edge_usd)
      .slice(0, 30)
  }, [allEdges, venueFilter, minEdge, majorOnly])
  const substantialEdges = useMemo(
    () => [...allEdges]
      .filter(e => isPreMatch(e.date))
      .filter(e => !majorOnly || MAJOR_LEAGUES.has(e.league))
      .filter(e => e.size >= minTradeSize)
      .filter(e => venueFilter === 'all' || e.venue === venueFilter)
      .filter(e => e.total_edge_usd >= minEdge)
      .sort((a, b) => b.edge_per_share - a.edge_per_share)
      .slice(0, 30),
    [allEdges, minTradeSize, venueFilter, minEdge, majorOnly],
  )
  const filteredLiquidity = useMemo(
    () => allLiquidity
      .filter(r => isPreMatch(r.date))
      .filter(r => !majorOnly || MAJOR_LEAGUES.has(r.league))
      .filter(r => venueFilter === 'all' || r.venue === venueFilter)
      .slice(0, 30),
    [allLiquidity, venueFilter, majorOnly],
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
        <button onClick={() => setMajorOnly(v => !v)}
                className={`px-2 py-1 rounded border text-[10px] uppercase tracking-wide font-semibold transition ${
                  majorOnly ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' : 'bg-transparent text-gray-500 border-gray-800'
                }`}
                title="Hide minor leagues (LCP, CBLOL, NACL, qualifiers, academy). Model has weak signal there.">
          {majorOnly ? 'Major only ✓' : 'All leagues'}
        </button>
        <div className="h-5 w-px bg-gray-800 mx-1" />
        <span className="text-gray-500">League:</span>
        {Array.from(leagues).sort().filter(l => !majorOnly || MAJOR_LEAGUES.has(l)).map(l => (
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
            <span className="text-xs uppercase tracking-wide text-amber-300 font-semibold">Top Edge ($) · cumulative</span>
            <span className="text-[10px] text-gray-600">{cumulativeEdges.length} buckets</span>
            <span className="text-[10px] text-gray-700 ml-auto" title="Each row aggregates every positive-edge level for that (event, market, outcome, venue, side). 'BBO' is the top-of-book price. 'Stack' is total size you could take across all positive-edge levels.">stack = BBO + penny-through + deeper</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-900 text-gray-500 sticky top-0 z-10">
                <tr className="border-b border-gray-800">
                  <th className="px-2 py-1.5 text-left font-normal">Matchup · Bet</th>
                  <th className="px-2 py-1.5 text-right font-normal">Venue</th>
                  <th className="px-2 py-1.5 text-right font-normal" title="Top-of-book price (best ask if buying, best bid if selling)">BBO</th>
                  <th className="px-2 py-1.5 text-right font-normal" title="Worst price you'd still take — beyond this, edge turns negative">→</th>
                  <th className="px-2 py-1.5 text-right font-normal" title="Total stackable size across all positive-edge levels">Stack</th>
                  <th className="px-2 py-1.5 text-right font-normal text-amber-300" title="Blended (size-weighted) ¢/sh across all stacked levels">Avg ¢/sh</th>
                  <th className="px-2 py-1.5 text-right font-normal" title="Total $ captured if you took the full stack at your model's fair">Edge $</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {cumulativeEdges.length === 0 && (
                  <tr><td colSpan={7} className="px-2 py-4 text-center text-gray-600">No edge above filter. Lower the Min edge threshold.</td></tr>
                )}
                {cumulativeEdges.map((e, i) => (
                  <tr key={i} className="hover:bg-gray-900/60 transition">
                    <MatchupCell row={e} bet={{ side: e.side, price: e.best_price }} />
                    <td className="px-2 py-1.5 text-right">
                      <span className={`text-[10px] uppercase font-semibold ${e.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}`}>{e.venue}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-300">{fmtCent(e.best_price)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-500" title={`${e.num_levels} level${e.num_levels === 1 ? '' : 's'} of positive edge`}>
                      {e.num_levels > 1 ? fmtCent(e.worst_price) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-gray-400">{fmtSize(e.cum_size)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${epsBgClass(e.avg_eps)}`}>
                      {(e.avg_eps * 100).toFixed(1)}c
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono font-semibold ${edgeBgClass(e.cum_edge_usd)}`}>
                      {fmtUsd(e.cum_edge_usd)}
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
                  <th className="px-2 py-1.5 text-left font-normal">Matchup · Bet</th>
                  <th className="px-2 py-1.5 text-right font-normal">Venue · Side</th>
                  <th className="px-2 py-1.5 text-right font-normal">Best</th>
                  <th className="px-2 py-1.5 text-right font-normal">+1¢</th>
                  <th className="px-2 py-1.5 text-right font-normal">Notional</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {filteredLiquidity.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-900/60 transition">
                    <MatchupCell row={r} />
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
            <span className="text-xs uppercase tracking-wide text-emerald-300 font-semibold">Best ¢/sh</span>
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
                  <th className="px-2 py-1.5 text-left font-normal">Matchup · Bet</th>
                  <th className="px-2 py-1.5 text-right font-normal">Venue</th>
                  <th className="px-2 py-1.5 text-right font-normal">Sz</th>
                  <th className="px-2 py-1.5 text-right font-normal text-amber-300">¢/sh</th>
                  <th className="px-2 py-1.5 text-right font-normal">Edge $</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900">
                {substantialEdges.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-4 text-center text-gray-600">
                    No edges with size ≥ {minTradeSize}. Lower the threshold or wait for thicker books.
                  </td></tr>
                )}
                {substantialEdges.map((e, i) => (
                  <tr key={i} className="hover:bg-gray-900/60 transition">
                    <MatchupCell row={e} bet={{ side: e.side, price: e.price }} />
                    <td className="px-2 py-1.5 text-right">
                      <span className={`text-[10px] uppercase font-semibold ${e.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}`}>{e.venue}</span>
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
          // Per-event ELO shift (Δ on team1 in 400-point units). Affects Match Winner only.
          const delta = eloAdj[ev.slug] ?? 0
          // Base per-game prob from team1's perspective.
          const baseGameT1 = ev.pred_blue_win == null
            ? null
            : (ev.pred_blue_team === ev.team1 ? ev.pred_blue_win : 1 - ev.pred_blue_win)
          const adjGameT1   = baseGameT1 == null ? null : applyEloShift(baseGameT1, delta)
          const adjSeriesT1 = adjGameT1   == null ? null : pSeriesFromGame(adjGameT1, ev.best_of)
          // Live overlay: if there's a matching live game from kw-lol-live-predictor,
          // substitute its in-game prob for the current game in the series
          // distribution. Other games (G2+, or G1 if live game is G2/3) use the
          // static (ELO-adjusted) per-game prob.
          const liveSnap = liveForEvent.get(ev.slug)
          let pLiveT1: number | null = null
          if (liveSnap && adjGameT1 != null) {
            const blueId = liveSnap.blue_team_id
            const blueIsA = blueId !== null ? blueId === liveSnap.team_a_id : true
            const blueName = blueIsA ? liveSnap.team_a_name : liveSnap.team_b_name
            const t1IsBlue = normName(ev.team1).includes(normName(blueName)) ||
                             normName(blueName).includes(normName(ev.team1))
            pLiveT1 = t1IsBlue ? liveSnap.p_adj : 1 - liveSnap.p_adj
          }
          // V1 scope: handle only the case where the LIVE GAME IS GAME 1
          // (series score 0-0). For game 2+ live we'd need to infer prior
          // game winners from PM mids — TODO. Falls back to static dist.
          const isLiveG1 = liveSnap?.state === 'in_game' && liveSnap?.game_number === 1
          const adjDist     = adjGameT1 == null
            ? null
            : (isLiveG1 && pLiveT1 != null
              ? seriesDistributionLive(adjGameT1, ev.best_of, 0, 0, 1, pLiveT1)
              : seriesDistribution(adjGameT1, ev.best_of))
          // Find team1's PM match-winner midpoint to enable Snap-to-market.
          const mwSm = ev.submarkets.find(sm => sm.market_label === 'Match Winner')
          const mwT1Out = mwSm?.outcomes?.[0]  // outcome[0] is team1
          const pmBid = mwT1Out?.pm_best?.bid?.price
          const pmAsk = mwT1Out?.pm_best?.ask?.price
          const pmMidT1 = pmBid != null && pmAsk != null ? (pmBid + pmAsk) / 2 : (pmBid ?? pmAsk ?? null)
          const snapDelta = (baseGameT1 != null && pmMidT1 != null)
            ? Math.round(((400 / Math.log(10)) * (logit(pGameFromSeries(pmMidT1, ev.best_of)) - logit(baseGameT1))))
            : null
          return (
            <div key={ev.slug} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <button onClick={() => toggleCollapsed(ev.slug)} className="w-full px-4 py-3 border-b border-gray-800 flex items-center gap-3 hover:bg-gray-900/80 transition">
                <span className="text-gray-500 w-3 text-center">{isCollapsed ? '▸' : '▾'}</span>
                <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${leagueClass(ev.league)}`}>{ev.league}</span>
                <span className="text-[10px] text-gray-500">Bo{ev.best_of}</span>
                {ev.date && (() => {
                  const t = new Date(ev.date)
                  const now = Date.now()
                  const diffMs = t.getTime() - now
                  const past = diffMs < 0
                  const absMin = Math.round(Math.abs(diffMs) / 60000)
                  const rel = absMin < 60   ? `${absMin}m`
                            : absMin < 1440 ? `${Math.round(absMin / 60)}h`
                            :                 `${Math.round(absMin / 1440)}d`
                  const fmt = t.toLocaleString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                  return (
                    <span className="text-[10px] font-mono text-gray-500" title={fmt}>
                      {past ? `${rel} ago` : `in ${rel}`}
                    </span>
                  )
                })()}
                <span className="text-sm font-medium text-gray-100">{ev.team1} <span className="text-gray-600 mx-1">vs</span> {ev.team2}</span>
                {liveSnap && (
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-900/60 text-red-300 border border-red-700/40 font-bold"
                        title={`Live: G${liveSnap.game_number}, p_adj=${(liveSnap.p_adj*100).toFixed(1)}% on ${liveSnap.team_a_name === ev.team1 || liveSnap.team_b_name === ev.team1 ? 'blue side' : 'opp side'}`}>
                    🔴 LIVE G{liveSnap.game_number}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3 text-[11px]">
                  <span className="text-gray-500">
                    G1 prior <span className="text-gray-300 font-mono">{fmtCent(baseGameT1)}</span>
                    {delta !== 0 && adjGameT1 != null && (
                      <> <span className="text-amber-300">→ {fmtCent(adjGameT1)}</span></>
                    )}
                  </span>
                  {pmMidT1 != null && (
                    <span className="text-gray-500">PM mid <span className="text-blue-300 font-mono">{fmtCent(pmMidT1)}</span></span>
                  )}
                  {ev.total_edge_usd > 0 && (
                    <span className={`px-2 py-0.5 rounded-md font-semibold font-mono ${edgeBgClass(ev.total_edge_usd)}`}>
                      Total edge {fmtUsd(ev.total_edge_usd)}
                    </span>
                  )}
                </span>
              </button>

              {/* ELO slider strip — only render when expanded to save vertical space */}
              {!isCollapsed && (
                <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/40 flex items-center gap-3 text-[11px]">
                  <span className="text-gray-500 uppercase tracking-wide text-[10px]">ELO Δ {ev.team1} (vs {ev.team2}):</span>
                  <input type="range" min={-300} max={300} step={10} value={delta}
                         onChange={e => setEloAdj(s => ({ ...s, [ev.slug]: parseInt(e.target.value) }))}
                         className="flex-1 accent-emerald-500" />
                  <input type="number" step={10} value={delta}
                         onChange={e => setEloAdj(s => ({ ...s, [ev.slug]: parseInt(e.target.value) || 0 }))}
                         className="w-16 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 font-mono text-right text-gray-200" />
                  {delta !== 0 && (
                    <button onClick={() => setEloAdj(s => { const n = { ...s }; delete n[ev.slug]; return n })}
                            className="text-[10px] text-gray-500 hover:text-gray-300">reset</button>
                  )}
                  {snapDelta != null && Math.abs(snapDelta - delta) > 2 && (
                    <button onClick={() => setEloAdj(s => ({ ...s, [ev.slug]: snapDelta }))}
                            className="text-[10px] uppercase tracking-wide px-2 py-1 rounded bg-amber-600/20 text-amber-300 hover:bg-amber-600/30 border border-amber-700/40"
                            title={`Apply ${snapDelta >= 0 ? '+' : ''}${snapDelta} ELO to ${ev.team1} so Match Winner fair matches the PM midpoint (${(pmMidT1!*100).toFixed(1)}%). Approximation.`}>
                      Snap → PM ({snapDelta >= 0 ? '+' : ''}{snapDelta})
                    </button>
                  )}
                  <span className="text-gray-600 text-[10px]">recomputes all submarkets</span>
                </div>
              )}

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
                        // Recompute fair when EITHER:
                        //   - ELO slider is shifted (delta != 0), OR
                        //   - A live game is in progress (pLiveT1 set via SSE)
                        // adjDist already reflects live distribution when isLiveG1.
                        const hasLive = pLiveT1 != null && isLiveG1
                        const overrideFair = ((delta !== 0 || hasLive) && adjGameT1 != null && adjDist != null)
                          ? adjustedFair(sm, oIdx, ev.team1, ev.team2, ev.best_of, adjGameT1, adjDist,
                                         hasLive ? liveSnap!.game_number : null, pLiveT1)
                          : null
                        const fairDisp = overrideFair ?? o.fair
                        return (
                        <tr key={`${smIdx}-${oIdx}`} className={oIdx === 0 ? 'bg-gray-900/40' : ''}>
                          <td className="px-3 py-2 text-gray-400">{oIdx === 0 ? sm.market_label : ''}</td>
                          <td className="px-3 py-2 text-gray-200">{o.outcome}</td>
                          <td className="px-3 py-2 text-right font-mono text-amber-300 font-semibold">
                            {fmtCent(fairDisp)}
                            {overrideFair != null && o.fair != null && (
                              <span className="ml-1 text-[9px] text-gray-500">(was {fmtCent(o.fair)})</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right border-l border-gray-800">
                            <BookCell best={o.pm_best} fair={fairDisp} side="bid" venue="pm" hasTicker={true} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <BookCell best={o.pm_best} fair={fairDisp} side="ask" venue="pm" hasTicker={true} />
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${epsBgClass(pmEps)}`}>
                            {pmEps > 0 ? `${(pmEps * 100).toFixed(1)}c` : '—'}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${edgeBgClass(pmEdge)}`}>
                            {pmEdge > 0 ? fmtUsd(pmEdge) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right border-l border-gray-800">
                            <BookCell best={o.kalshi_best} fair={fairDisp} side="bid" venue="kalshi" hasTicker={hasKalshiTicker} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <BookCell best={o.kalshi_best} fair={fairDisp} side="ask" venue="kalshi" hasTicker={hasKalshiTicker} />
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
