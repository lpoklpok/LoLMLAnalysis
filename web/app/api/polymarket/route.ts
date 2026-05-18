import { NextResponse } from 'next/server'

export const revalidate = 120 // cache for 2 minutes server-side

const POLY_URL = 'https://gamma-api.polymarket.com/events'

// OE canonical name normalisation (mirrors predict_upcoming.py _TEAM_NORM)
const TEAM_NORM: Record<string, string> = {
  'T1': 'T1',
  'Gen.G': 'Gen.G',
  'Gen.G Esports': 'Gen.G',
  'KT Rolster': 'KT Rolster',
  'kt Rolster': 'KT Rolster',
  'Hanwha Life Esports': 'Hanwha Life Esports',
  'Kiwoom DRX': 'Kiwoom DRX',
  'KIWOOM DRX': 'Kiwoom DRX',
  'DRX': 'Kiwoom DRX',
  'BNK FearX': 'BNK FEARX',
  'BNK FEARX': 'BNK FEARX',
  'Nongshim RedForce': 'Nongshim RedForce',
  'NONGSHIM RED FORCE': 'Nongshim RedForce',
  'Nongshim Red Force': 'Nongshim RedForce',
  'DN Freecs': 'DN SOOPers',
  'DN SOOPers': 'DN SOOPers',
  'Dplus KIA': 'Dplus Kia',
  'Dplus Kia': 'Dplus Kia',
  'DPLUS KIA': 'Dplus Kia',
  'HANJIN BRION': 'HANJIN BRION',
  'OK BRION': 'HANJIN BRION',
  'G2 Esports': 'G2 Esports',
  'Fnatic': 'Fnatic',
  'Team Vitality': 'Team Vitality',
  'Karmine Corp': 'Karmine Corp',
  'Movistar KOI': 'Movistar KOI',
  'Natus Vincere': 'Natus Vincere',
  'SK Gaming': 'SK Gaming',
  'GiantX': 'GiantX',
  'GIANTX': 'GiantX',
  'Team Heretics': 'Team Heretics',
  'Shifters': 'Shifters',
}

function normTeam(name: string): string {
  return TEAM_NORM[name.trim()] ?? name.trim()
}

interface PolyMarket {
  slug: string
  prob_blue: number   // probability for blue/team1 in our stored prediction
  prob_team1: number  // probability for outcomes[0] from polymarket
  team1: string       // OE canonical name of outcomes[0]
  team2: string       // OE canonical name of outcomes[1]
  volume: number
}

export async function GET() {
  try {
    const events: Record<string, unknown>[] = []
    for (let offset = 0; offset < 500; offset += 100) {
      const url = new URL(POLY_URL)
      url.searchParams.set('tag_slug', 'league-of-legends')
      url.searchParams.set('active', 'true')
      url.searchParams.set('closed', 'false')
      url.searchParams.set('limit', '100')
      url.searchParams.set('offset', String(offset))

      const r = await fetch(url.toString(), { next: { revalidate: 120 } })
      if (!r.ok) break
      const page: unknown = await r.json()
      if (!Array.isArray(page)) break
      events.push(...page)
      if (page.length < 100) break
    }

    // Build slug → market info map
    const result: Record<string, PolyMarket> = {}

    for (const event of events) {
      const title = (event['title'] as string) ?? ''
      if (!title.toLowerCase().includes('vs')) continue

      const slug = (event['slug'] as string) ?? ''
      const markets = (event['markets'] as Record<string, unknown>[]) ?? []
      const winner = markets.find(m => m['question'] === title)
      if (!winner) continue

      let prices: string[] = winner['outcomePrices'] as string[]
      let outcomes: string[] = winner['outcomes'] as string[]
      if (typeof prices === 'string') prices = JSON.parse(prices)
      if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes)
      if (!prices || prices.length < 2 || !outcomes || outcomes.length < 2) continue

      const prob1 = parseFloat(prices[0])
      const vol = parseFloat((winner['volume'] as string) ?? '0') || 0
      if (isNaN(prob1)) continue

      const t1 = normTeam(outcomes[0])
      const t2 = normTeam(outcomes[1])

      result[slug] = {
        slug,
        prob_team1: prob1,
        prob_blue: prob1, // caller adjusts if blue team != team1
        team1: t1,
        team2: t2,
        volume: vol,
      }
    }

    return NextResponse.json(result)
  } catch (e) {
    console.error('Polymarket proxy error:', e)
    return NextResponse.json({}, { status: 500 })
  }
}
