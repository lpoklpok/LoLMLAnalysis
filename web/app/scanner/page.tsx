'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

// ── Types (mirror /api/scanner) ──────────────────────────────────────────
interface BookLevel { price: number; size: number }
interface OutcomeBook { bids: BookLevel[]; asks: BookLevel[] }
interface OutcomeView {
  outcome:     string
  fair:        number | null
  pm:          OutcomeBook | null
  kalshi:      OutcomeBook | null
  pm_best:     { bid: BookLevel | null; ask: BookLevel | null } | null
  kalshi_best: { bid: BookLevel | null; ask: BookLevel | null } | null
}
interface SubmarketView {
  market_type:  string
  market_label: string
  outcomes:     OutcomeView[]
}
interface EventView {
  slug:           string
  title:          string
  league:         string
  team1:          string
  team2:          string
  best_of:        number
  pred_blue_win:  number | null
  pred_blue_team: string
  date:           string
  submarkets:     SubmarketView[]
}
interface EdgeRow {
  event_slug:    string
  event_title:   string
  market_label:  string
  outcome:       string
  venue:         'pm' | 'kalshi'
  side:          'bid' | 'ask'
  price:         number
  size:          number
  fair:          number
  edge_per_share: number
  total_edge_usd: number
}
interface LiquidityRow {
  event_slug:    string
  event_title:   string
  market_label:  string
  outcome:       string
  venue:         'pm' | 'kalshi'
  side:          'bid' | 'ask'
  best_price:    number
  best_size:     number
  plus1_size:    number
  notional_usd:  number
}
interface ScannerResponse {
  events:         EventView[]
  top_edges:      EdgeRow[]
  top_liquidity:  LiquidityRow[]
  generated_at:   number
  ms_elapsed:     number
}

// ── Helpers ──────────────────────────────────────────────────────────────
const fmtUsd = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—'
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
const fmtCent = (p: number | null | undefined): string => {
  if (p == null || !Number.isFinite(p)) return '—'
  return (p * 100).toFixed(1) + 'c'
}
const fmtSize = (s: number): string => s >= 1000 ? `${(s/1000).toFixed(1)}k` : Math.round(s).toString()

function edgeHighlightClass(edgePerShare: number | null | undefined): string {
  if (edgePerShare == null || !Number.isFinite(edgePerShare)) return ''
  if (edgePerShare >= 0.10) return 'text-emerald-300 font-bold'
  if (edgePerShare >= 0.05) return 'text-emerald-400 font-semibold'
  if (edgePerShare >= 0.02) return 'text-emerald-500'
  return ''
}

function BookCell({ best, fair, side, venue }: {
  best: { bid: BookLevel | null; ask: BookLevel | null } | null
  fair: number | null
  side: 'bid' | 'ask'
  venue: 'pm' | 'kalshi'
}) {
  if (!best) return <span className="text-gray-700">—</span>
  const lvl = side === 'bid' ? best.bid : best.ask
  if (!lvl) return <span className="text-gray-700">—</span>
  const edgePerShare = fair != null
    ? (side === 'bid' ? lvl.price - fair : fair - lvl.price)
    : null
  const hasEdge = edgePerShare != null && edgePerShare >= 0.02
  const cls = side === 'bid' ? 'text-green-300' : 'text-red-300'
  return (
    <span className={`font-mono ${hasEdge ? edgeHighlightClass(edgePerShare) : cls}`}
          title={`${venue} ${side} @ ${fmtCent(lvl.price)} x ${fmtSize(lvl.size)} shares`}>
      {fmtCent(lvl.price)} <span className="text-gray-600">({fmtSize(lvl.size)})</span>
      {hasEdge && <span className="ml-1 text-amber-300">*</span>}
    </span>
  )
}

