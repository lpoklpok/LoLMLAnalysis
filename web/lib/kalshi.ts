// Server-side Kalshi auth helper. Replicates the RSA-PSS-SHA256 signing
// from src/export_pnl_daily.py:_kalshi_sign so we can sign API requests
// from Next.js API routes using env-stored credentials.
//
// Env vars:
//   KALSHI_API_KEY     — RSA key UUID (Kalshi access key)
//   KALSHI_PRIVATE_KEY — PEM contents (multi-line). Newlines may be \n-escaped.

import crypto from 'crypto'

export const KALSHI_HOST = 'https://api.elections.kalshi.com'
export const KALSHI_API  = `${KALSHI_HOST}/trade-api/v2`

export function kalshiConfigured(): boolean {
  return !!(process.env.KALSHI_API_KEY && (process.env.KALSHI_PRIVATE_KEY || process.env.KALSHI_PRIVATE_KEY_PATH))
}

function getPem(): string {
  const raw = process.env.KALSHI_PRIVATE_KEY
  if (raw) return raw.replace(/\\n/g, '\n')
  // (We don't support KALSHI_PRIVATE_KEY_PATH on Vercel — env var only.)
  throw new Error('KALSHI_PRIVATE_KEY not set')
}

export interface KalshiSignedHeaders {
  'KALSHI-ACCESS-KEY':       string
  'KALSHI-ACCESS-TIMESTAMP': string
  'KALSHI-ACCESS-SIGNATURE': string
  'Accept':                  string
  'Content-Type'?:           string
}

/** Build the three Kalshi signature headers for a given method+path. */
export function kalshiSign(method: string, path: string): KalshiSignedHeaders {
  const apiKey = process.env.KALSHI_API_KEY
  if (!apiKey) throw new Error('KALSHI_API_KEY not set')
  const pem    = getPem()
  const ts     = Date.now().toString()             // ms
  const msg    = ts + method.toUpperCase() + path  // exact format Kalshi expects

  const sign = crypto.createSign('RSA-SHA256')
  sign.update(msg)
  sign.end()
  const signature = sign.sign({
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, 'base64')

  return {
    'KALSHI-ACCESS-KEY':       apiKey,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Accept':                  'application/json',
  }
}

/** Convenience helper for signed JSON requests. Returns parsed body + status. */
export async function kalshiRequest(method: 'GET' | 'POST' | 'DELETE',
                                     path: string,
                                     body?: unknown): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { ...kalshiSign(method, path) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(`${KALSHI_HOST}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  // Try to parse JSON; fall back to text wrapped if not JSON
  let data: unknown
  const text = await r.text()
  try { data = text ? JSON.parse(text) : null }
  catch { data = text }
  return { status: r.status, data }
}
