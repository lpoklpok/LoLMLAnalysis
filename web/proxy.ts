import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Simple shared-password gate for UI pages. /api/* is intentionally NOT
// matched so the kw-polymarket-alerts scanner_alerts worker (and any other
// integrations) can keep pulling without auth headers.
//
// Set SITE_PASSWORD in Vercel env vars to enable. Unset = open site (useful
// for local dev). On login, the cookie value is set to the password; we
// compare it on each request. Cookie is httponly + secure so JS can't read
// it and it only travels over HTTPS.
const COOKIE_NAME = 'site_auth'

export function proxy(request: NextRequest) {
  const pw = process.env.SITE_PASSWORD
  if (!pw) return NextResponse.next()  // not configured → open

  const supplied = request.cookies.get(COOKIE_NAME)?.value
  if (supplied === pw) return NextResponse.next()

  // Redirect to /login, preserving the original path so we can bounce back.
  const url = request.nextUrl.clone()
  const target = url.pathname + url.search
  url.pathname = '/login'
  url.search = `?next=${encodeURIComponent(target)}`
  return NextResponse.redirect(url)
}

export const config = {
  // Match everything except: /api/*, Next internals, static assets, and
  // /login itself (so the form is reachable).
  matcher: ['/((?!api|_next|favicon|login|.*\\..*).*)'],
}
