import { NextResponse } from 'next/server'

const RELAY_URL    = process.env.RELAY_URL    ?? 'https://kw-polymarket-trader-relay.fly.dev'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const dynamic = 'force-dynamic'

type StartBody = {
  token_id:           string
  side:              'BUY' | 'SELL'
  total_size:         number
  horizon_sec:        number
  n_slices?:          number
  max_price?:         number | null
  reprice_after_sec?: number | null
  max_spread_cross?:  number
  dry_run?:           boolean
}

export async function POST(req: Request) {
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  let body: StartBody
  try { body = await req.json() as StartBody }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  if (!body.token_id || !body.side || !(body.total_size > 0) || !(body.horizon_sec > 0)) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }

  const r = await fetch(`${RELAY_URL.replace(/\/+$/,'')}/vwap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Auth': RELAY_SECRET },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  return NextResponse.json(data, { status: r.status })
}

export async function GET() {
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  // List jobs across both relay machines: fan out by repeating the call —
  // Fly's edge will route to whichever is closest. The "list" surface is
  // per-machine, so the page may need to call twice or fan out via fly-replay.
  const r = await fetch(`${RELAY_URL.replace(/\/+$/,'')}/vwap`, {
    headers: { 'X-Relay-Auth': RELAY_SECRET },
  })
  const data = await r.json().catch(() => ({}))
  return NextResponse.json(data, { status: r.status })
}