export default function ScannerPage() {
  const [data, setData] = useState<ScannerResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    async function pull() {
      try {
        const r = await fetch('/api/scanner', { cache: 'no-store' })
        if (!r.ok) { if (!cancelled) setErr(`server ${r.status}`); return }
        const d = await r.json() as ScannerResponse
        if (!cancelled) { setData(d); setErr(null); setLastFetched(Date.now()) }
      } catch (e) { if (!cancelled) setErr(String(e)) }
    }
    pull()
    const id = setInterval(pull, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const ageS = Math.round((Date.now() - lastFetched) / 1000)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="px-4 md:px-6 py-3 border-b border-gray-800 flex items-baseline gap-4">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Home</Link>
        <h1 className="text-xl font-bold">Scanner</h1>
        <span className="text-xs text-gray-500">Per-event submarkets + edge/liquidity rankings</span>
        <span className="ml-auto text-xs text-gray-500">
          {data ? `${data.events.length} events · ${data.ms_elapsed}ms upstream · refreshed ${ageS}s ago` : 'loading…'}
        </span>
      </div>

      {err && <div className="m-4 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-200">{err}</div>}

      {data && (
        <div className="grid md:grid-cols-2 gap-4 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 text-xs uppercase tracking-wide text-amber-300 font-semibold">
              Top Edge Opportunities (fair − price × size, $)
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 text-gray-500 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Event · Market · Outcome</th>
                    <th className="px-2 py-1.5 text-right">Venue · Side</th>
                    <th className="px-2 py-1.5 text-right">Px</th>
                    <th className="px-2 py-1.5 text-right">Sz</th>
                    <th className="px-2 py-1.5 text-right">Fair</th>
                    <th className="px-2 py-1.5 text-right">Edge $</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-900">
                  {data.top_edges.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-3 text-center text-gray-600">No edge &ge; 0.02 right now.</td></tr>
                  )}
                  {data.top_edges.map((e, i) => (
                    <tr key={i} className="hover:bg-gray-900/60">
                      <td className="px-2 py-1.5">
                        <div className="text-gray-300 truncate max-w-[260px]" title={e.event_title}>{e.event_title}</div>
                        <div className="text-[10px] text-gray-500">{e.market_label} · {e.outcome}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400">
                        <span className={e.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}>{e.venue.toUpperCase()}</span>
                        {' '}
                        <span className={e.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{e.side.toUpperCase()}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtCent(e.price)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-400">{fmtSize(e.size)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-amber-300">{fmtCent(e.fair)}</td>
                      <td className={`px-2 py-1.5 text-right font-mono font-semibold ${edgeHighlightClass(e.edge_per_share)}`}>
                        {fmtUsd(e.total_edge_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 text-xs uppercase tracking-wide text-blue-300 font-semibold">
              Top Liquidity at NBBO + 1 (notional $)
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 text-gray-500 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Event · Market · Outcome</th>
                    <th className="px-2 py-1.5 text-right">Venue · Side</th>
                    <th className="px-2 py-1.5 text-right">Best</th>
                    <th className="px-2 py-1.5 text-right">+1c</th>
                    <th className="px-2 py-1.5 text-right">Notional</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-900">
                  {data.top_liquidity.length === 0 && (
                    <tr><td colSpan={5} className="px-2 py-3 text-center text-gray-600">No liquidity yet.</td></tr>
                  )}
                  {data.top_liquidity.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-900/60">
                      <td className="px-2 py-1.5">
                        <div className="text-gray-300 truncate max-w-[260px]" title={r.event_title}>{r.event_title}</div>
                        <div className="text-[10px] text-gray-500">{r.market_label} · {r.outcome}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400">
                        <span className={r.venue === 'pm' ? 'text-blue-300' : 'text-purple-300'}>{r.venue.toUpperCase()}</span>
                        {' '}
                        <span className={r.side === 'bid' ? 'text-green-400' : 'text-red-400'}>{r.side.toUpperCase()}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-300">
                        {fmtCent(r.best_price)} <span className="text-gray-600">({fmtSize(r.best_size)})</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-500">{fmtSize(r.plus1_size)}</td>
                      <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtUsd(r.notional_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="p-4 space-y-4">
        {data?.events.map(ev => (
          <div key={ev.slug} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-baseline gap-3">
              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                ev.league === 'LCK' ? 'bg-blue-900/60 text-blue-300' :
                ev.league === 'LEC' ? 'bg-purple-900/60 text-purple-300' :
                ev.league === 'LPL' ? 'bg-red-900/60 text-red-300' :
                ev.league === 'LCS' ? 'bg-emerald-900/60 text-emerald-300' :
                'bg-gray-800 text-gray-400'
              }`}>{ev.league}</span>
              <span className="text-[10px] text-gray-500">Bo{ev.best_of}</span>
              <span className="text-sm font-medium text-gray-100">{ev.team1} <span className="text-gray-600 mx-1">vs</span> {ev.team2}</span>
              <span className="ml-auto text-[10px] text-gray-500">
                G1 prior ({ev.pred_blue_team.slice(0, 12)}): <span className="font-mono text-gray-300">{fmtCent(ev.pred_blue_win)}</span>
              </span>
            </div>

            <table className="w-full text-xs">
              <thead className="text-gray-500 bg-gray-950/40">
                <tr>
                  <th className="px-3 py-2 text-left font-normal">Market</th>
                  <th className="px-3 py-2 text-left font-normal">Outcome</th>
                  <th className="px-3 py-2 text-right font-normal">Fair</th>
                  <th className="px-3 py-2 text-right font-normal border-l border-gray-800" colSpan={2}>Polymarket</th>
                  <th className="px-3 py-2 text-right font-normal border-l border-gray-800" colSpan={2}>Kalshi (combined)</th>
                </tr>
                <tr className="text-[10px] text-gray-600 border-b border-gray-800">
                  <th></th>
                  <th></th>
                  <th></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-green-500">BID (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-red-400">ASK (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal border-l border-gray-800"><span className="text-green-500">BID (sz)</span></th>
                  <th className="px-3 pb-1.5 text-right font-normal"><span className="text-red-400">ASK (sz)</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {ev.submarkets.flatMap((sm, smIdx) =>
                  sm.outcomes.map((o, oIdx) => (
                    <tr key={`${smIdx}-${oIdx}`} className={oIdx === 0 ? 'bg-gray-900/40' : ''}>
                      <td className="px-3 py-2 text-gray-400">{oIdx === 0 ? sm.market_label : ''}</td>
                      <td className="px-3 py-2 text-gray-200">{o.outcome}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-300 font-semibold">{fmtCent(o.fair)}</td>
                      <td className="px-3 py-2 text-right border-l border-gray-800">
                        <BookCell best={o.pm_best} fair={o.fair} side="bid" venue="pm" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <BookCell best={o.pm_best} fair={o.fair} side="ask" venue="pm" />
                      </td>
                      <td className="px-3 py-2 text-right border-l border-gray-800">
                        <BookCell best={o.kalshi_best} fair={o.fair} side="bid" venue="kalshi" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <BookCell best={o.kalshi_best} fair={o.fair} side="ask" venue="kalshi" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ))}
        {data && data.events.length === 0 && (
          <div className="text-sm text-gray-500 text-center p-6">
            No events in the next 48h. Check back when LCK/LEC/LCS markets open.
          </div>
        )}
      </div>
    </div>
  )
}
