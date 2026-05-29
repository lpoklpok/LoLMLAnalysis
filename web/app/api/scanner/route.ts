// Server-side scanner aggregator.
//
// For every upcoming/live LoL event with a Polymarket slug, fetches the full
// submarket detail (PM mids + Kalshi sides), pulls bid/ask SIZES from each
// venue's book endpoint, computes a per-outcome fair value from the static
// pre-game prior, and ranks the opportunities by total available $ PnL
// against the resting book (assuming our fair holds).
// Also ranks the top-of-book liquidity (best price + 1¢ deeper) by notional.
//
// Fair values computed:
//   - match_winner         → seriesProb(pG1, bestOf)
//   - game_N_winner        → pG1 (no shrinkage applied per game for v1)
//   - game_handicap        → pHandicap over full series distribution
//   - games_total_X.Y      → pOverGames over full series distribution
//
// Cached server-side for 10s (so the page can poll at any rate without
// blowing the upstream APIs).

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 0  // we cache manually below to avoid stale 5xx upstreams

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? ''
const KALSHI_WORKER_URL = process.env.KALSHI_WORKER_URL ?? ''
const RELAY_SECRET      = process.env.RELAY_SECRET ?? ''
const ORIGIN            = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'

// ── Cache ────────────────────────────────────────────────────────────────
let CACHE: { ts: number; data: ScannerResponse | null } = { ts: 0, data: null }
const CACHE_TTL_MS = 10_000

// ── Types ────────────────────────────────────────────────────────────────
type Side = 'bid' | 'ask'
type Venue = 'pm' | 'kalshi'

interface BookLevel { price: number; size: number }
interface OutcomeBook { bids: BookLevel[]; asks: BookLevel[] }
interface OutcomeView {
  outcome:           string
  fair:              number | null
  token_id:          string | null
  kalshi_ticker:     string | null
  kalshi_opp_ticker: string | null
  pm:                OutcomeBook | null
  kalshi:            OutcomeBook | null
  // Best price snapshots for fast UI render
  pm_best:     { bid: BookLevel | null; ask: BookLevel | null } | null
  kalshi_best: { bid: BookLevel | null; ask: BookLevel | null } | null
}
interface SubmarketView {
  market_type:   string
  market_label:  string
  outcomes:      OutcomeView[]
}
interface EventView {
  slug:           string
  title:          string
  league:         string
  team1:          string
  team2:          string
  best_of:        number
  pred_blue_win:  number | null
  pred_blue_team: string
  date:           string
  submarkets:     SubmarketView[]
}
interface EdgeRow {
  event_slug:    string
  event_title:   string
  market_label:  string
  outcome:       string
  venue:         Venue
  side:          Side
  price:         number
  size:          number
  fair:          number
  edge_per_share: number
  total_edge_usd: number
}
interface LiquidityRow {
  event_slug:    string
  event_title:   string
  market_label:  string
  outcome:       string
  venue:         Venue
  side:          Side
  best_price:    number
  best_size:     number
  plus1_size:    number
  notional_usd:  number  // best_size * best_price + plus1_size * (best_price ± 0.01)
}
interface ScannerResponse {
  events:         EventView[]
  top_edges:      EdgeRow[]
  top_liquidity:  LiquidityRow[]
  // Raw per-ticker Kalshi books, so the client can seed kalshiBooks Map on
  // first paint instead of waiting for SSE messages to arrive.
  kalshi_raw_books: Record<string, OutcomeBook>
  generated_at:   number
  ms_elapsed:     number
}

// Kalshi fee per share (their published formula):
//   fee = ceil(0.07 * size * price * (1 - price), nearest cent), floored at $0.01/contract
// Per-share is just 0.07 * p * (1-p), floored at 0.01.
export function kalshiFeePerShare(price: number): number {
  if (price <= 0 || price >= 1) return 0
  return Math.max(0.01, 0.07 * price * (1 - price))
}

