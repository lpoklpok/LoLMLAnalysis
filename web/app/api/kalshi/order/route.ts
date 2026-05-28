import { NextResponse } from 'next/server'
import { randomUUID }    from 'crypto'
import { kalshiRequest, kalshiConfigured } from '../../../../lib/kalshi'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface OrderBody {
  ticker:       string
  side:         'yes' | 'no'
  action:       'buy' | 'sell'
  count:        number             // contracts
  // Either yes_price OR no_price expected (cents, 1..99). Pass only the one
  // matching the `side`. Limit orders only.
  yes_price?:   number
  no_price?:    number
  // Optional client-supplied id; we'll generate if absent
  client_order_id?: string
  // Optional GTC; default to expiration_ts ~1h from now (Kalshi uses unix sec)
  expiration_ts?: number
}

export async function POST(req: Request) {
  if (!kalshiConfigured()) {
    return NextResponse.json({ error: 'Kalshi credentials not configured server-side' }, { status: 500 })
  }
  let body: OrderBody
  try {
    body = (await req.json()) as OrderBody
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // Validate
  if (!body.ticker || !body.side || !body.action || !body.count) {
    return NextResponse.json({ error: 'missing required fields (ticker, side, action, count)' }, { status: 400 })
  }
  if (!['yes', 'no'].includes(body.side)) {
    return NextResponse.json({ error: 'side must be yes or no' }, { status: 400 })
  }
  if (!['buy', 'sell'].includes(body.action)) {
    return NextResponse.json({ error: 'action must be buy or sell' }, { status: 400 })
  }
  if (body.count < 1 || !Number.isInteger(body.count)) {
    return NextResponse.json({ error: 'count must be a positive integer' }, { status: 400 })
  }
  const px = body.side === 'yes' ? body.yes_price : body.no_price
  if (px == null || px < 1 || px > 99 || !Number.isInteger(px)) {
    return NextResponse.json({ error: `${body.side}_price must be an integer 1..99 (cents)` }, { status: 400 })
  }

  const payload: Record<string, unknown> = {
    action:          body.action,
    client_order_id: body.client_order_id ?? randomUUID(),
    count:           body.count,
    side:            body.side,
    ticker:          body.ticker,
    type:            'limit',
    [body.side === 'yes' ? 'yes_price' : 'no_price']: px,
  }
  if (body.expiration_ts) payload.expiration_ts = body.expiration_ts

  const { status, data } = await kalshiRequest('POST', '/trade-api/v2/portfolio/orders', payload)
  if (status >= 400) {
    return NextResponse.json({ error: 'kalshi rejected', status, body: data }, { status: 502 })
  }
  return NextResponse.json({ ok: true, status, body: data })
}
