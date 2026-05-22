'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

// ── Types ───────────────────────────────────────────────────────────────────

interface Prediction {
  blue_team: string
  red_team: string
  league: string
  best_of: number
  pred_blue_win: number
  date: string
  poly_event_slug: string | null
  poly_team1: string | null   // OE canonical name of polymarket outcome[0]
  poly_volume: number | null
  blue_elo: number | null
  red_elo: number | null
  elo_diff: number | null
}

interface Submarket {
  market_type: string
  question: string
  outcomes: [string, string]
  outcome_mids: [number, number]
  mid_source: 'clob_mid' | 'gamma_last'
  volume: number
}

interface KalshiSide {
  team: string
  yes_bid: number | null
  yes_ask: number | null
  yes_mid: number | null
  volume_24h: number | null
}

interface KalshiMatch {
  event_ticker: string
  sides: [KalshiSide | null, KalshiSide | null]
}

interface EventDetail {
  slug: string
  title: string
  team1: string
  team2: string
  best_of: number
  submarkets: Submarket[]
  kalshi: KalshiMatch | null
  refreshed_at: string
}

// ── Math helpers ────────────────────────────────────────────────────────────

function seriesProb(p: number, bestOf: number): number {
  if (bestOf <= 1) return p
  if (bestOf === 3) return p * p * (3 - 2 * p)
  if (bestOf === 5) return p * p * p * (10 - 15 * p + 6 * p * p)
  return p
}

function fmtPct(p: number | null | undefined, signed = false) {
  if (p == null || !Number.isFinite(p)) return '—'
  const v = (p * 100)
  if (signed) return (v >= 0 ? '+' : '') + v.toFixed(1) + 'pp'
  return v.toFixed(1) + '%'
}

