import { NextResponse } from 'next/server'

const GAMMA = 'https://gamma-api.polymarket.com/events'

// Cache for 60s — gamma's data doesn't change second-to-second
export const revalidate = 60

type Market = {
  question?:       string
  groupItemTitle?: string
  conditionId?:    string
  outcomes?:       string | string[]
  clobTokenIds?:   string | string[]
  volume?:         number | string
  volume24hr?:     number | string
  active?:         boolean
  closed?:         boolean
}

type Event = {
  slug?:        string
  title?:       string
  startDate?:   string
  endDate?:     string
  active?:      boolean
  closed?:      boolean
  archived?:    boolean
  volume?:      number | string
  markets?:     Market[]
}

type OutcomeOpt = { name: string; token_id: string }
type SubmarketOpt = {
  mtype:       string  // 'match_winner' | 'game_N_winner' | 'game_handicap'
  label:       string  // human-readable
  condition_id: string
  outcomes:    OutcomeOpt[]
  volume:      number
}
type EventOpt = {
  slug:        string
  title:       string
  start_date:  string
  volume:      number
  submarkets:  SubmarketOpt[]
}

function classify(m: Market, eventTitle: string): { mtype: string; label: string } | null {
  const gt = (m.groupItemTitle || '').trim()
  const q  = (m.question || '').trim()
  if (gt === 'Match Winner' || q === eventTitle)  return { mtype: 'match_winner', label: 'Match Winner' }
  const gtl = gt.toLowerCase()
  if (gtl.startsWith('game ') && gtl.endsWith(' winner')) {
    return { mtype: gtl.replace(/ /g, '_'), label: gt }
  }
  if (gt.startsWith('Game Handicap') || q.startsWith('Game Handicap')) {
    return { mtype: 'game_handicap', label: gt || 'Game Handicap' }
  }
  return null
}

function parseJsonish(x: string | string[] | undefined): string[] {
  if (!x) return []
  if (typeof x === 'string') {
    try { return JSON.parse(x) as string[] } catch { return [] }
  }
  return x
}

export async function GET() {
  // Paginate all active LoL events (same query the worker uses)
  const events: Event[] = []
  for (let offset = 0; offset < 1000; offset += 100) {
    const u = new URL(GAMMA)
    u.searchParams.set('tag_slug', 'league-of-legends')
    u.searchParams.set('active', 'true')
    u.searchParams.set('closed', 'false')
    u.searchParams.set('limit', '100')
    u.searchParams.set('offset', String(offset))
    const r = await fetch(u.toString(), { next: { revalidate: 60 } })
    if (!r.ok) break
    const page = await r.json() as Event[]
    if (!Array.isArray(page) || page.length === 0) break
    events.push(...page)
    if (page.length < 100) break
  }

  const out: EventOpt[] = []
  for (const ev of events) {
    const title = (ev.title || '').trim()
    if (!title) continue
    const submarkets: SubmarketOpt[] = []
    for (const m of (ev.markets || [])) {
      const cls = classify(m, title)
      if (!cls) continue
      const names  = parseJsonish(m.outcomes)
      const tokens = parseJsonish(m.clobTokenIds)
      const outcomes: OutcomeOpt[] = []
      for (let i = 0; i < names.length; i++) {
        if (tokens[i]) outcomes.push({ name: String(names[i]), token_id: String(tokens[i]) })
      }
      if (outcomes.length === 0) continue
      submarkets.push({
        mtype:        cls.mtype,
        label:        cls.label,
        condition_id: String(m.conditionId || ''),
        outcomes,
        volume:       Number(m.volume || 0),
      })
    }
    if (submarkets.length === 0) continue
    // Sort submarkets: match_winner first, then game_N in order, handicap last
    submarkets.sort((a, b) => {
      const order = (s: string) => s === 'match_winner' ? 0 : s.startsWith('game_') && s.endsWith('_winner') ? 1 + parseInt(s.split('_')[1] || '99', 10) : 100
      return order(a.mtype) - order(b.mtype)
    })
    out.push({
      slug:       ev.slug || '',
      title,
      start_date: ev.startDate || '',
      volume:     Number(ev.volume || 0),
      submarkets,
    })
  }
  // Sort events by start date ascending (upcoming/in-progress first)
  out.sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''))
  return NextResponse.json({ ok: true, events: out, count: out.length })
}
