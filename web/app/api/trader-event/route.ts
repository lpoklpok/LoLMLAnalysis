import { NextResponse } from 'next/server'

const GAMMA_EVENTS = 'https://gamma-api.polymarket.com/events'
const CLOB_MIDPOINT = 'https://clob.polymarket.com/midpoint'
const KALSHI_MARKETS = 'https://api.elections.kalshi.com/trade-api/v2/markets'

// Always fresh — no caching, this drives the live trader cockpit.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Maps Polymarket/Kalshi display names → a single canonical key for matching.
const CANON: Record<string, string> = {
  // LCK
  't1': 't1',
  'gen.g': 'geng', 'gen.g esports': 'geng',
  'kt rolster': 'kt',
  'hanwha life esports': 'hle',
  'kiwoom drx': 'drx', 'drx': 'drx',
  'bnk fearx': 'bnk', 'bnk feargx': 'bnk', 'fearx': 'bnk',
  'nongshim redforce': 'ns', 'nongshim red force': 'ns',
  'dn soopers': 'dnf', 'dn freecs': 'dnf',
  'dplus kia': 'dk', 'dplus kig': 'dk',
  'hanjin brion': 'bro', 'ok brion': 'bro', 'oksavingsbank brion': 'bro',
  // LEC
  'g2 esports': 'g2', 'fnatic': 'fnc', 'team vitality': 'vit',
  'karmine corp': 'kc', 'movistar koi': 'mkoi',
  'natus vincere': 'nv', 'sk gaming': 'sk',
  'giantx': 'gx', 'team heretics': 'th', 'shifters': 'sft',
  // LPL
  "anyone's legend": 'al', 'bilibili gaming': 'blg',
  'jd gaming': 'jdg', 'edward gaming': 'edg', 'invictus gaming': 'ig',
  'lgd gaming': 'lgd', 'oh my god': 'omg', 'ninjas in pyjamas': 'nip',
  'lng esports': 'lng', 'thundertalk gaming': 'tt',
  'top esports': 'tes', 'ultra prime': 'up',
  'weibo gaming': 'wb', 'team we': 'we', 'funplus phoenix': 'fpx',
  // LCS
  'cloud9': 'c9', 'dignitas': 'dig', 'disguised': 'dsg',
  'flyquest': 'fly', 'lyon': 'lyon', 'sentinels': 'sen',
  'shopify rebellion': 'sr', 'team liquid': 'tl', 'team liquid honda': 'tl',
}
function canonTeam(name: string): string {
  return CANON[name.trim().toLowerCase()] ?? name.trim().toLowerCase()
}

interface KalshiSidePair { sides: [KalshiSide | null, KalshiSide | null] }

interface Submarket {
  market_type: string         // 'match_winner' | 'game_N_winner' | 'game_handicap'
  question: string
  outcomes: [string, string]
  outcome_mids: [number, number]
  outcome_bids: [number | null, number | null]
  outcome_asks: [number | null, number | null]
  token_ids: [string | null, string | null]   // CLOB token ids — needed to place orders
  mid_source: 'clob_mid' | 'gamma_last'
  volume: number
  kalshi_sides: [KalshiSide | null, KalshiSide | null]   // Kalshi market for this submarket (if exists)
}

interface KalshiSide {
  team: string
  ticker: string           // full market ticker (e.g. 'KXLOLGAME-...-NS') — for orderbook polling
  yes_bid: number | null
  yes_ask: number | null
  yes_mid: number | null
  volume_24h: number | null
}

interface KalshiMatch {
  event_ticker: string
  // Aligned to Polymarket outcomes order [team1, team2]
  sides: [KalshiSide | null, KalshiSide | null]
}

interface KalshiBundle {
  series_winner: KalshiMatch | null    // KXLOLGAME (Match Winner)
  by_game: Record<number, KalshiMatch> // KXLOLMAP keyed by game number (1, 2, 3, ...)
}

interface EventDetail {
  slug: string
  title: string
  team1: string
  team2: string
  best_of: number
  match_date: string | null
  submarkets: Submarket[]
  // Kept for backwards-compat with the dashboard table — same data as
  // submarkets[i:match_winner].kalshi_sides
  kalshi: KalshiMatch | null
  refreshed_at: string
}

