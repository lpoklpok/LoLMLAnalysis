import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const SB_URL          = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY_READ     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? ''
const SB_KEY_SERVICE  = process.env.SUPABASE_SERVICE_KEY ?? ''
const PM_DATA_URL     = 'https://data-api.polymarket.com/positions'

interface PmPosition {
  asset:        string
  conditionId:  string
  size:         number
  avgPrice:     number
  curPrice:     number
  currentValue: number
  cashPnl:      number
  realizedPnl:  number
  title:        string
  slug:         string
  eventSlug:    string
  outcome:      string
  outcomeIndex: number
  endDate:      string
  icon:         string
  redeemable:   boolean
}

interface Shark {
  wallet_address: string
  name:           string | null
  type:           'sharp' | 'fade' | 'watch'
  emoji:          string | null
  notes:          string | null
  active:         boolean
  added_at:       string
}

interface SharkWithPositions extends Shark {
  positions:      PmPosition[]
  position_count: number
  total_value:    number
  total_pnl:      number
  fetched_ok:     boolean
  error?:         string
}

let CACHE: { ts: number; data: SharkWithPositions[] } | null = null
const CACHE_TTL_MS = 60_000

export async function GET(): Promise<Response> {
  if (CACHE && Date.now() - CACHE.ts < CACHE_TTL_MS) {
    return NextResponse.json({ sharks: CACHE.data, cached: true, age_ms: Date.now() - CACHE.ts })
  }
  if (!SB_URL || !SB_KEY_READ) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const sb = createClient(SB_URL, SB_KEY_READ)
  const { data: rows, error } = await sb
    .from('sharks')
    .select('*')
    .eq('active', true)
    .order('added_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const sharks: SharkWithPositions[] = await Promise.all((rows ?? []).map(async (s: Shark): Promise<SharkWithPositions> => {
    try {
      const r = await fetch(
        `${PM_DATA_URL}?user=${s.wallet_address}&sizeThreshold=1`,
        { cache: 'no-store', signal: AbortSignal.timeout(10_000) },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const positions = (await r.json()) as PmPosition[]
      return {
        ...s,
        positions,
        position_count: positions.length,
        total_value:    positions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0),
        total_pnl:      positions.reduce((sum, p) => sum + (p.cashPnl ?? 0),     0),
        fetched_ok:     true,
      }
    } catch (e) {
      return {
        ...s,
        positions: [], position_count: 0, total_value: 0, total_pnl: 0,
        fetched_ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }))

  CACHE = { ts: Date.now(), data: sharks }
  return NextResponse.json({ sharks, cached: false, generated_at: Date.now() })
}

export async function POST(req: Request): Promise<Response> {
  if (!SB_URL || !SB_KEY_SERVICE) return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  let body: { wallet?: string; name?: string; type?: string; emoji?: string; notes?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const wallet = (body.wallet ?? '').trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: 'wallet must be 0x + 40 hex chars' }, { status: 400 })
  }
  const type: 'sharp'|'fade'|'watch' =
    body.type && ['sharp','fade','watch'].includes(body.type) ? body.type as 'sharp'|'fade'|'watch' : 'sharp'
  const sb = createClient(SB_URL, SB_KEY_SERVICE)
  const { error } = await sb.from('sharks').upsert({
    wallet_address: wallet,
    name:           body.name  ?? null,
    type,
    emoji:          body.emoji ?? null,
    notes:          body.notes ?? null,
    active:         true,
  }, { onConflict: 'wallet_address' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  CACHE = null
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request): Promise<Response> {
  if (!SB_URL || !SB_KEY_SERVICE) return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  const url = new URL(req.url)
  const wallet = (url.searchParams.get('wallet') ?? '').trim().toLowerCase()
  if (!wallet) return NextResponse.json({ error: 'wallet required' }, { status: 400 })
  const sb = createClient(SB_URL, SB_KEY_SERVICE)
  const { error } = await sb.from('sharks').update({ active: false }).eq('wallet_address', wallet)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  CACHE = null
  return NextResponse.json({ ok: true })
}
