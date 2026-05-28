// SSE proxy: browser → /api/kalshi/book-stream?tickers=T1,T2
//             → KalshiPriceWorker /book_stream
// Each `data: <json>` line is a full orderbook snapshot for one ticker,
// emitted right after the worker applies a delta from Kalshi's WSS.
//
// Replaces the 750ms REST poll the trader ladder modal was doing —
// updates now arrive in real time as Kalshi pushes them.

const WORKER_URL   = process.env.KALSHI_WORKER_URL ?? ''
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const runtime    = 'nodejs'
export const dynamic    = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: Request): Promise<Response> {
  if (!WORKER_URL || !RELAY_SECRET) {
    return new Response('kalshi worker not configured', { status: 500 })
  }
  const tickers = new URL(req.url).searchParams.get('tickers') ?? ''
  if (!tickers.trim()) {
    return new Response('missing tickers', { status: 400 })
  }
  try {
    const upstream = await fetch(
      `${WORKER_URL}/book_stream?tickers=${encodeURIComponent(tickers)}`,
      {
        headers: { 'X-Relay-Auth': RELAY_SECRET, 'Accept': 'text/event-stream' },
        cache:   'no-store',
      },
    )
    if (!upstream.ok || !upstream.body) {
      return new Response(`worker upstream ${upstream.status}`, { status: 502 })
    }
    return new Response(upstream.body, {
      headers: {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (e) {
    return new Response(`proxy error: ${String(e)}`, { status: 502 })
  }
}
