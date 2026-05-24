import { NextResponse } from 'next/server'

// Bypass the 5-min raw.githubusercontent.com CDN by going through the GitHub
// Contents API directly (60s cache, ~10x fresher). Token optional — public
// repo works without auth but rate-limits at 60 req/hr per IP; with a token
// it's 5000/hr. We forward Vercel-side so the user never sees rate limits.

const GH_TOKEN = process.env.GITHUB_TOKEN

async function fetchJsonFromRepo(repo: string, path: string) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`
  const headers: Record<string, string> = {
    Accept:                'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`
  const r = await fetch(url, { headers, next: { revalidate: 30 } })
  if (!r.ok) throw new Error(`GitHub Contents API ${r.status}`)
  const data = await r.json()
  // Content can be base64 inline OR (>1MB) require the blob endpoint.
  let raw: string
  if (data.encoding === 'base64' && data.content) {
    raw = Buffer.from(data.content, 'base64').toString('utf-8')
  } else if (data.sha) {
    const blob = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${data.sha}`, { headers, next: { revalidate: 30 } })
    const b = await blob.json()
    raw = Buffer.from(b.content || '', 'base64').toString('utf-8')
  } else {
    throw new Error('unexpected GitHub Contents response shape')
  }
  return JSON.parse(raw)
}

export async function GET() {
  try {
    const data = await fetchJsonFromRepo('lpoklpok/LoLMLAnalysis', 'data/processed/poly_market_balance.json')
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=30' },
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 })
  }
}
