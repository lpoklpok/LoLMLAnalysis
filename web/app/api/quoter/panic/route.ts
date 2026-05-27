import { NextResponse } from 'next/server'

// Server-side env only — never exposed to the browser.
const SB_URL       = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY ?? ''
const RELAY_URL    = process.env.RELAY_URL    ?? 'https://kw-polymarket-trader-relay.fly.dev'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const dynamic = 'force-dynamic'

/**
 * Panic kill: (1) disable every row in quoter_active so the quoter stops
 * re-posting, then (2) immediately cancel every open Polymarket order via
 * the trader relay. Step 2 cancels ALL orders for the proxy wallet — that
 * includes any manually-placed quotes too, which is the point of "panic".
 */
export async function POST() {
  if (!SB_URL || !SB_KEY) return NextResponse.json({ error: 'no supabase' }, { status: 500 })
  if (!RELAY_SECRET)     return NextResponse.json({ error: 'no relay secret' }, { status: 500 })

  // 1. Disable all enabled rows in quoter_active
  const upd = await fetch(`${SB_URL.replace(/\/+$/,'')}/rest/v1/quoter_active?enabled=eq.true`, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
  })
  const disabled = upd.ok ? ((await upd.json()) as unknown[]).length : 0

  // 2. Hit the relay /cancel_all endpoint
  let cancelled: unknown = null
  let cancelErr: string | null = null
  try {
    const r = await fetch(`${RELAY_URL.replace(/\/+$/,'')}/cancel_all`, {
      method: 'POST',
      headers: { 'X-Relay-Auth': RELAY_SECRET },
    })
    if (r.ok) cancelled = await r.json()
    else cancelErr = `relay ${r.status}: ${(await r.text()).slice(0, 200)}`
  } catch (e) {
    cancelErr = `relay error: ${e}`
  }

  return NextResponse.json({
    ok:        cancelErr === null,
    disabled,                  // # of quoter_active rows flipped off
    cancelled,                 // relay response payload
    cancel_error: cancelErr,   // null on success
  })
}
