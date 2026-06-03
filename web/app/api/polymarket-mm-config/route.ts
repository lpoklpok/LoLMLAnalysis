import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''  // must be service key (writes)

// Allow-list of fields the page can edit. Anything else in the body is dropped.
const EDITABLE_FIELDS = new Set([
  'enabled', 'strategy', 'side', 'bid_enabled', 'offer_enabled',
  'quote_size_shares', 'quote_size_usd', 'fair', 'edge_threshold_pp',
  'max_size_pct', 'max_fill_usd', 'max_position_shares',
  'min_spread_cents', 'min_level_size_usd', 'order_ttl_sec',
])

export async function PATCH(req: Request): Promise<Response> {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const id = body.id
  if (typeof id !== 'number' && typeof id !== 'string') {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }
  const updates: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === 'id') continue
    if (EDITABLE_FIELDS.has(k)) updates[k] = v === '' ? null : v
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'no editable fields' }, { status: 400 })
  }
  const sb = createClient(SB_URL, SB_KEY)
  const { error } = await sb.from('mm_config').update(updates).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, updated: updates })
}
