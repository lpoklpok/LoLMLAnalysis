import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic   = 'force-dynamic'
export const revalidate = 0

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? ''

export async function GET(): Promise<Response> {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const sb = createClient(SB_URL, SB_KEY)

  // Pull config + state in parallel. Most rows are joined on
  // (condition_id, outcome_index) — same key in both tables.
  const [cfg, state, kill] = await Promise.all([
    sb.from('mm_config').select('*').order('event_slug', { ascending: true }),
    sb.from('mm_state').select('*'),
    sb.from('mm_kill_switch').select('killed,reason,updated_at').eq('id', 1).maybeSingle(),
  ])
  if (cfg.error)   return NextResponse.json({ error: cfg.error.message },   { status: 500 })
  if (state.error) return NextResponse.json({ error: state.error.message }, { status: 500 })

  type Row = Record<string, unknown>
  const stateByKey: Record<string, Row> = {}
  for (const s of (state.data ?? []) as Row[]) {
    const k = `${s.condition_id}|${s.outcome_index}|${s.side}`
    stateByKey[k] = s
  }
  const rows = ((cfg.data ?? []) as Row[]).map((c) => ({
    cfg: c,
    state_bid:   stateByKey[`${c.condition_id}|${c.outcome_index}|bid`]   ?? null,
    state_offer: stateByKey[`${c.condition_id}|${c.outcome_index}|offer`] ?? null,
  }))
  return NextResponse.json({
    rows,
    kill_switch:   kill.data ?? { killed: true, reason: 'unknown' },
    generated_at:  Date.now(),
  })
}
