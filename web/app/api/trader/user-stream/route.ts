// SSE proxy for Polymarket fill events from the relay.
// Browser → /api/trader/user-stream → relay /user_stream → Polymarket user-WSS.
// The relay maintains the authenticated WSS connection upstream; we just
// pipe its SSE through, hiding the RELAY_SECRET from the browser.
//
// Events: each "data: <json>" payload is a trade event with shape:
//   { transaction_hash, market, asset, side, price, size, outcome, order_ids[], ts }
//
// Consumer (trader page) reacts by refetching positions immediately —
// fills appear in the UI within a few hundred ms of Polymarket's WSS push,
// not 5s polling + 30-60s data-api lag.

const RELAY_URL    = process.env.RELAY_URL    ?? 'https://kw-polymarket-trader-relay.fly.dev'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const runtime  = 'nodejs'
export const dynamic  = 'force-dynamic'
// Vercel Pro has a 5 min function timeout (Hobby is 10s). Browser EventSource
// auto-reconnects on close, so the stream resumes seamlessly.
export const maxDuration = 300

export async function GET(): Promise<Response> {
  if (!RELAY_URL || !RELAY_SECRET) {
    return new Response('relay not configured', { status: 500 })
  }
  try {
    const upstream = await fetch(`${RELAY_URL}/user_stream`, {
      headers: { 'X-Relay-Auth': RELAY_SECRET, 'Accept': 'text/event-stream' },
      cache:   'no-store',
    })
    if (!upstream.ok || !upstream.body) {
      return new Response(`relay upstream ${upstream.status}`, { status: 502 })
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