// ── Math: series distribution with draft-aware shrinkage (matches /trader) ─
const ALPHA_G2 = 0.897
const BETA_DA  = 0.0929

// Returns full joint distribution: key = "<t1|t2>_<totalGames>",
// value = probability of that exact ending. Used to derive series winner,
// game-handicap fairs (=margin of victory), and Over/Under N-games fairs.
function seriesDistribution(pG1: number, bestOf: number): Map<string, number> {
  const dist = new Map<string, number>()
  if (bestOf <= 1) {
    dist.set('t1_1', pG1)
    dist.set('t2_1', 1 - pG1)
    return dist
  }
  const z = Math.log(pG1 / (1 - pG1))
  const g2_t1won = 1 / (1 + Math.exp(-(ALPHA_G2 * z - BETA_DA)))
  const g2_t2won = 1 / (1 + Math.exp(-(ALPHA_G2 * z + BETA_DA)))
  const g3plus   = pG1   // matches /trader simplification — no further shrinkage for G3+
  const needed   = Math.ceil(bestOf / 2)
  function walk(t1w: number, t2w: number, prob: number, prev: 't1' | 't2' | null) {
    if (t1w === needed) {
      const k = `t1_${t1w + t2w}`; dist.set(k, (dist.get(k) ?? 0) + prob); return
    }
    if (t2w === needed) {
      const k = `t2_${t1w + t2w}`; dist.set(k, (dist.get(k) ?? 0) + prob); return
    }
    const gnum = t1w + t2w + 1
    let p: number
    if      (gnum === 1) p = pG1
    else if (gnum === 2) p = prev === 't1' ? g2_t1won : g2_t2won
    else                 p = g3plus
    walk(t1w + 1, t2w, prob * p,       't1')
    walk(t1w, t2w + 1, prob * (1 - p), 't2')
  }
  walk(0, 0, 1, null)
  return dist
}

function seriesProb(pG1: number, bestOf: number): number {
  const d = seriesDistribution(pG1, bestOf)
  let p = 0
  for (const [k, v] of d) if (k.startsWith('t1_')) p += v
  return p
}

// Handicap = team1 must win series by at least |H| game margin. team1 -1.5 in
// Bo3 means 2-0. team2 +1.5 means t2 can lose ≤ 0-2 (i.e., NOT a 2-0 t1 sweep).
// Returns P(team1 covers handicap H), assuming standard convention where
// negative H means team1 favoured.
function pHandicap(dist: Map<string, number>, bestOf: number, handicapTeam1: number): number {
  const neededT1 = Math.ceil(bestOf / 2)
  let p = 0
  for (const [k, v] of dist) {
    const [winner, gamesStr] = k.split('_')
    const totalGames = parseInt(gamesStr, 10)
    if (winner === 't1') {
      const t1Wins = neededT1
      const t2Wins = totalGames - t1Wins
      const margin = t1Wins - t2Wins  // positive
      if (margin + handicapTeam1 > 0) p += v
    } else {
      const t2Wins = neededT1
      const t1Wins = totalGames - t2Wins
      const margin = t1Wins - t2Wins  // negative
      if (margin + handicapTeam1 > 0) p += v
    }
  }
  return p
}

// Over N games: total games strictly greater than N.
function pOverGames(dist: Map<string, number>, n: number): number {
  let p = 0
  for (const [k, v] of dist) {
    const games = parseInt(k.split('_')[1], 10)
    if (games > n) p += v
  }
  return p
}

const _norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// ── Upstream fetchers ───────────────────────────────────────────────────
interface TraderEventResp {
  slug:       string
  title:      string
  team1:      string
  team2:      string
  best_of:    number
  submarkets: Array<{
    market_type:   string
    question:      string
    outcomes:      [string, string]
    outcome_mids:  [number | null, number | null]
    outcome_bids:  [number | null, number | null]
    outcome_asks:  [number | null, number | null]
    token_ids:     [string | null, string | null]
    kalshi_sides:  Array<{ ticker: string; team: string } | null> | null
  }>
}

