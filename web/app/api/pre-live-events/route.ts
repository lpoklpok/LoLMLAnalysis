import { NextResponse } from 'next/server'

export const revalidate = 120

const POLY_URL = 'https://gamma-api.polymarket.com/events'

// Mirror the alias map in src/merge_polymarket_data.py:_norm_team
const ALIASES: Record<string, string> = {
  't1academy':         't1esportsacademy',
  'pcific':            'pcificesports',
  'ucamesportsclub':   'ucamesports',
  'senshiesportsclub': 'senshiesports',
  'theotterside':      'otterside',
  'orbitanonymo':      'anonymoesports',
  'big':               'berlininternationalgaming',
  'furiaesports':      'furia',
  'nrgesports':        'nrg',
}

function normKey(s: string): string {
  let k = s.toLowerCase()
    .replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
  return ALIASES[k] ?? k
}

interface EventListing {
  slug:           string
  title:          string
  team1:          string
  team2:          string
  team1_key:      string
  team2_key:      string
  match_date:     string | null
  game_start:     string | null
  best_of:        number | null
  tournament:     string
  volume:         number
  liquidity:      number
  has_pregame:    boolean   // true if first game hasn't started yet
}

function inferBestOf(markets: { question?: string }[]): number | null {
  let max = 0
  for (const m of markets) {
    const q = m.question ?? ''
    const match = q.match(/Game (\d+) Winner/)
    if (match) max = Math.max(max, parseInt(match[1]))
  }
  if (max >= 4) return 5
  if (max === 3) return 3   // Bo3 has a game-3 market only when it goes that far — but Polymarket lists it
  if (max === 2) return 3
  if (max === 1) return 1
  return null
}

export async function GET() {
  const events: Record<string, unknown>[] = []
  for (let offset = 0; offset < 500; offset += 100) {
    const url = new URL(POLY_URL)
    url.searchParams.set('tag_slug', 'league-of-legends')
    url.searchParams.set('active', 'true')
    url.searchParams.set('closed', 'false')
    url.searchParams.set('limit', '100')
    url.searchParams.set('offset', String(offset))
    const r = await fetch(url.toString(), { next: { revalidate: 60 } })
    if (!r.ok) break
    const batch = await r.json() as Record<string, unknown>[]
    if (!Array.isArray(batch) || batch.length === 0) break
    events.push(...batch)
    if (batch.length < 100) break
  }

  const now = Date.now()
  const out: EventListing[] = []
  for (const ev of events) {
    const markets = (ev.markets as Record<string, unknown>[] | undefined) ?? []
    const mw = markets.find(m => /(BO\d)/.test(String(m.question ?? '')))
    if (!mw) continue
    let outcomes = mw.outcomes
    if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes)
    if (!Array.isArray(outcomes) || outcomes.length !== 2) continue
    const t1 = String(outcomes[0]).trim()
    const t2 = String(outcomes[1]).trim()
    if (!t1 || !t2) continue

    const game_start = (ev.gameStartTime as string | null)
                     ?? (ev.eventStartTime as string | null)
                     ?? null
    const start_ms = game_start ? Date.parse(game_start) : NaN
    const has_pregame = !Number.isNaN(start_ms) && start_ms > now

    out.push({
      slug:        String(ev.slug ?? ''),
      title:       String(ev.title ?? ''),
      team1:       t1,
      team2:       t2,
      team1_key:   normKey(t1),
      team2_key:   normKey(t2),
      match_date:  String(ev.endDate ?? ev.endDateIso ?? '') || null,
      game_start,
      best_of:     inferBestOf(markets),
      tournament:  String(ev.title ?? '').split(' - ').pop() ?? '',
      volume:      Number(ev.volume ?? 0),
      liquidity:   Number(ev.liquidity ?? 0),
      has_pregame,
    })
  }

  // Sort: pre-game events first by start time, then live/closed
  out.sort((a, b) => {
    if (a.has_pregame !== b.has_pregame) return a.has_pregame ? -1 : 1
    const at = a.game_start ? Date.parse(a.game_start) : Number.MAX_SAFE_INTEGER
    const bt = b.game_start ? Date.parse(b.game_start) : Number.MAX_SAFE_INTEGER
    return at - bt
  })

  return NextResponse.json({ events: out, count: out.length })
}
