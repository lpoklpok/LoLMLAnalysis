import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const MM_WORKER_URL = process.env.KALSHI_MM_WORKER_URL ?? 'https://kw-kalshi-mm.fly.dev'
const RELAY_SECRET  = process.env.RELAY_SECRET ?? ''

export async function POST(req: Request): Promise<Response> {
  let body: { on?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  const on = body.on === true
  try {
    const r = await fetch(`${MM_WORKER_URL}/kill?on=${on}`, {
      method:  'POST',
      headers: { 'X-Relay-Auth': RELAY_SECRET },
      signal:  AbortSignal.timeout(5000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return NextResponse.json({ error: j?.error ?? `HTTP ${r.status}` }, { status: r.status })
    return NextResponse.json(j)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function GET(): Promise<Response> {
  try {
    const r = await fetch(`${MM_WORKER_URL}/healthz`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    return NextResponse.json(await r.json())
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
