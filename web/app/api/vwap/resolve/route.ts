import { NextResponse } from 'next/server'

const GAMMA = 'https://gamma-api.polymarket.com/events'

export const dynamic = 'force-dynamic'

type ResolveQuery = {
  slug?:        string
  outcome?:     string
  market_type?: string  // 'match_winner' | 'game_N_winner' | 'game_handicap'
}

type Market = {
  question?:        string
  groupItemTitle?:  string
  conditionId?:     string
  outcomes?:        string | string[]
  clobTokenIds?:    string | string[]
}

type Event = { title?: string; markets?: Market[] }

function classify(m: Market, eventTitle: string): string {
  const gt = (m.groupItemTitle || '').trim()
  const q  = (m.question || '').trim()
  if (gt === 'Match Winner' || q === eventTitle) return 'match_winner'
  if (gt.toLowerCase().startsWith('game ') && gt.toLowerCase().endsWith(' winner')) {
    return gt.toLowerCase().replace(/ /g, '_')
  }
  if (gt.startsWith('Game Handicap') || q.startsWith('Game Handicap')) return 'game_handicap'
  return ''
}

function parseJsonish<T>(x: T | string): T {
  return typeof x === 'string' ? JSON.parse(x) as T : x
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const slug    = searchParams.get('slug')        || ''
  const outcome = searchParams.get('outcome')     || ''
  const mtype   = searchParams.get('market_type') || 'match_winner'
  if (!slug || !outcome) {
    return NextResponse.json({ error: 'slug + outcome required' }, { status: 400 })
  }

  const r = await fetch(`${GAMMA}?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })
  if (!r.ok) return NextResponse.json({ error: `gamma ${r.status}` }, { status: 502 })
  const raw = await r.json() as Event | Event[]
  const ev = Array.isArray(raw) ? raw[0] : raw
  if (!ev) return NextResponse.json({ error: 'event not found' }, { status: 404 })

  const title = (ev.title || '').trim()
  const markets: Market[] = ev.markets || []
  // Build outcome list across all markets in this event
  const allOutcomes = new Set<string>()
  let found: { token_id: string; condition_id: string; outcomes: string[] } | null = null
  for (const m of markets) {
    if (classify(m, title) !== mtype) continue
    const outcomes = parseJsonish<string[]>(m.outcomes || [])
    const tokens   = parseJsonish<string[]>(m.clobTokenIds || [])
    outcomes.forEach(o => allOutcomes.add(o))
    for (let i = 0; i < outcomes.length; i++) {
      if (String(outcomes[i]).trim().toLowerCase() === outcome.trim().toLowerCase()) {
        found = {
          token_id:     String(tokens[i] || ''),
          condition_id: String(m.conditionId || ''),
          outcomes,
        }
        break
      }
    }
    if (found) break
  }
  if (!found) {
    return NextResponse.json({
      error: 'outcome not found for that market_type',
      available_outcomes: Array.from(allOutcomes),
      title,
    }, { status: 404 })
  }
  return NextResponse.json({ ok: true, title, ...found })
}
