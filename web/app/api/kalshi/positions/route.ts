import { NextResponse } from 'next/server'
import { kalshiRequest, kalshiConfigured } from '../../../../lib/kalshi'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Returns the user's positions, optionally filtered by ticker(s).
// Powers the "combined YES/NO ladder" — when a user clicks "sell at p" without
// any YES inventory we route it as a "buy NO at 1−p" instead.
export async function GET(req: Request) {
  if (!kalshiConfigured()) {
    return NextResponse.json({ error: 'Kalshi credentials not configured server-side' }, { status: 500 })
  }
  const url = new URL(req.url)
  const ticker = url.searchParams.get('ticker') ?? ''
  const path = ticker
    ? `/trade-api/v2/portfolio/positions?tickers=${encodeURIComponent(ticker)}`
    : '/trade-api/v2/portfolio/positions'
  const { status, data } = await kalshiRequest('GET', path)
  if (status >= 400) {
    return NextResponse.json({ error: 'kalshi error', status, body: data }, { status: 502 })
  }
  return NextResponse.json(data)
}
