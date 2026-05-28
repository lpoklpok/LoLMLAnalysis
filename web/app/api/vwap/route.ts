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
  spread_poll_sec?:   number | null
  passive_wait_sec?:  number | null
  max_spread_cross?:  number
  max_recent_move?:        number
  recent_move_window_sec?: number
  dry_run?:           boolean
}

export async function POST(req: Request) {
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  let body: StartBody
  try { body = await req.json() as StartBody }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  if (!body.token_id || !body.side || !(body.total_size > 0) || !(body.horizon_sec > 0)) {
    return NextResponse.json({ error: 'missing fields', body }, { status: 400 })
  }

  try {
    const r = await fetch(`${RELAY_URL.replace(/\/+$/,'')}/vwap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Auth': RELAY_SECRET },
      body: JSON.stringify(body),
    })
    const txt = await r.text()
    let data: unknown
    try { data = JSON.parse(txt) } catch { data = { error: 'non-json relay response', body: txt.slice(0, 500) } }
    return NextResponse.json(data, { status: r.status })
  } catch (e) {
    return NextResponse.json({ error: 'relay fetch failed', detail: String(e) }, { status: 502 })
  }
}

export async function GET() {
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  try {
    const r = await fetch(`${RELAY_URL.replace(/\/+$/,'')}/vwap`, {
      headers: { 'X-Relay-Auth': RELAY_SECRET },
    })
    const txt = await r.text()
    let data: unknown
    try { data = JSON.parse(txt) } catch { data = { error: 'non-json relay response', body: txt.slice(0, 500) } }
    return NextResponse.json(data, { status: r.status })
  } catch (e) {
    return NextResponse.json({ error: 'relay fetch failed', detail: String(e) }, { status: 502 })
  }
}
