import { NextResponse } from 'next/server'
import { kalshiRequest, kalshiConfigured } from '../../../../lib/kalshi'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// List current resting orders. Useful for the trader page to display "you have
// an order on this ticker" and to support cancel buttons.
export async function GET(req: Request) {
  if (!kalshiConfigured()) {
    return NextResponse.json({ error: 'Kalshi credentials not configured server-side' }, { status: 500 })
  }
  const url = new URL(req.url)
  const ticker = url.searchParams.get('ticker') ?? ''
  const path = ticker
    ? `/trade-api/v2/portfolio/orders?ticker=${encodeURIComponent(ticker)}&status=resting`
    : '/trade-api/v2/portfolio/orders?status=resting'
  const { status, data } = await kalshiRequest('GET', path)
  if (status >= 400) {
    return NextResponse.json({ error: 'kalshi error', status, body: data }, { status: 502 })
  }
  return NextResponse.json(data)
}

// Cancel a specific order id (DELETE /portfolio/orders/{id}).
export async function DELETE(req: Request) {
  if (!kalshiConfigured()) {
    return NextResponse.json({ error: 'Kalshi credentials not configured server-side' }, { status: 500 })
  }
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })
  const { status, data } = await kalshiRequest('DELETE', `/trade-api/v2/portfolio/orders/${encodeURIComponent(id)}`)
  if (status >= 400) {
    return NextResponse.json({ error: 'kalshi error', status, body: data }, { status: 502 })
  }
  return NextResponse.json({ ok: true, status, body: data })
}
