// SSE proxy for Kalshi fill events from the Kalshi worker.
// Browser → /api/kalshi/user-stream → worker /user_stream → Kalshi user-WSS.
// The worker maintains the authenticated WSS upstream; we just pipe its SSE
// through, hiding RELAY_SECRET from the browser.

const WORKER_URL   = process.env.KALSHI_WORKER_URL ?? ''
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const runtime    = 'nodejs'
export const dynamic    = 'force-dynamic'
export const maxDuration = 300

export async function GET(): Promise<Response> {
  if (!WORKER_URL || !RELAY_SECRET) {
    return new Response('kalshi worker not configured', { status: 500 })
  }
  try {
    const upstream = await fetch(`${WORKER_URL}/user_stream`, {
      headers: { 'X-Relay-Auth': RELAY_SECRET, 'Accept': 'text/event-stream' },
      cache:   'no-store',
    })
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
