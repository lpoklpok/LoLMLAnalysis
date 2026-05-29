import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const pw = process.env.SITE_PASSWORD
  if (!pw) {
    // Auth not configured — refuse to set a meaningless cookie.
    return NextResponse.json({ error: 'SITE_PASSWORD not configured' }, { status: 503 })
  }
  let body: { password?: string } = {}
  try { body = await req.json() } catch { /* ignore */ }
  if (body.password !== pw) {
    return NextResponse.json({ error: 'invalid' }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set('site_auth', pw, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   60 * 60 * 24 * 30,  // 30 days
  })
  return res
}
