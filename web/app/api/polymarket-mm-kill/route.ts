import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SB_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''

export async function POST(req: Request): Promise<Response> {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  let body: { killed?: boolean; reason?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const killed = body.killed === true
  const reason = body.reason ?? (killed ? 'manual kill' : 'manual release')
  const sb = createClient(SB_URL, SB_KEY)
  const { error } = await sb.from('mm_kill_switch')
    .upsert({ id: 1, killed, reason, updated_at: new Date().toISOString() },
            { onConflict: 'id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, killed, reason })
}