// Build one KalshiMatch (a pair of sides aligned to [team1, team2]) from a set of
// Kalshi markets sharing an event_ticker. Returns null if the team set doesn't match.
function buildMatchFromGroup(
  ms: Record<string, unknown>[],
  t1c: string, t2c: string,
): KalshiMatch | null {
  if (ms.length < 2) return null
  const teams = ms.map(m => String(m['yes_sub_title'] ?? ''))
  const teamsCanon = teams.map(canonTeam)
  const sset = new Set(teamsCanon)
  if (sset.size !== 2 || !sset.has(t1c) || !sset.has(t2c)) return null
  const sideFor = (canonical: string): KalshiSide | null => {
    const idx = teamsCanon.findIndex(c => c === canonical)
    if (idx < 0) return null
    const m = ms[idx]
    const yb = parseFloat(String(m['yes_bid_dollars'] ?? ''))
    const ya = parseFloat(String(m['yes_ask_dollars'] ?? ''))
    const v24 = parseFloat(String(m['volume_24h_fp'] ?? ''))
    const yes_bid = Number.isFinite(yb) ? yb : null
    const yes_ask = Number.isFinite(ya) ? ya : null
    const yes_mid = yes_bid != null && yes_ask != null ? (yes_bid + yes_ask) / 2 : null
    return {
      team:    teams[idx],
      ticker:  String(m['ticker'] ?? ''),
      yes_bid, yes_ask, yes_mid,
      volume_24h: Number.isFinite(v24) ? v24 : null,
    }
  }
  return {
    event_ticker: String(ms[0]['event_ticker'] ?? ''),
    sides: [sideFor(t1c), sideFor(t2c)],
  }
}

async function fetchKalshiSeries(seriesTicker: string): Promise<Record<string, unknown>[]> {
  const url = new URL(KALSHI_MARKETS)
  url.searchParams.set('series_ticker', seriesTicker)
  url.searchParams.set('status', 'open')
  url.searchParams.set('limit', '500')
  const r = await fetch(url.toString(), { cache: 'no-store' })
  if (!r.ok) return []
  const data = await r.json()
  return (data.markets ?? []) as Record<string, unknown>[]
}

async function fetchKalshiBundle(team1: string, team2: string): Promise<KalshiBundle> {
  const out: KalshiBundle = { series_winner: null, by_game: {} }
  try {
    const [seriesMarkets, mapMarkets] = await Promise.all([
      fetchKalshiSeries('KXLOLGAME'),   // Match Winner (series-level)
      fetchKalshiSeries('KXLOLMAP'),    // Per-map (per-game) markets
    ])

    const t1c = canonTeam(team1)
    const t2c = canonTeam(team2)

    // 1. Series winner (KXLOLGAME): group by event_ticker.
    const seriesByEvent: Record<string, Record<string, unknown>[]> = {}
    for (const m of seriesMarkets) {
      const et = String(m['event_ticker'] ?? '')
      if (et) (seriesByEvent[et] ??= []).push(m)
    }
    for (const ms of Object.values(seriesByEvent)) {
      const match = buildMatchFromGroup(ms, t1c, t2c)
      if (match) { out.series_winner = match; break }
    }

    // 2. Per-game (KXLOLMAP): tickers look like 'KXLOLMAP-{DATE}{TIME}{TEAMS}-{N}-{TEAM}'.
    // Group by (event_ticker, game_num). Polymarket maps game_1_winner → game_num=1, etc.
    const mapByGroup: Record<string, { game_num: number; markets: Record<string, unknown>[] }> = {}
    for (const m of mapMarkets) {
      const ticker = String(m['ticker'] ?? '')
      // segments: ['KXLOLMAP', '<match_id>', '<game_num>', '<team_suffix>']
      const segs = ticker.split('-')
      if (segs.length < 4) continue
      const gameNum = parseInt(segs[segs.length - 2], 10)
      if (!Number.isFinite(gameNum)) continue
      const matchId = segs.slice(1, segs.length - 2).join('-')
      const groupKey = `${matchId}|${gameNum}`
      ;(mapByGroup[groupKey] ??= { game_num: gameNum, markets: [] }).markets.push(m)
    }
    for (const { game_num, markets } of Object.values(mapByGroup)) {
      const match = buildMatchFromGroup(markets, t1c, t2c)
      if (match) out.by_game[game_num] = match
    }
  } catch {
    /* swallow — kalshi is best-effort */
  }
  return out
}

async function fetchMid(tokenId: string | null | undefined): Promise<number | null> {
  if (!tokenId) return null
  try {
    const url = new URL(CLOB_MIDPOINT)
    url.searchParams.set('token_id', tokenId)
    const r = await fetch(url.toString(), { cache: 'no-store' })
    if (!r.ok) return null
    const d = await r.json()
    const mid = parseFloat(d.mid)
    return Number.isFinite(mid) ? mid : null
  } catch { return null }
}

