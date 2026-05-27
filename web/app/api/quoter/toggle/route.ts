import { NextResponse } from 'next/server'

// Server-side env (NOT NEXT_PUBLIC) so the service-role key never reaches the browser.
const SB_URL       = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY ?? ''
const QUOTER_URL   = process.env.QUOTER_URL    ?? 'https://kw-polymarket-quoter.fly.dev'
const RELAY_SECRET = process.env.RELAY_SECRET  ?? ''

interface ToggleBody {
  event_slug:        string
  market_type:       string
  outcome_idx:       0 | 1
  enabled:           boolean
  outcome_name?:     string
  event_title?:      string
  match_question?:   string
  max_size_usd?:     number
  edge_threshold_pp?: number
  target_fair?:      number | null
  token_id?:         string | null
  // Bulk mode: instead of a single toggle, accept an array under `rows`.
  rows?: Array<{
    event_slug: string; market_type: string; outcome_idx: 0 | 1; enabled: boolean
    outcome_name?: string; event_title?: string; match_question?: string
    max_size_usd?: number; edge_threshold_pp?: number
    target_fair?: number | null; token_id?: string | null
  }>
}

export async function POST(req: Request) {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'Supabase not configured server-side' }, { status: 500 })
  }
  const body = (await req.json()) as ToggleBody
  const rows = body.rows ?? [body]
  // Normalize + add updated_at
  const upsertRows = rows.map(r => ({
    event_slug:        r.event_slug,
    market_type:       r.market_type,
    outcome_idx:       r.outcome_idx,
    outcome_name:      r.outcome_name ?? null,
    event_title:       r.event_title ?? null,
    match_question:    r.match_question ?? null,
    enabled:           r.enabled,
    max_size_usd:      r.max_size_usd ?? 25,
    edge_threshold_pp: r.edge_threshold_pp ?? 3,
    target_fair:       r.target_fair ?? null,
    token_id:          r.token_id ?? null,
    updated_at:        new Date().toISOString(),
  }))

  const r = await fetch(`${SB_URL.replace(/\/+$/, '')}/rest/v1/quoter_active`, {
    method: 'POST',
    headers: {
      apikey:        SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(upsertRows),
  })
  if (!r.ok) {
    return NextResponse.json({ error: `supabase ${r.status}`, body: await r.text() }, { status: 502 })
  }
  const rowsBack = await r.json()
  // Fire-and-forget poke to the quoter so it reconciles immediately (vs.
  // waiting for its next periodic poll). Don't block the user response.
  if (QUOTER_URL && RELAY_SECRET) {
    fetch(`${QUOTER_URL.replace(/\/+$/, '')}/poke`, {
      method: 'POST', headers: { 'X-Relay-Auth': RELAY_SECRET },
    }).catch(() => { /* quoter might be restarting — fine, next poll will pick it up */ })
  }
  return NextResponse.json({ ok: true, updated: upsertRows.length, rows: rowsBack })
}
