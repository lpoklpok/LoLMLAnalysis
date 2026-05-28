// Snapshot proxy: browser → /api/lol/live-state → LoLLivePredictor /state.
// Returns the current set of monitored live games with model output.
// Worker URL + RELAY_SECRET stay server-side.

const WORKER_URL   = process.env.LOL_LIVE_WORKER_URL ?? ''
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const runtime    = 'nodejs'
export const dynamic    = 'force-dynamic'

export async function GET(): Promise<Response> {
  if (!WORKER_URL || !RELAY_SECRET) {
    return Response.json({ error: 'lol live worker not configured' }, { status: 500 })
  }
  try {
    const r = await fetch(`${WORKER_URL}/state`, {
      headers: { 'X-Relay-Auth': RELAY_SECRET },
      cache:   'no-store',
    })
    if (!r.ok) {
      return Response.json({ error: `worker ${r.status}` }, { status: 502 })
    }
    return new Response(r.body, {
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 })
  }
}
