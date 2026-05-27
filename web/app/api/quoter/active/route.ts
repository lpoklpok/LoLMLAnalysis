import { NextResponse } from 'next/server'

const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(req: Request) {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }
  const slug = new URL(req.url).searchParams.get('slug')
  const params = new URLSearchParams()
  params.set('select', '*')
  if (slug) params.set('event_slug', `eq.${slug}`)
  params.set('order', 'updated_at.desc')
  const r = await fetch(`${SB_URL.replace(/\/+$/, '')}/rest/v1/quoter_active?${params}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    cache: 'no-store',
  })
  if (!r.ok) return NextResponse.json({ error: `supabase ${r.status}` }, { status: 502 })
  return NextResponse.json({ rows: await r.json() })
}
