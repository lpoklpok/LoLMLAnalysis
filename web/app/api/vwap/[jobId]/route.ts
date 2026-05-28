import { NextResponse } from 'next/server'

const RELAY_URL    = process.env.RELAY_URL    ?? 'https://kw-polymarket-trader-relay.fly.dev'
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export const dynamic = 'force-dynamic'

// Both machines on the relay keep their own in-memory job map. The web client
// passes `?machine=<id>` (returned by POST /vwap) so we can pin the request to
// the machine that owns the job via Fly's `fly-force-instance-id` header.
function relayHeaders(machine: string | null): Record<string, string> {
  const h: Record<string, string> = { 'X-Relay-Auth': RELAY_SECRET }
  if (machine) h['fly-force-instance-id'] = machine
  return h
}

async function proxy(url: string, init: RequestInit) {
  try {
    const r = await fetch(url, init)
    const txt = await r.text()
    let data: unknown
    try { data = JSON.parse(txt) } catch { data = { error: 'non-json relay response', body: txt.slice(0, 500) } }
    return NextResponse.json(data, { status: r.status })
  } catch (e) {
    return NextResponse.json({ error: 'relay fetch failed', detail: String(e) }, { status: 502 })
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  const machine = new URL(req.url).searchParams.get('machine')
  return proxy(
    `${RELAY_URL.replace(/\/+$/,'')}/vwap/${encodeURIComponent(jobId)}`,
    { headers: relayHeaders(machine) },
  )
}

export async function DELETE(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params
  if (!RELAY_SECRET) return NextResponse.json({ error: 'no relay secret' }, { status: 500 })
  const machine = new URL(req.url).searchParams.get('machine')
  return proxy(
    `${RELAY_URL.replace(/\/+$/,'')}/vwap/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST', headers: relayHeaders(machine) },
  )
}
