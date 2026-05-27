import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''

export const dynamic = 'force-dynamic'

interface OverridesBody {
  event_slug:  string
  blue_roster?: string[] | null
  red_roster?:  string[] | null
  logit_nudge?: number
}

export async function GET(req: Request) {
  if (!SB_URL || !SB_KEY) return NextResponse.json({ error: 'no supabase' }, { status: 500 })
  const slug = new URL(req.url).searchParams.get('slug')
  if (!slug) return NextResponse.json({ rows: [] })
  const r = await fetch(`${SB_URL.replace(/\/+$/,'')}/rest/v1/event_overrides?select=*&event_slug=eq.${encodeURIComponent(slug)}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: 'no-store',
  })
  if (!r.ok) return NextResponse.json({ error: `supabase ${r.status}` }, { status: 502 })
  const rows = await r.json() as Array<Record<string, unknown>>
  return NextResponse.json({ row: rows[0] ?? null })
}

export async function POST(req: Request) {
  if (!SB_URL || !SB_KEY) return NextResponse.json({ error: 'no supabase' }, { status: 500 })
  const body = await req.json() as OverridesBody
  if (!body.event_slug) return NextResponse.json({ error: 'event_slug required' }, { status: 400 })
  const payload = {
    event_slug:  body.event_slug,
    blue_roster: body.blue_roster ?? null,
    red_roster:  body.red_roster ?? null,
    logit_nudge: body.logit_nudge ?? 0,
    updated_at:  new Date().toISOString(),
  }
  const r = await fetch(`${SB_URL.replace(/\/+$/,'')}/rest/v1/event_overrides`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  })
  if (!r.ok) return NextResponse.json({ error: `supabase ${r.status}`, body: await r.text() }, { status: 502 })
  return NextResponse.json({ ok: true, row: (await r.json())[0] })
}