interface BookSnap { best_bid: number | null; best_ask: number | null }

async function fetchTopOfBook(tokenId: string | null | undefined): Promise<BookSnap> {
  if (!tokenId) return { best_bid: null, best_ask: null }
  try {
    const url = new URL('https://clob.polymarket.com/book')
    url.searchParams.set('token_id', tokenId)
    const r = await fetch(url.toString(), { cache: 'no-store' })
    if (!r.ok) return { best_bid: null, best_ask: null }
    const d = await r.json() as { bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }> }
    let bb: number | null = null
    let ba: number | null = null
    for (const lvl of d.bids ?? []) {
      const p = parseFloat(lvl.price); const s = parseFloat(lvl.size)
      if (Number.isFinite(p) && Number.isFinite(s) && s > 0 && (bb == null || p > bb)) bb = p
    }
    for (const lvl of d.asks ?? []) {
      const p = parseFloat(lvl.price); const s = parseFloat(lvl.size)
      if (Number.isFinite(p) && Number.isFinite(s) && s > 0 && (ba == null || p < ba)) ba = p
    }
    return { best_bid: bb, best_ask: ba }
  } catch { return { best_bid: null, best_ask: null } }
}

function classifyMarket(q: string, gt: string, eventTitle: string): string | null {
  if (gt === 'Match Winner' || q === eventTitle) return 'match_winner'
  const gw = gt.match(/^Game\s+(\d+)\s+Winner$/i)
  if (gw) return `game_${gw[1]}_winner`
  if (gt.startsWith('Game Handicap') || q.startsWith('Game Handicap')) return 'game_handicap'
  return null
}

function inferBestOf(markets: Record<string, unknown>[]): number {
  let max = 0
  for (const m of markets) {
    const gt = String(m['groupItemTitle'] ?? '')
    const mm = gt.match(/^Game\s+(\d+)\s+Winner$/i)
    if (mm) max = Math.max(max, parseInt(mm[1], 10))
  }
  if (max >= 4) return 5
  if (max >= 2) return 3
  if (max === 1) return 1
  return 0
}

