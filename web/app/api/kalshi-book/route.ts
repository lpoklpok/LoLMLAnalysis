import { NextResponse } from 'next/server'

// Proxy to Kalshi's /orderbook endpoint. Kalshi doesn't send CORS headers
// so the browser can't fetch directly; this route fronts it from Vercel.
//
// Returns:
//   { bids: [[price_dollars, size], ...], asks: [[price_dollars, size], ...] }
//
// Bids = people offering to BUY YES at that price.
// Asks = people offering to SELL YES (computed as 1 − no_dollar_price).

export const dynamic = 'force-dynamic'
export const revalidate = 0

const KALSHI_URL        = 'https://api.elections.kalshi.com/trade-api/v2/markets'
const KALSHI_WORKER_URL = process.env.KALSHI_WORKER_URL ?? ''     // optional WSS-fed worker
const RELAY_SECRET      = process.env.RELAY_SECRET ?? ''

export async function GET(req: Request) {
  const ticker = new URL(req.url).searchParams.get('ticker')
  if (!ticker) return NextResponse.json({ error: 'missing ticker' }, { status: 400 })

  // Prefer WSS-fed worker (sub-second fresh). Fall back to direct REST.
  if (KALSHI_WORKER_URL && RELAY_SECRET) {
    try {
      const r = await fetch(`${KALSHI_WORKER_URL}/book?ticker=${encodeURIComponent(ticker)}`,
        { headers: { 'X-Relay-Auth': RELAY_SECRET }, cache: 'no-store',
          signal: AbortSignal.timeout(2000) })
      if (r.ok) {
        const d = await r.json() as { ticker?: string; bids?: [number, number][]; asks?: [number, number][]; warming_up?: boolean }
        if (!d.warming_up && (d.bids?.length ?? 0) + (d.asks?.length ?? 0) > 0) {
          return NextResponse.json({
            ticker, bids: d.bids ?? [], asks: d.asks ?? [],
            refreshed_at: new Date().toISOString(), source: 'worker',
          })
        }
      }
    } catch { /* fall through */ }
  }

  try {
    const r = await fetch(
      `${KALSHI_URL}/${encodeURIComponent(ticker)}/orderbook?depth=50`,
      { cache: 'no-store' },
    )
    if (!r.ok) return NextResponse.json({ error: `kalshi ${r.status}` }, { status: 502 })
    const data = await r.json() as { orderbook_fp?: { yes_dollars?: [string, string][], no_dollars?: [string, string][] } }
    const ob = data.orderbook_fp ?? {}

    // yes_dollars: people bidding to BUY YES at these prices
    const bids: [number, number][] = []
    for (const [px, sz] of ob.yes_dollars ?? []) {
      const p = parseFloat(px), s = parseFloat(sz)
      if (Number.isFinite(p) && Number.isFinite(s) && s > 0) bids.push([p, s])
    }
    // no_dollars: people bidding to BUY NO at these prices.
    // From YES perspective those are asks at (1 - p).
    const asks: [number, number][] = []
    for (const [px, sz] of ob.no_dollars ?? []) {
      const p = parseFloat(px), s = parseFloat(sz)
      if (Number.isFinite(p) && Number.isFinite(s) && s > 0) asks.push([Math.round((1 - p) * 100) / 100, s])
    }

    return NextResponse.json({
      ticker,
      bids,
      asks,
      refreshed_at: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 })
  }
}
