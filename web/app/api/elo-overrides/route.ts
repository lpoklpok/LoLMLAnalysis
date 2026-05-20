import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'

const OVERRIDES_PATH = path.join(process.cwd(), '..', 'data', 'processed', 'elo_overrides.json')

function readOverrides(): Record<string, { elo: number; original: number; reason: string }> {
  if (!existsSync(OVERRIDES_PATH)) return {}
  try { return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8')) } catch { return {} }
}

export async function GET() {
  return NextResponse.json(readOverrides())
}

export async function POST(request: Request) {
  const body = await request.json()
  const overrides = readOverrides()

  if (body.delete) {
    delete overrides[body.player]
  } else {
    overrides[body.player] = { elo: body.elo, original: body.original, reason: body.reason ?? '' }
  }

  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2))
  return NextResponse.json({ ok: true, overrides })
}
