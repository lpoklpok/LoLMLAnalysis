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

interface Submarket {
  market_type: string         // 'match_winner' | 'game_N_winner' | 'game_handicap'
  question: string
  outcomes: [string, string]
  outcome_mids: [number, number]
  mid_source: 'clob_mid' | 'gamma_last'
  volume: number
}

interface KalshiSide {
  team: string
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

interface EventDetail {
  slug: string
  title: string
  team1: string
  team2: string
  best_of: number
  match_date: string | null
  submarkets: Submarket[]
  kalshi: KalshiMatch | null
  refreshed_at: string
}

async function fetchKalshiSeriesWinner(team1: string, team2: string): Promise<KalshiMatch | null> {
  try {
    const url = new URL(KALSHI_MARKETS)
    url.searchParams.set('series_ticker', 'KXLOLGAME')
    url.searchParams.set('status', 'open')
    url.searchParams.set('limit', '200')
    const r = await fetch(url.toString(), { cache: 'no-store' })
    if (!r.ok) return null
    const data = await r.json()
    const markets = (data.markets ?? []) as Record<string, unknown>[]

    // Group binary markets by their event_ticker (each event has 2 markets — one per team).
    const byEvent: Record<string, Record<string, unknown>[]> = {}
    for (const m of markets) {
      const et = String(m['event_ticker'] ?? '')
      if (!et) continue
      ;(byEvent[et] ??= []).push(m)
    }

    const t1c = canonTeam(team1)
    const t2c = canonTeam(team2)
    for (const [et, ms] of Object.entries(byEvent)) {
      if (ms.length < 2) continue
      const teams = ms.map(m => String(m['yes_sub_title'] ?? ''))
      const teamsCanon = teams.map(canonTeam)
      const sset = new Set(teamsCanon)
      if (sset.size === 2 && sset.has(t1c) && sset.has(t2c)) {
        // Build sides aligned to [team1, team2]
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
            team: teams[idx],
            yes_bid, yes_ask, yes_mid,
            volume_24h: Number.isFinite(v24) ? v24 : null,
          }
        }
        return {
          event_ticker: et,
          sides: [sideFor(t1c), sideFor(t2c)],
        }
      }
    }
  } catch {
    /* swallow — kalshi is best-effort */
  }
  return null
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
  // Parallel CLOB midpoint lookups
  const mids = await Promise.all(pending.flatMap(p => [
    fetchMid(p.token_ids[0]),
    fetchMid(p.token_ids[1]),
  ]))
  pending.forEach((p, i) => {
    const m1 = mids[i * 2]
    const m2 = mids[i * 2 + 1]
    const mid1 = m1 ?? p.gamma_prices[0]
    const mid2 = m2 ?? (1 - mid1)
    submarkets.push({
      market_type:  p.market_type,
      question:     p.question,
      outcomes:     p.outcomes,
      outcome_mids: [mid1, mid2],
      mid_source:   m1 !== null && m2 !== null ? 'clob_mid' : 'gamma_last',
      volume:       p.volume,
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

  // Run Kalshi lookup in parallel-ish (we already finished CLOB calls; fire one more)
  const kalshi = team1 && team2 ? await fetchKalshiSeriesWinner(team1, team2) : null

  const detail: EventDetail = {
    slug,
    title,
    team1: team1 ?? '',
    team2: team2 ?? '',
    best_of,
    match_date: (event['endDate'] as string | null) ?? null,
    submarkets,
    kalshi,
    refreshed_at: new Date().toISOString(),
  }
  return NextResponse.json(detail)
}
