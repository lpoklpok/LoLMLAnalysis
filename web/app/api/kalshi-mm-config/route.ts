import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''   // must be service key (write)

const VALID = new Set(['both','bid','ask','off'])

export async function POST(req: Request): Promise<Response> {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  let body: { ticker?: string; mode?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const ticker = (body.ticker ?? '').trim()
  const mode   = (body.mode   ?? '').trim()
  if (!ticker || !VALID.has(mode)) {
    return NextResponse.json({ error: 'ticker + mode (both|bid|ask|off) required' }, { status: 400 })
  }
  const sb = createClient(SB_URL, SB_KEY)
  const { error } = await sb
    .from('kalshi_mm_config')
    .upsert({ ticker, mode, updated_at: new Date().toISOString() }, { onConflict: 'ticker' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
