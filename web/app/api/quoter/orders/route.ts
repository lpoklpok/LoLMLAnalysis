import { NextResponse } from 'next/server'

const RELAY_URL    = process.env.RELAY_URL    ?? 'https://kw-polymarket-trader-relay.fly.dev'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const dynamic = 'force-dynamic'

// Proxy to the trader relay's /orders endpoint so the page can show
// what's actually resting on Polymarket right now.
export async function GET() {
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  try {
    const r = await fetch(`${RELAY_URL.replace(/\/+$/,'')}/orders`, {
      headers: { 'X-Relay-Auth': RELAY_SECRET },
      cache: 'no-store',
    })
    if (!r.ok) return NextResponse.json({ error: `relay ${r.status}` }, { status: 502 })
    return NextResponse.json({ orders: await r.json() })
  } catch (e) {
    return NextResponse.json({ error: `relay error: ${e}` }, { status: 502 })
  }
}