function parseTeamsFromTitle(title: string): [string | null, string | null] {
  if (!title.toLowerCase().includes('vs')) return [null, null]
  let head = title.includes(':') ? title.split(':').slice(1).join(':').trim() : title.trim()
  if (head.includes(' - ')) head = head.substring(0, head.lastIndexOf(' - ')).trim()
  if (head.includes('(')) head = head.substring(0, head.lastIndexOf('(')).trim()
  const parts = head.split(' vs ')
  if (parts.length !== 2) return [null, null]
  return [parts[0].trim(), parts[1].trim()]
}

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get('slug')
  if (!slug) return NextResponse.json({ error: 'missing slug' }, { status: 400 })

  // Find the event by slug (gamma /events supports ?slug=)
  const url = new URL(GAMMA_EVENTS)
  url.searchParams.set('slug', slug)
  url.searchParams.set('limit', '1')
  const r = await fetch(url.toString(), { cache: 'no-store' })
  if (!r.ok) return NextResponse.json({ error: 'gamma fetch failed', status: r.status }, { status: 502 })
  const events: unknown = await r.json()
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: 'event not found' }, { status: 404 })
  }
  const event = events[0] as Record<string, unknown>
  const title = String(event['title'] ?? '')
  const markets = (event['markets'] as Record<string, unknown>[]) ?? []
  const best_of = inferBestOf(markets)
  const [team1, team2] = parseTeamsFromTitle(title)

  const submarkets: Submarket[] = []
  // Build classified list, then fetch midpoints in parallel
  type Pending = {
    market_type: string
    question: string
    outcomes: [string, string]
    gamma_prices: [number, number]
    token_ids: [string | null, string | null]
    volume: number
  }
  const pending: Pending[] = []
  for (const m of markets) {
    const q  = String(m['question'] ?? '')
    const gt = String(m['groupItemTitle'] ?? '')
    const mt = classifyMarket(q, gt, title)
    if (!mt) continue
    let prices = m['outcomePrices'] as string[] | string
    let outcomes = m['outcomes'] as string[] | string
    let tokenIds = m['clobTokenIds'] as string[] | string
    if (typeof prices === 'string')   prices = JSON.parse(prices) as string[]
    if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes) as string[]
    if (typeof tokenIds === 'string') tokenIds = JSON.parse(tokenIds) as string[]
    if (!Array.isArray(prices) || prices.length < 2) continue
    if (!Array.isArray(outcomes) || outcomes.length < 2) continue
    const p1 = parseFloat(prices[0])
    const p2 = parseFloat(prices[1])
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) continue
    pending.push({
      market_type: mt,
      question: q,
      outcomes: [outcomes[0], outcomes[1]],
      gamma_prices: [p1, p2],
      token_ids: [
        Array.isArray(tokenIds) && tokenIds.length > 0 ? tokenIds[0] : null,
        Array.isArray(tokenIds) && tokenIds.length > 1 ? tokenIds[1] : null,
      ],
      volume: parseFloat(String(m['volume'] ?? '0')) || 0,
    })
  }
  // Parallel CLOB lookups: midpoint + top-of-book for each token
  const midsAndBooks = await Promise.all(pending.flatMap(p => [
    fetchMid(p.token_ids[0]),
    fetchMid(p.token_ids[1]),
    fetchTopOfBook(p.token_ids[0]),
    fetchTopOfBook(p.token_ids[1]),
  ]))
  pending.forEach((p, i) => {
    const m1 = midsAndBooks[i * 4]     as number | null
    const m2 = midsAndBooks[i * 4 + 1] as number | null
    const b1 = midsAndBooks[i * 4 + 2] as BookSnap
    const b2 = midsAndBooks[i * 4 + 3] as BookSnap
    const mid1 = m1 ?? p.gamma_prices[0]
    const mid2 = m2 ?? (1 - mid1)
    submarkets.push({
      market_type:  p.market_type,
      question:     p.question,
      outcomes:     p.outcomes,
      outcome_mids: [mid1, mid2],
      outcome_bids: [b1.best_bid, b2.best_bid],
      outcome_asks: [b1.best_ask, b2.best_ask],
      token_ids:    p.token_ids,
      mid_source:   m1 !== null && m2 !== null ? 'clob_mid' : 'gamma_last',
      volume:       p.volume,
      kalshi_sides: [null, null],   // filled in below once we have Kalshi bundle
    })
  })

  // Stable ordering: match winner, game 1..5, handicap
  const order = (mt: string) => {
    if (mt === 'match_winner') return 0
    const m = mt.match(/^game_(\d+)_winner$/)
    if (m) return parseInt(m[1], 10)
    if (mt === 'game_handicap') return 99
    return 100
  }
  submarkets.sort((a, b) => order(a.market_type) - order(b.market_type))

  // Pull Kalshi for both series-level (Match Winner) and per-game markets
  const kalshiBundle = team1 && team2 ? await fetchKalshiBundle(team1, team2) : { series_winner: null, by_game: {} }

  // Attach kalshi_sides per submarket using the bundle.
  // Polymarket outcomes order may differ from Kalshi's; we align by canonical team.
  function alignSides(km: KalshiMatch | null, outcomes: [string, string]): [KalshiSide | null, KalshiSide | null] {
    if (!km) return [null, null]
    // The KalshiMatch was built using (team1, team2) — find which Kalshi side
    // matches outcome[0] vs outcome[1].
    const t1c = canonTeam(team1 ?? '')
    const s0 = km.sides[0]
    const s1 = km.sides[1]
    const o0c = canonTeam(outcomes[0])
    return o0c === t1c ? [s0, s1] : [s1, s0]
  }
  for (const sm of submarkets) {
    if (sm.market_type === 'match_winner') {
      sm.kalshi_sides = alignSides(kalshiBundle.series_winner, sm.outcomes)
    } else if (sm.market_type.startsWith('game_') && sm.market_type.endsWith('_winner')) {
      const n = parseInt(sm.market_type.replace('game_', '').replace('_winner', ''), 10)
      if (Number.isFinite(n)) sm.kalshi_sides = alignSides(kalshiBundle.by_game[n] ?? null, sm.outcomes)
    }
    // game_handicap intentionally has no Kalshi mapping (no analog on Kalshi)
  }

  const detail: EventDetail = {
    slug,
    title,
    team1: team1 ?? '',
    team2: team2 ?? '',
    best_of,
    match_date: (event['endDate'] as string | null) ?? null,
    submarkets,
    kalshi: kalshiBundle.series_winner,
    refreshed_at: new Date().toISOString(),
  }
  return NextResponse.json(detail)
}
