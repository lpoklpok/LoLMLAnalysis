import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic   = 'force-dynamic'
export const revalidate = 0

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ''
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? ''
const ORIGIN = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'

interface BookBest { price: number; size: number }
interface ScannerOutcome {
  outcome:    string
  token_id:   string | null
  pm_best:    { bid: BookBest | null; ask: BookBest | null } | null
}
interface ScannerSubmarket {
  market_type:  string
  outcomes:     ScannerOutcome[]
}
interface ScannerEvent {
  slug:       string
  submarkets: ScannerSubmarket[]
}
interface ScannerResp {
  events: ScannerEvent[]
}

export async function GET(): Promise<Response> {
  if (!SB_URL || !SB_KEY) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const sb = createClient(SB_URL, SB_KEY)

  // Pull config + state + scanner (live PM books) in parallel.
  const [cfg, state, kill, scanner] = await Promise.all([
    sb.from('mm_config').select('*').order('event_slug', { ascending: true }),
    sb.from('mm_state').select('*'),
    sb.from('mm_kill_switch').select('killed,reason,updated_at').eq('id', 1).maybeSingle(),
    fetch(`${ORIGIN}/api/scanner`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.ok ? r.json() as Promise<ScannerResp> : null).catch(() => null),
  ])
  if (cfg.error)   return NextResponse.json({ error: cfg.error.message },   { status: 500 })
  if (state.error) return NextResponse.json({ error: state.error.message }, { status: 500 })

  type Row = Record<string, unknown>

  // Build {(slug, market_type, outcome_index): pm_best} from scanner output
  const scannerBest: Record<string, { bid: BookBest | null; ask: BookBest | null }> = {}
  if (scanner) {
    for (const ev of scanner.events ?? []) {
      for (const sm of ev.submarkets ?? []) {
        for (let idx = 0; idx < (sm.outcomes ?? []).length; idx++) {
          const o = sm.outcomes[idx]
          if (o?.pm_best) {
            scannerBest[`${ev.slug}|${sm.market_type}|${idx}`] = o.pm_best
          }
        }
      }
    }
  }

  const stateByKey: Record<string, Row> = {}
  for (const s of (state.data ?? []) as Row[]) {
    const k = `${s.condition_id}|${s.outcome_index}|${s.side}`
    stateByKey[k] = s
  }
  const rows = ((cfg.data ?? []) as Row[]).map((c) => {
    // Merge scanner pm_best into state if worker hasn't yet captured the book
    // (i.e., row is not enabled / no WS subscription). The scanner gives us a
    // current snapshot so the cockpit can show book before the user enables.
    const scannerKey = `${c.event_slug}|${c.market_type}|${c.outcome_index}`
    const sb_book = scannerBest[scannerKey]
    const wsbid  = stateByKey[`${c.condition_id}|${c.outcome_index}|bid`] ?? null
    const wsoffer = stateByKey[`${c.condition_id}|${c.outcome_index}|offer`] ?? null
    // Override last_book_top_price/size with scanner values if state is stale or empty.
    const state_bid = wsbid
      ? { ...wsbid,
          last_book_top_price: wsbid.last_book_top_price ?? sb_book?.bid?.price ?? null,
          last_book_top_size:  wsbid.last_book_top_size  ?? sb_book?.bid?.size  ?? null }
      : (sb_book ? {
          last_book_top_price: sb_book.bid?.price ?? null,
          last_book_top_size:  sb_book.bid?.size  ?? null,
          active_order_id: null, active_price: null, active_size_shares: null,
          fills_today_usd: 0, position_shares: 0, paused_reason: null,
        } : null)
    const state_offer = wsoffer
      ? { ...wsoffer,
          last_book_top_price: wsoffer.last_book_top_price ?? sb_book?.ask?.price ?? null,
          last_book_top_size:  wsoffer.last_book_top_size  ?? sb_book?.ask?.size  ?? null }
      : (sb_book ? {
          last_book_top_price: sb_book.ask?.price ?? null,
          last_book_top_size:  sb_book.ask?.size  ?? null,
          active_order_id: null, active_price: null, active_size_shares: null,
          fills_today_usd: 0, position_shares: 0, paused_reason: null,
        } : null)
    return { cfg: c, state_bid, state_offer }
  })

  return NextResponse.json({
    rows,
    kill_switch:   kill.data ?? { killed: true, reason: 'unknown' },
    generated_at:  Date.now(),
  })
}