function edgeColor(edge: number | null) {
  if (edge == null || !Number.isFinite(edge)) return 'text-gray-500'
  if (edge >=  0.10) return 'text-green-300 font-bold'
  if (edge >=  0.05) return 'text-green-400 font-semibold'
  if (edge >=  0.02) return 'text-green-500'
  if (edge <= -0.10) return 'text-red-300 font-bold'
  if (edge <= -0.05) return 'text-red-400 font-semibold'
  if (edge <= -0.02) return 'text-red-500'
  return 'text-gray-400'
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms < -60 * 60 * 1000) {
    // started > 1h ago
    const h = Math.floor(-ms / (3600 * 1000))
    return `started ${h}h ago`
  }
  if (ms < 0) return 'live'
  const totalMin = Math.floor(ms / (60 * 1000))
  const d = Math.floor(totalMin / (60 * 24))
  const h = Math.floor((totalMin % (60 * 24)) / 60)
  const m = totalMin % 60
  if (d > 0) return `in ${d}d ${h}h`
  if (h > 0) return `in ${h}h ${m}m`
  return `in ${m}m`
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function Sidebar({
  events, selectedSlug, onSelect,
}: {
  events: Prediction[]
  selectedSlug: string | null
  onSelect: (slug: string) => void
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-800 sticky top-0 bg-gray-950 z-10">
        <div className="text-xs uppercase tracking-wide text-gray-500">Upcoming Events</div>
        <div className="text-[10px] text-gray-600 mt-1">{events.length} markets · j/k or ↑/↓ to switch</div>
      </div>
      <ul className="divide-y divide-gray-800">
        {events.map(e => {
          const sel = e.poly_event_slug === selectedSlug
          return (
            <li key={e.poly_event_slug ?? `${e.blue_team}-${e.red_team}`}>
              <button
                onClick={() => e.poly_event_slug && onSelect(e.poly_event_slug)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  sel ? 'bg-blue-900/40 border-l-2 border-blue-500'
                      : 'hover:bg-gray-900 border-l-2 border-transparent'
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                    e.league === 'LCK' ? 'bg-blue-900/60 text-blue-300' :
                    e.league === 'LEC' ? 'bg-purple-900/60 text-purple-300' :
                    e.league === 'LPL' ? 'bg-red-900/60 text-red-300' :
                    e.league === 'LCS' ? 'bg-emerald-900/60 text-emerald-300' :
                    e.league === 'EWC' ? 'bg-amber-900/60 text-amber-300' :
                    'bg-gray-800 text-gray-400'
                  }`}>{e.league}</span>
                  <span className="text-[10px] text-gray-500">Bo{e.best_of}</span>
                  <span className="text-[10px] text-gray-600 ml-auto">{timeUntil(e.date)}</span>
                </div>
                <div className="mt-1.5 text-sm text-gray-200 truncate">
                  <span className="font-medium">{e.blue_team}</span>
                  <span className="text-gray-600 mx-1.5">vs</span>
                  <span className="font-medium">{e.red_team}</span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────

interface Row {
  market_type: string
  market_label: string
  outcome_label: string
  fv: number | null
  mid: number | null
  edge: number | null
  mid_source: 'clob_mid' | 'gamma_last'
  volume: number
  // Optional Kalshi side (only for Match Winner rows)
  kalshi_bid: number | null
  kalshi_ask: number | null
  kalshi_mid: number | null
  kalshi_edge_vs_fv: number | null
}

function buildRows(pred: Prediction, detail: EventDetail | null): Row[] {
  if (!detail) return []
  const rows: Row[] = []
  const bo = pred.best_of
  // Per-game side-neutral prob for blue team (the team we predict against)
  const pBlue = pred.pred_blue_win

  // For each polymarket submarket, compute model fair value for outcomes[0] and outcomes[1].
  for (const sm of detail.submarkets) {
    const [o1, o2] = sm.outcomes
    const [mid1, mid2] = sm.outcome_mids

    let fv1: number | null = null
    let fv2: number | null = null
    let market_label: string = sm.question

    if (sm.market_type === 'match_winner') {
      market_label = 'Match Winner'
      // P(team1 wins series). team1 == blue → use pBlue, else use 1-pBlue
      const team1IsBlue = o1.trim().toLowerCase() === pred.blue_team.trim().toLowerCase()
      const pTeam1Game = team1IsBlue ? pBlue : 1 - pBlue
      fv1 = seriesProb(pTeam1Game, bo)
      fv2 = 1 - fv1
    } else if (sm.market_type.startsWith('game_') && sm.market_type.endsWith('_winner')) {
      const gnum = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
      market_label = `Game ${gnum} Winner`
      // Per-game side-neutral prob, same value for every game
      const team1IsBlue = o1.trim().toLowerCase() === pred.blue_team.trim().toLowerCase()
      fv1 = team1IsBlue ? pBlue : 1 - pBlue
      fv2 = 1 - fv1
    } else if (sm.market_type === 'game_handicap') {
      market_label = 'Game Handicap'
      // Skip FV for v1 — handicap math is more involved (see merge_polymarket_data math)
      fv1 = null
      fv2 = null
    }

    // Kalshi values only attached on match_winner rows
    const kalshi1 = sm.market_type === 'match_winner' ? detail.kalshi?.sides[0] : null
    const kalshi2 = sm.market_type === 'match_winner' ? detail.kalshi?.sides[1] : null

    rows.push({
      market_type:    sm.market_type,
      market_label,
      outcome_label:  o1,
      fv:             fv1,
      mid:            mid1,
      edge:           fv1 != null && mid1 != null ? fv1 - mid1 : null,
      mid_source:     sm.mid_source,
      volume:         sm.volume,
      kalshi_bid:        kalshi1?.yes_bid ?? null,
      kalshi_ask:        kalshi1?.yes_ask ?? null,
      kalshi_mid:        kalshi1?.yes_mid ?? null,
      kalshi_edge_vs_fv: fv1 != null && kalshi1?.yes_mid != null ? fv1 - kalshi1.yes_mid : null,
    })
    rows.push({
      market_type:    sm.market_type,
      market_label,
      outcome_label:  o2,
      fv:             fv2,
      mid:            mid2,
      edge:           fv2 != null && mid2 != null ? fv2 - mid2 : null,
      mid_source:     sm.mid_source,
      volume:         sm.volume,
      kalshi_bid:        kalshi2?.yes_bid ?? null,
      kalshi_ask:        kalshi2?.yes_ask ?? null,
      kalshi_mid:        kalshi2?.yes_mid ?? null,
      kalshi_edge_vs_fv: fv2 != null && kalshi2?.yes_mid != null ? fv2 - kalshi2.yes_mid : null,
    })
  }
  return rows
}

function MainPanel({
  pred, detail, loading, lastRefreshed, onRefresh,
}: {
  pred: Prediction
  detail: EventDetail | null
  loading: boolean
  lastRefreshed: Date | null
  onRefresh: () => void
}) {
  const rows = useMemo(() => buildRows(pred, detail), [pred, detail])

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-baseline gap-4 flex-wrap">
        <h1 className="text-3xl font-bold text-gray-100">
          {pred.blue_team} <span className="text-gray-600 mx-2 font-normal">vs</span> {pred.red_team}
        </h1>
        <span className={`text-xs uppercase tracking-wide px-2 py-1 rounded ${
          pred.league === 'LCK' ? 'bg-blue-900/60 text-blue-300' :
          pred.league === 'LEC' ? 'bg-purple-900/60 text-purple-300' :
          pred.league === 'LPL' ? 'bg-red-900/60 text-red-300' :
          pred.league === 'LCS' ? 'bg-emerald-900/60 text-emerald-300' :
          pred.league === 'EWC' ? 'bg-amber-900/60 text-amber-300' :
          'bg-gray-800 text-gray-400'
        }`}>{pred.league}</span>
        <span className="text-sm text-gray-500">Bo{pred.best_of}</span>
        <span className="text-sm text-gray-500">{timeUntil(pred.date)}</span>
        <a
          href={detail?.slug ? `https://polymarket.com/event/${detail.slug}` : '#'}
          target="_blank" rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 underline ml-auto"
        >open on polymarket ↗</a>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
        >
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {/* Feature snapshot */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <span className="text-gray-500 mr-2">Model series WR ({pred.blue_team}):</span>
          <span className="font-mono text-gray-100">{fmtPct(seriesProb(pred.pred_blue_win, pred.best_of))}</span>
        </div>
        <div>
          <span className="text-gray-500 mr-2">Per-game side-neutral:</span>
          <span className="font-mono text-gray-100">{fmtPct(pred.pred_blue_win)}</span>
        </div>
        {pred.elo_diff != null && (
          <div>
            <span className="text-gray-500 mr-2">ELO diff:</span>
            <span className="font-mono text-gray-100">{pred.elo_diff > 0 ? '+' : ''}{Math.round(pred.elo_diff)}</span>
          </div>
        )}
        {pred.poly_volume != null && (
          <div>
            <span className="text-gray-500 mr-2">Match volume:</span>
            <span className="font-mono text-gray-100">${pred.poly_volume.toLocaleString()}</span>
          </div>
        )}
        <div className="ml-auto text-xs text-gray-600">
          {lastRefreshed ? `updated ${Math.round((Date.now() - lastRefreshed.getTime())/1000)}s ago` : 'loading…'}
        </div>
      </div>

      {/* Submarket table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {detail == null && !loading ? (
          <div className="p-6 text-gray-500 text-sm">No Polymarket event found for this matchup.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-900 border-b border-gray-800">
              <tr className="text-xs text-gray-500">
                <th className="text-left px-4 py-3 font-normal">Market</th>
                <th className="text-left px-4 py-3 font-normal">Outcome</th>
                <th className="text-right px-4 py-3 font-normal">Fair</th>
                <th className="text-right px-4 py-3 font-normal" colSpan={2}>Polymarket</th>
                <th className="text-right px-4 py-3 font-normal border-l border-gray-800" colSpan={2}>Kalshi</th>
                <th className="text-right px-4 py-3 font-normal w-32"></th>
              </tr>
              <tr className="text-[10px] text-gray-600 border-b border-gray-800">
                <th></th>
                <th></th>
                <th></th>
                <th className="text-right px-4 pb-2 font-normal">Mid</th>
                <th className="text-right px-4 pb-2 font-normal">Edge</th>
                <th className="text-right px-4 pb-2 font-normal border-l border-gray-800">Bid/Ask · Mid</th>
                <th className="text-right px-4 pb-2 font-normal">Edge</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((r, i) => {
                const isFirstOfPair = i % 2 === 0
                return (
                  <tr key={`${r.market_type}-${r.outcome_label}-${i}`}
                      className={isFirstOfPair ? 'bg-gray-900/40' : ''}>
                    <td className="px-4 py-2 text-gray-400 text-xs">
                      {isFirstOfPair ? r.market_label : ''}
                    </td>
                    <td className="px-4 py-2 text-gray-200">{r.outcome_label}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-300 font-mono">{fmtPct(r.fv)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-300 font-mono">
                      {fmtPct(r.mid)}
                      {r.mid_source === 'gamma_last' && (
                        <span title="No CLOB book, showing last trade" className="ml-1 text-amber-500 text-[10px]">⚠</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-mono ${edgeColor(r.edge)}`}>
                      {r.edge != null ? fmtPct(r.edge, true) : ''}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-400 font-mono text-xs border-l border-gray-800">
                      {r.kalshi_bid != null && r.kalshi_ask != null ? (
                        <span>
                          <span className="text-gray-600">{(r.kalshi_bid*100).toFixed(0)}/{(r.kalshi_ask*100).toFixed(0)}</span>
                          <span className="ml-2 text-gray-300">{fmtPct(r.kalshi_mid)}</span>
                        </span>
                      ) : (
                        r.market_type === 'match_winner' ? <span className="text-gray-700">—</span> : <span className="text-gray-800">·</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-mono text-xs ${edgeColor(r.kalshi_edge_vs_fv)}`}>
                      {r.kalshi_edge_vs_fv != null ? fmtPct(r.kalshi_edge_vs_fv, true) : ''}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          disabled
                          title="Trade execution coming in v2"
                          className="px-2 py-1 text-[10px] rounded bg-green-900/40 text-green-500 cursor-not-allowed opacity-50"
                        >Buy</button>
                        <button
                          disabled
                          title="Trade execution coming in v2"
                          className="px-2 py-1 text-[10px] rounded bg-red-900/40 text-red-500 cursor-not-allowed opacity-50"
                        >Sell</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function TraderPage() {
  const [events, setEvents] = useState<Prediction[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [detail, setDetail] = useState<EventDetail | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const detailReqId = useRef(0)

  // Load predictions on mount
  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error: e } = await supabase
        .from('upcoming_predictions')
        .select('blue_team,red_team,league,best_of,pred_blue_win,date,poly_event_slug,poly_team1,poly_volume,blue_elo,red_elo,elo_diff')
        .order('date', { ascending: true })
      if (cancelled) return
      if (e) { setError(e.message); setLoadingList(false); return }
      const filtered = (data ?? []).filter(p => p.poly_event_slug)
      setEvents(filtered as Prediction[])
      if (filtered.length > 0) setSelectedSlug(filtered[0].poly_event_slug ?? null)
      setLoadingList(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Fetch + auto-refresh detail every 10s
  const refreshDetail = useCallback(async () => {
    if (!selectedSlug) return
    setLoadingDetail(true)
    const myId = ++detailReqId.current
    try {
      const r = await fetch(`/api/trader-event?slug=${encodeURIComponent(selectedSlug)}`, { cache: 'no-store' })
      if (myId !== detailReqId.current) return    // a later request supersedes this
      if (!r.ok) {
        setDetail(null)
      } else {
        const d: EventDetail = await r.json()
        setDetail(d)
      }
      setLastRefreshed(new Date())
    } catch {
      // network blip — keep prior detail visible
    } finally {
      if (myId === detailReqId.current) setLoadingDetail(false)
    }
  }, [selectedSlug])

  useEffect(() => {
    if (!selectedSlug) return
    refreshDetail()
    const interval = setInterval(refreshDetail, 10_000)
    return () => clearInterval(interval)
  }, [selectedSlug, refreshDetail])

  // j/k + ↑/↓ keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (!['j','k','ArrowDown','ArrowUp'].includes(e.key)) return
      e.preventDefault()
      const idx = events.findIndex(ev => ev.poly_event_slug === selectedSlug)
      if (idx < 0) return
      const next = (e.key === 'j' || e.key === 'ArrowDown')
        ? Math.min(idx + 1, events.length - 1)
        : Math.max(idx - 1, 0)
      const slug = events[next]?.poly_event_slug
      if (slug) setSelectedSlug(slug)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [events, selectedSlug])

  const selectedPred = events.find(e => e.poly_event_slug === selectedSlug) ?? null

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-3 flex items-baseline gap-6">
        <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Home</Link>
        <span className="text-lg font-bold text-blue-400">Trader Cockpit</span>
        <Link href="/predictions" className="text-sm text-gray-400 hover:text-gray-200 ml-auto">Predictions</Link>
        <Link href="/findings" className="text-sm text-gray-400 hover:text-gray-200">Findings</Link>
      </header>
      <div className="flex" style={{ height: 'calc(100vh - 49px)' }}>
        <aside className="w-80 border-r border-gray-800 shrink-0">
          {loadingList ? (
            <div className="p-4 text-gray-500 text-sm">Loading events…</div>
          ) : error ? (
            <div className="p-4 text-red-400 text-sm">{error}</div>
          ) : events.length === 0 ? (
            <div className="p-4 text-gray-500 text-sm">
              No upcoming markets joined to Polymarket. The predict pipeline must run first.
            </div>
          ) : (
            <Sidebar events={events} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
          )}
        </aside>
        <main className="flex-1 overflow-y-auto">
          {selectedPred ? (
            <MainPanel
              pred={selectedPred}
              detail={detail}
              loading={loadingDetail}
              lastRefreshed={lastRefreshed}
              onRefresh={refreshDetail}
            />
          ) : (
            <div className="p-6 text-gray-500 text-sm">Select an event.</div>
          )}
        </main>
      </div>
    </div>
  )
}