async function fetchTraderEvent(slug: string): Promise<TraderEventResp | null> {
  try {
    const r = await fetch(`${ORIGIN}/api/trader-event?slug=${encodeURIComponent(slug)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    return await r.json() as TraderEventResp
  } catch { return null }
}

// Polymarket batched book fetch — POST /books with token list. Returns the
// best ~10 levels per side. We only keep the top 2 levels for the scanner.
async function fetchPmBooks(tokenIds: string[]): Promise<Map<string, OutcomeBook>> {
  const out = new Map<string, OutcomeBook>()
  if (tokenIds.length === 0) return out
  // Polymarket /books endpoint accepts batches; cap at 50 per request to be safe.
  const chunks: string[][] = []
  for (let i = 0; i < tokenIds.length; i += 50) chunks.push(tokenIds.slice(i, i + 50))
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const body = chunk.map(token_id => ({ token_id }))
      const r = await fetch('https://clob.polymarket.com/books', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(6000),
      })
      if (!r.ok) return
      const arr = await r.json() as Array<{
        asset_id: string
        bids?: Array<{ price: string; size: string }>
        asks?: Array<{ price: string; size: string }>
      }>
      for (const b of arr) {
        const tid = b.asset_id
        const bids = (b.bids ?? [])
          .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
          .filter(l => Number.isFinite(l.price) && l.size > 0)
          .sort((a, b) => b.price - a.price)  // best bid first (highest)
        const asks = (b.asks ?? [])
          .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
          .filter(l => Number.isFinite(l.price) && l.size > 0)
          .sort((a, b) => a.price - b.price)  // best ask first (lowest)
        out.set(tid, { bids, asks })
      }
    } catch { /* swallow per-chunk errors */ }
  }))
  return out
}

// Kalshi book fetch — proxy to our Fly worker. One request per ticker.
async function fetchKalshiBooks(tickers: string[]): Promise<Map<string, OutcomeBook>> {
  const out = new Map<string, OutcomeBook>()
  if (!KALSHI_WORKER_URL || !RELAY_SECRET || tickers.length === 0) return out
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const r = await fetch(`${KALSHI_WORKER_URL}/book?ticker=${encodeURIComponent(ticker)}`, {
        headers: { 'X-Relay-Auth': RELAY_SECRET },
        cache:   'no-store',
        signal:  AbortSignal.timeout(3000),
      })
      if (!r.ok) return
      const d = await r.json() as { bids?: [number, number][]; asks?: [number, number][] }
      const bids = (d.bids ?? [])
        .map(([p, sz]) => ({ price: p, size: sz }))
        .filter(l => l.size > 0)
        .sort((a, b) => b.price - a.price)
      const asks = (d.asks ?? [])
        .map(([p, sz]) => ({ price: p, size: sz }))
        .filter(l => l.size > 0)
        .sort((a, b) => a.price - b.price)
      out.set(ticker, { bids, asks })
    } catch { /* swallow */ }
  }))
  return out
}

// Combine team1-YES + team2-YES Kalshi books into a single book in team1's
// price space (matches the trader page ladder math). Team2 inverts:
//   team2 bids at $q → team1 asks at $(1−q)
//   team2 asks at $q → team1 bids at $(1−q)
function combineKalshi(team1Book: OutcomeBook | undefined, team2Book: OutcomeBook | undefined): OutcomeBook {
  const bids = new Map<number, number>()
  const asks = new Map<number, number>()
  const r2 = (p: number) => Math.round(p * 100) / 100
  for (const l of team1Book?.bids ?? []) {
    const k = r2(l.price); bids.set(k, (bids.get(k) ?? 0) + l.size)
  }
  for (const l of team1Book?.asks ?? []) {
    const k = r2(l.price); asks.set(k, (asks.get(k) ?? 0) + l.size)
  }
  for (const l of team2Book?.asks ?? []) {
    const k = r2(1 - l.price); bids.set(k, (bids.get(k) ?? 0) + l.size)
  }
  for (const l of team2Book?.bids ?? []) {
    const k = r2(1 - l.price); asks.set(k, (asks.get(k) ?? 0) + l.size)
  }
  return {
    bids: Array.from(bids, ([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price),
    asks: Array.from(asks, ([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price),
  }
}

// ── Main handler ─────────────────────────────────────────────────────────
export async function GET(): Promise<Response> {
  if (CACHE.data && Date.now() - CACHE.ts < CACHE_TTL_MS) {
    return NextResponse.json(CACHE.data)
  }
  const t0 = Date.now()
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const sb = createClient(SB_URL, SB_KEY)

  // 1. Pull upcoming predictions for the next 48h (skip far-future + past).
  const nowIso = new Date().toISOString()
  const futureIso = new Date(Date.now() + 48 * 3600 * 1000).toISOString()
  const { data: preds } = await sb
    .from('upcoming_predictions')
    .select('blue_team,red_team,league,best_of,pred_blue_win,date,poly_event_slug')
    .gte('date', new Date(Date.now() - 6 * 3600 * 1000).toISOString())
    .lte('date', futureIso)
    .order('date', { ascending: true })

  const eventRows = (preds ?? []).filter(p => p.poly_event_slug)
  if (eventRows.length === 0) {
    const empty: ScannerResponse = { events: [], top_edges: [], top_liquidity: [], kalshi_raw_books: {}, generated_at: Date.now(), ms_elapsed: Date.now() - t0 }
    CACHE = { ts: Date.now(), data: empty }
    return NextResponse.json(empty)
  }

  // 2. Fetch each event's detail in parallel via the existing trader-event route.
  const details = await Promise.all(eventRows.map(p => fetchTraderEvent(p.poly_event_slug!)))

  // 3. Collect every PM token + Kalshi ticker we'll need.
  const allTokens  = new Set<string>()
  const allTickers = new Set<string>()
  for (const d of details) {
    if (!d) continue
    for (const sm of d.submarkets) {
      for (const t of sm.token_ids) if (t) allTokens.add(t)
      for (const ks of sm.kalshi_sides ?? []) if (ks?.ticker) allTickers.add(ks.ticker)
    }
  }
  const [pmBooks, kalshiBooks] = await Promise.all([
    fetchPmBooks([...allTokens]),
    fetchKalshiBooks([...allTickers]),
  ])

  // 4. Build event views + compute fair + edges + liquidity rows.
  const events: EventView[] = []
  const edges: EdgeRow[] = []
  const liquidity: LiquidityRow[] = []

  for (let i = 0; i < eventRows.length; i++) {
    const pred = eventRows[i]
    const d    = details[i]
    if (!d) continue

    const pBlue = pred.pred_blue_win ?? null
    const submarkets: SubmarketView[] = []

    // Precompute the series distribution once per event — used for handicap
    // + O/U fair values. Series math is from team1's POV (= Polymarket
    // outcome[0] of game-winner markets; for handicap markets we re-map
    // when team1IsBlue is false).
    const pT1G1 = pBlue != null
      ? (_norm(d.team1) === _norm(pred.blue_team) ? pBlue : 1 - pBlue)
      : null
    const seriesDist = pT1G1 != null ? seriesDistribution(pT1G1, pred.best_of) : null

    for (const sm of d.submarkets) {
      // Map outcome[0] to team1's perspective vs pred.blue_team
      const team1IsBlue = _norm(sm.outcomes[0]) === _norm(pred.blue_team)
      let fv1: number | null = null
      let label = sm.question

      if (sm.market_type === 'match_winner' && pBlue != null) {
        label = 'Match Winner'
        const pT1Game = team1IsBlue ? pBlue : 1 - pBlue
        fv1 = seriesProb(pT1Game, pred.best_of)
      } else if (sm.market_type.startsWith('game_') && sm.market_type.endsWith('_winner') && pBlue != null) {
        const gnum = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
        label = `Game ${gnum} Winner`
        fv1 = team1IsBlue ? pBlue : 1 - pBlue
      } else if (sm.market_type === 'game_handicap' && seriesDist) {
        // Question is "Game Handicap: T1 (-1.5) vs BNK FEARX (+1.5)". The
        // handicap value is always in parentheses; without the paren-anchor
        // a naive `[+-]?\d+` regex grabs the "1" from "T1" instead of "-1.5".
        label = 'Game Handicap'
        const m = /\(([+-]?\d+\.?\d*)\)/.exec(sm.question)
        const h0 = m ? parseFloat(m[1]) : (pred.best_of === 5 ? -2.5 : -1.5)
        // h0 is the handicap of outcome[0]. We need P(outcome[0] covers).
        // If outcome[0] is the original DB team1 (= our seriesDist team1), use directly.
        // Otherwise the handicap belongs to "other team" — translate.
        const team1Side1 = _norm(sm.outcomes[0])
        const oeT1Side    = _norm(d.team1)
        const handicapForOurT1 = team1Side1 === oeT1Side ? h0 : -h0
        const pOurT1 = pHandicap(seriesDist, pred.best_of, handicapForOurT1)
        // outcome[0]_is_our_t1 → fv1 = pOurT1; else fv1 = 1 - pOurT1
        fv1 = team1Side1 === oeT1Side ? pOurT1 : 1 - pOurT1
      } else if (sm.market_type.startsWith('games_total_') && seriesDist) {
        // Outcomes are typically ["Over", "Under"] for a stated threshold.
        const m = /(\d+\.?\d*)/.exec(sm.market_type.replace('games_total_', ''))
        const threshold = m ? parseFloat(m[1]) : (pred.best_of === 5 ? 3.5 : 2.5)
        label = `Total Games O/U ${threshold}`
        const pOver = pOverGames(seriesDist, threshold)
        // outcomes order varies; check first outcome label
        fv1 = sm.outcomes[0].toLowerCase().includes('over') ? pOver : 1 - pOver
      }
      const fv2 = fv1 != null ? 1 - fv1 : null

      // Build per-outcome views with books + best-level snapshots
      const outcomeViews: OutcomeView[] = sm.outcomes.map((name, idx) => {
        const fair = idx === 0 ? fv1 : fv2
        const tid = sm.token_ids[idx]
        const pmBook = tid ? pmBooks.get(tid) ?? null : null
        const pmBest = pmBook ? {
          bid: pmBook.bids[0] ?? null,
          ask: pmBook.asks[0] ?? null,
        } : null

        // Kalshi book is COMBINED across team1-YES + team2-YES tickers.
        // The combined book represents the price for THIS outcome in YES-space.
        let kalshiBook: OutcomeBook | null = null
        let kalshiBest: { bid: BookLevel | null; ask: BookLevel | null } | null = null
        const ksTicker     = sm.kalshi_sides?.[idx]?.ticker
        const ksOppTicker  = sm.kalshi_sides?.[1 - idx]?.ticker
        const ksOwn        = ksTicker ? kalshiBooks.get(ksTicker) : undefined
        const ksOpp        = ksOppTicker ? kalshiBooks.get(ksOppTicker) : undefined
        if (ksOwn || ksOpp) {
          kalshiBook = combineKalshi(ksOwn, ksOpp)
          kalshiBest = { bid: kalshiBook.bids[0] ?? null, ask: kalshiBook.asks[0] ?? null }
        }

        // Edge rows: for each level of each venue, compute the available $ edge
        // Kalshi has trading fees (0.07 * p * (1-p) per share, $0.01/contract floor)
        // — subtract that from the per-share edge.
        if (fair != null) {
          const pushEdges = (venue: Venue, book: OutcomeBook | null) => {
            if (!book) return
            const feeFor = venue === 'kalshi' ? kalshiFeePerShare : () => 0
            for (const l of book.asks) {
              const fee = feeFor(l.price)
              const eps = fair - l.price - fee   // buy at ask, net edge per share
              if (eps > 0) {
                edges.push({
                  event_slug:   pred.poly_event_slug!, event_title: d.title,
                  market_label: label, outcome: name,
                  venue, side: 'ask', price: l.price, size: l.size,
                  fair, edge_per_share: eps, total_edge_usd: eps * l.size,
                })
              } else break  // book sorted ascending; deeper asks are worse
            }
            for (const l of book.bids) {
              const fee = feeFor(l.price)
              const eps = l.price - fair - fee   // sell at bid, net edge per share
              if (eps > 0) {
                edges.push({
                  event_slug:   pred.poly_event_slug!, event_title: d.title,
                  market_label: label, outcome: name,
                  venue, side: 'bid', price: l.price, size: l.size,
                  fair, edge_per_share: eps, total_edge_usd: eps * l.size,
                })
              } else break
            }
          }
          pushEdges('pm', pmBook)
          pushEdges('kalshi', kalshiBook)
        }

        // Liquidity rows: best + best±1¢
        const pushLiquidity = (venue: Venue, book: OutcomeBook | null) => {
          if (!book) return
          const bid = book.bids[0]
          if (bid) {
            const plus1 = book.bids.find(l => Math.abs(l.price - (bid.price - 0.01)) < 0.005)
            liquidity.push({
              event_slug: pred.poly_event_slug!, event_title: d.title,
              market_label: label, outcome: name,
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
              event_slug: pred.poly_event_slug!, event_title: d.title,
              market_label: label, outcome: name,
              venue, side: 'ask',
              best_price: ask.price, best_size: ask.size,
              plus1_size: plus1?.size ?? 0,
              notional_usd: ask.size * ask.price + (plus1?.size ?? 0) * (ask.price + 0.01),
            })
          }
        }
        pushLiquidity('pm', pmBook)
        pushLiquidity('kalshi', kalshiBook)

        return {
          outcome:           name,
          fair,
          token_id:          tid ?? null,
          kalshi_ticker:     ksTicker ?? null,
          kalshi_opp_ticker: ksOppTicker ?? null,
          pm:                pmBook,
          kalshi:            kalshiBook,
          pm_best:           pmBest,
          kalshi_best:       kalshiBest,
        }
      })

      submarkets.push({ market_type: sm.market_type, market_label: label, outcomes: outcomeViews })
    }

    events.push({
      slug:           pred.poly_event_slug!,
      title:          d.title,
      league:         pred.league,
      team1:          d.team1,
      team2:          d.team2,
      best_of:        pred.best_of,
      pred_blue_win:  pBlue,
      pred_blue_team: pred.blue_team,
      date:           pred.date,
      submarkets,
    })
  }

  // 5. Sort + cap rankings.
  edges.sort((a, b) => b.total_edge_usd - a.total_edge_usd)
  liquidity.sort((a, b) => b.notional_usd - a.notional_usd)

  // Convert the kalshiBooks Map (raw per-ticker) into a plain object so the
  // client can use it as a seed for the EventSource-driven Map.
  const kalshiRawObj: Record<string, OutcomeBook> = {}
  for (const [ticker, book] of kalshiBooks) kalshiRawObj[ticker] = book

  const resp: ScannerResponse = {
    events,
    top_edges:        edges.slice(0, 25),
    top_liquidity:    liquidity.slice(0, 25),
    kalshi_raw_books: kalshiRawObj,
    generated_at:     Date.now(),
    ms_elapsed:       Date.now() - t0,
  }
  CACHE = { ts: Date.now(), data: resp }
  return NextResponse.json(resp)
}
