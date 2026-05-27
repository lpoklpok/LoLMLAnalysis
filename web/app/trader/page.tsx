'use client'

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

// ── Types ───────────────────────────────────────────────────────────────────

interface Prediction {
  blue_team: string
  red_team: string
  league: string
  best_of: number
  // null when this event is outside the model's coverage (e.g. LCK
  // Challengers League). Such events still show in the sidebar with
  // live Polymarket prices but no fair-value/edge columns.
  pred_blue_win: number | null
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
  outcome_bids: [number | null, number | null]
  outcome_asks: [number | null, number | null]
  token_ids: [string | null, string | null]
  mid_source: 'clob_mid' | 'gamma_last'
  volume: number
  kalshi_sides: [KalshiSide | null, KalshiSide | null]
}

interface KalshiSide {
  team: string
  ticker: string
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
  token_id: string | null      // Polymarket CLOB token id for this outcome (needed for orders)
  fv: number | null
  bid: number | null
  ask: number | null
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

// Normalise team names for matching against Polymarket outcomes. Polymarket
// uses different spacing/punctuation than OE/our DB (e.g. "Nongshim Red Force"
// vs our "Nongshim RedForce"), so we strip all non-alphanumeric chars before
// comparing. Mirrors the python `_norm_team` in src/merge_polymarket_data.py.
const _normTeam = (s: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function buildRows(pred: Prediction, detail: EventDetail | null): Row[] {
  if (!detail) return []
  const rows: Row[] = []
  const bo = pred.best_of
  // Per-game side-neutral prob for blue team. Null for events outside the
  // model's coverage (e.g. LCK Challengers League) — we still render the
  // row with prices, just no fair-value/edge columns.
  const pBlue = pred.pred_blue_win
  const hasModel = pBlue != null && !Number.isNaN(pBlue)

  // For each polymarket submarket, compute model fair value for outcomes[0] and outcomes[1].
  for (const sm of detail.submarkets) {
    const [o1, o2] = sm.outcomes
    const [mid1, mid2] = sm.outcome_mids

    let fv1: number | null = null
    let fv2: number | null = null
    let market_label: string = sm.question

    if (sm.market_type === 'match_winner') {
      market_label = 'Match Winner'
      if (hasModel) {
        const team1IsBlue = _normTeam(o1) === _normTeam(pred.blue_team)
        const pTeam1Game = team1IsBlue ? (pBlue as number) : 1 - (pBlue as number)
        fv1 = seriesProb(pTeam1Game, bo)
        fv2 = 1 - fv1
      }
    } else if (sm.market_type.startsWith('game_') && sm.market_type.endsWith('_winner')) {
      const gnum = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
      market_label = `Game ${gnum} Winner`
      if (hasModel) {
        const team1IsBlue = _normTeam(o1) === _normTeam(pred.blue_team)
        fv1 = team1IsBlue ? (pBlue as number) : 1 - (pBlue as number)
        fv2 = 1 - fv1
      }
    } else if (sm.market_type === 'game_handicap') {
      market_label = 'Game Handicap'
      // Skip FV for v1 — handicap math is more involved (see merge_polymarket_data math)
      fv1 = null
      fv2 = null
    }

    // Per-submarket Kalshi sides — populated by the API for match_winner and
    // game_N_winner (no analog for game_handicap).
    const kalshi1 = sm.kalshi_sides?.[0] ?? null
    const kalshi2 = sm.kalshi_sides?.[1] ?? null

    rows.push({
      market_type:    sm.market_type,
      market_label,
      outcome_label:  o1,
      token_id:       sm.token_ids?.[0] ?? null,
      fv:             fv1,
      bid:            sm.outcome_bids?.[0] ?? null,
      ask:            sm.outcome_asks?.[0] ?? null,
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
      token_id:       sm.token_ids?.[1] ?? null,
      fv:             fv2,
      bid:            sm.outcome_bids?.[1] ?? null,
      ask:            sm.outcome_asks?.[1] ?? null,
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
  pred, detail, loading, lastRefreshed, onRefresh, onPlanTrade, positions, onClosePosition,
}: {
  pred: Prediction
  detail: EventDetail | null
  loading: boolean
  lastRefreshed: Date | null
  onRefresh: () => void
  onPlanTrade: (thisRow: Row, oppositeRow: Row) => void
  positions: PolyPosition[]
  onClosePosition: (thisRow: Row, oppositeRow: Row) => void
}) {
  const rows = useMemo(() => buildRows(pred, detail), [pred, detail])

  // Build a fast lookup: token_id → position
  const positionByToken = useMemo(() => {
    const m = new Map<string, PolyPosition>()
    for (const p of positions) {
      const id = p.asset ?? p.tokenId ?? p.token_id
      if (id) m.set(String(id), p)
    }
    return m
  }, [positions])

  // For the banner: collect all positions belonging to this event's submarkets
  const eventTokens = useMemo(() => {
    const out: { token_id: string; outcome: string; market: string; mid: number | null }[] = []
    for (const sm of detail?.submarkets ?? []) {
      const [t1, t2] = sm.token_ids ?? [null, null]
      const market = sm.market_type === 'match_winner' ? 'Match Winner' :
        sm.market_type.startsWith('game_') ? sm.market_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) :
        sm.market_type
      if (t1) out.push({ token_id: t1, outcome: sm.outcomes[0], market, mid: sm.outcome_mids[0] })
      if (t2) out.push({ token_id: t2, outcome: sm.outcomes[1], market, mid: sm.outcome_mids[1] })
    }
    return out
  }, [detail])

  const eventPositions = eventTokens
    .map(t => ({ ...t, pos: positionByToken.get(t.token_id) }))
    .filter(t => t.pos && Math.abs(num(t.pos.size)) > 0.0001)

  return (
    <div className="p-3 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex items-baseline gap-2 md:gap-4 flex-wrap">
        <h1 className="text-xl md:text-3xl font-bold text-gray-100">
          {pred.blue_team} <span className="text-gray-600 mx-1 md:mx-2 font-normal">vs</span> {pred.red_team}
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

      {/* Positions banner — only renders if there are open positions in this event */}
      {eventPositions.length > 0 && (
        <div className="bg-gradient-to-r from-blue-950/60 to-purple-950/60 border border-blue-900/60 rounded-xl p-4">
          <div className="text-xs uppercase tracking-wide text-blue-300 mb-2 flex items-baseline gap-3">
            <span>Open positions in this event</span>
            <span className="text-[10px] text-gray-500 normal-case">live · refreshes every 5s</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            {eventPositions.map(t => {
              const size = num(t.pos!.size)
              const avg  = num(t.pos!.avgPrice)
              const mid  = t.mid ?? 0
              const mtm  = size * (mid - avg)
              const pnl  = num(t.pos!.cashPnl) + num(t.pos!.realizedPnl)
              // Look up the matching row + its opposite so the Close button can fire a synthetic-sell.
              const thisRow = rows.find(r => r.token_id === t.token_id)
              const thisRowIdx = thisRow ? rows.indexOf(thisRow) : -1
              const oppRow = thisRowIdx >= 0 ? (thisRowIdx % 2 === 0 ? rows[thisRowIdx + 1] : rows[thisRowIdx - 1]) : null
              const canClose = thisRow && oppRow
              return (
                <div key={t.token_id} className="bg-gray-900/60 border border-gray-800 rounded-md px-3 py-2">
                  <div className="flex items-baseline justify-between">
                    <div className="font-medium text-gray-100">{t.outcome}</div>
                    <div className="text-[10px] text-gray-500">{t.market}</div>
                  </div>
                  <div className="flex items-baseline gap-3 mt-1 text-xs font-mono">
                    <span className="text-gray-400">{size > 0 ? '+' : ''}{size.toFixed(2)} @ {avg.toFixed(3)}</span>
                    <span className="text-gray-500">mid {mid.toFixed(3)}</span>
                    <span className={`${mtm >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      mtm {mtm >= 0 ? '+' : ''}${mtm.toFixed(2)}
                    </span>
                    {pnl !== 0 && (
                      <span className={`${pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        pnl {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                      </span>
                    )}
                    {canClose && (
                      <button
                        onClick={() => onClosePosition(thisRow, oppRow)}
                        className="ml-auto px-2 py-0.5 rounded text-[10px] bg-red-700 hover:bg-red-600 text-white font-bold"
                        title={`Synthetic-sell ${size.toFixed(2)} ${t.outcome} via best-bid (BUY ${oppRow.outcome_label} at 1−bid)`}>
                        Close
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Feature snapshot */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <span className="text-gray-500 mr-2">Model series WR ({pred.blue_team}):</span>
          <span className="font-mono text-gray-100">
            {pred.pred_blue_win != null ? fmtPct(seriesProb(pred.pred_blue_win, pred.best_of)) : '—'}
          </span>
        </div>
        <div>
          <span className="text-gray-500 mr-2">Per-game side-neutral:</span>
          <span className="font-mono text-gray-100">
            {pred.pred_blue_win != null ? fmtPct(pred.pred_blue_win) : '—'}
          </span>
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

      {/* Mobile-only card list (md+ uses the table below) */}
      <div className="md:hidden space-y-2">
        {detail == null && !loading ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-gray-500 text-sm">No Polymarket event found for this matchup.</div>
        ) : rows.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-gray-500 text-sm">{loading ? 'loading…' : 'no rows'}</div>
        ) : (
          // Group by market_type so each "submarket" is one card with the 2 outcomes inside.
          Array.from(new Set(rows.map(r => `${r.market_type}|${r.market_label}`))).map(key => {
            const [mt, mlabel] = key.split('|')
            const pair = rows.filter(r => r.market_type === mt)
            return (
              <div key={key} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">{mlabel}</div>
                <div className="space-y-2">
                  {pair.map((r, idx) => {
                    const opp = pair[1 - idx] ?? null
                    return (
                      <div key={`${r.outcome_label}-${idx}`} className="bg-gray-950/60 rounded-lg p-3">
                        <div className="flex items-baseline justify-between mb-1">
                          <div className="text-base font-semibold text-gray-100 truncate pr-2">{r.outcome_label}</div>
                          <div className="text-xs text-gray-400 font-mono">fair {fmtPct(r.fv)}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-3">
                          <div className="bg-gray-900 rounded px-2 py-1.5">
                            <div className="text-[10px] uppercase text-gray-600 mb-0.5">Polymarket</div>
                            {r.bid != null || r.ask != null ? (
                              <div>
                                <span className="text-green-400">{r.bid != null ? (r.bid*100).toFixed(1) : '–'}</span>
                                <span className="text-gray-700 mx-1">·</span>
                                <span className="text-red-400">{r.ask != null ? (r.ask*100).toFixed(1) : '–'}</span>
                              </div>
                            ) : <span className="text-gray-300">{fmtPct(r.mid)}</span>}
                            <div className={`text-[11px] ${edgeColor(r.edge)}`}>{r.edge != null ? fmtPct(r.edge, true) : ''}</div>
                          </div>
                          <div className="bg-gray-900 rounded px-2 py-1.5">
                            <div className="text-[10px] uppercase text-gray-600 mb-0.5">Kalshi</div>
                            {r.kalshi_bid != null && r.kalshi_ask != null ? (
                              <div>
                                <span className="text-green-400">{(r.kalshi_bid*100).toFixed(0)}</span>
                                <span className="text-gray-700 mx-1">·</span>
                                <span className="text-red-400">{(r.kalshi_ask*100).toFixed(0)}</span>
                              </div>
                            ) : <span className="text-gray-700">—</span>}
                            <div className={`text-[11px] ${edgeColor(r.kalshi_edge_vs_fv)}`}>{r.kalshi_edge_vs_fv != null ? fmtPct(r.kalshi_edge_vs_fv, true) : ''}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => opp && onPlanTrade(r, opp)}
                          disabled={!r.token_id || !opp}
                          className="w-full px-3 py-2.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold disabled:bg-gray-700 disabled:text-gray-500 transition-colors"
                        >Ladder ↗</button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Submarket table (md+ only) */}
      <div className="hidden md:block bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
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
                <th className="text-right px-4 pb-2 font-normal"><span className="text-green-500">BID</span> · <span className="text-red-400">OFFER</span></th>
                <th className="text-right px-4 pb-2 font-normal">Edge</th>
                <th className="text-right px-4 pb-2 font-normal border-l border-gray-800"><span className="text-green-500">BID</span> · <span className="text-red-400">OFFER</span></th>
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
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">
                      {r.bid != null || r.ask != null ? (
                        <span>
                          <span className="text-green-400">{r.bid != null ? (r.bid * 100).toFixed(1) : '–'}</span>
                          <span className="text-gray-700 mx-1">·</span>
                          <span className="text-red-400">{r.ask != null ? (r.ask * 100).toFixed(1) : '–'}</span>
                        </span>
                      ) : (
                        <span className="text-gray-300">{fmtPct(r.mid)}</span>
                      )}
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
                      <button
                        onClick={() => {
                          // Each submarket has 2 consecutive rows. The opposite is i-1 or i+1.
                          const opp = isFirstOfPair ? rows[i + 1] : rows[i - 1]
                          if (opp) onPlanTrade(r, opp)
                        }}
                        disabled={!r.token_id}
                        title={!r.token_id ? 'Missing token id' : `Open ladder for ${r.outcome_label}`}
                        className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
                      >Ladder</button>
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

// ── Relay client (browser → Fly Toronto → Polymarket) ─────────────────────

const RELAY_URL = 'https://kw-polymarket-trader-relay.fly.dev'
const SIZE_PRESETS = [100, 500, 1000, 5000]

interface RelayOrderRequest {
  token_id:    string
  side:        'BUY' | 'SELL'
  price:       number
  size:        number
  order_type:  'FAK' | 'GTD'
  gtd_seconds?: number
}

interface RelayOrderResponse {
  ok: boolean
  elapsed_ms?: number
  response?: unknown
  detail?: string
}

async function placeOrder(secret: string, req: RelayOrderRequest): Promise<RelayOrderResponse> {
  const r = await fetch(`${RELAY_URL}/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Auth': secret },
    body: JSON.stringify(req),
  })
  let body: RelayOrderResponse | { detail: string }
  try { body = await r.json() } catch { body = { detail: 'invalid JSON response' } }
  if (!r.ok) return { ok: false, detail: (body as { detail?: string }).detail ?? `HTTP ${r.status}` }
  return body as RelayOrderResponse
}

interface PolyPosition {
  asset?: string; tokenId?: string; token_id?: string
  size?: string | number
  avgPrice?: string | number
  initialValue?: string | number
  currentValue?: string | number
  cashPnl?: string | number
  realizedPnl?: string | number
  outcome?: string
  title?: string
}

async function fetchPositions(secret: string): Promise<PolyPosition[]> {
  try {
    const r = await fetch(`${RELAY_URL}/positions`, { headers: { 'X-Relay-Auth': secret }, cache: 'no-store' })
    if (!r.ok) return []
    const d = await r.json()
    if (Array.isArray(d)) return d as PolyPosition[]
    return []
  } catch { return [] }
}

function num(x: string | number | undefined): number {
  if (x == null) return 0
  const n = typeof x === 'number' ? x : parseFloat(x)
  return Number.isFinite(n) ? n : 0
}

// ── Ladder modal (live book + click-to-trade) ─────────────────────────────

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const LADDER_LEVELS_EACH_SIDE = 10

interface LadderPlan {
  thisRow:     Row     // the outcome the user clicked on
  oppositeRow: Row     // the other outcome of the same submarket
  kalshiSide:     KalshiSide | null   // kalshi market for "this" outcome, if available
  kalshiOpposite: KalshiSide | null
}

// Find the submarket for thisRow (by token_id) and pull its kalshi sides,
// aligned so kalshiSide corresponds to thisRow.outcome_label.
function buildLadderPlan(thisRow: Row, oppositeRow: Row, detail: EventDetail | null): LadderPlan {
  let kalshiSide: KalshiSide | null = null
  let kalshiOpposite: KalshiSide | null = null
  if (detail) {
    const sm = detail.submarkets.find(s => s.token_ids?.includes(thisRow.token_id))
    if (sm) {
      const idxThis = sm.outcomes.findIndex(o => o === thisRow.outcome_label)
      if (idxThis === 0) {
        kalshiSide = sm.kalshi_sides?.[0] ?? null
        kalshiOpposite = sm.kalshi_sides?.[1] ?? null
      } else if (idxThis === 1) {
        kalshiSide = sm.kalshi_sides?.[1] ?? null
        kalshiOpposite = sm.kalshi_sides?.[0] ?? null
      }
    }
  }
  return { thisRow, oppositeRow, kalshiSide, kalshiOpposite }
}

interface BookState {
  bids: Map<number, number>     // price → size
  asks: Map<number, number>
  best_bid: number | null
  best_ask: number | null
  connected: boolean
}

const emptyBook = (): BookState => ({ bids: new Map(), asks: new Map(), best_bid: null, best_ask: null, connected: false })

function recalcBest(b: Map<number, number>): number | null {
  if (b.size === 0) return null
  let best = -Infinity
  for (const px of b.keys()) if (px > best) best = px
  return best === -Infinity ? null : best
}
function recalcMinAsk(a: Map<number, number>): number | null {
  if (a.size === 0) return null
  let best = Infinity
  for (const px of a.keys()) if (px < best) best = px
  return best === Infinity ? null : best
}

function roundPx(p: number): number { return Math.round(p * 1000) / 1000 }

interface KalshiBook { bids: Map<number, number>; asks: Map<number, number>; updated: number }

async function fetchKalshiBook(ticker: string): Promise<KalshiBook | null> {
  if (!ticker) return null
  try {
    // Hits /api/kalshi-book on Vercel which proxies to Kalshi (CORS workaround).
    const r = await fetch(`/api/kalshi-book?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store' })
    if (!r.ok) return null
    const d = await r.json() as { bids?: [number, number][], asks?: [number, number][] }
    const bids = new Map<number, number>()
    const asks = new Map<number, number>()
    for (const [p, s] of (d.bids ?? [])) bids.set(roundPx(p), (bids.get(roundPx(p)) ?? 0) + s)
    for (const [p, s] of (d.asks ?? [])) asks.set(roundPx(p), (asks.get(roundPx(p)) ?? 0) + s)
    return { bids, asks, updated: Date.now() }
  } catch { return null }
}

function LadderModal({
  plan, secret, onClose,
}: {
  plan: LadderPlan
  secret: string | null
  onClose: () => void
}) {
  const { thisRow, oppositeRow, kalshiSide, kalshiOpposite } = plan
  const thisTokenId = thisRow.token_id
  const oppTokenId  = oppositeRow.token_id

  // Books indexed by token_id; we render thisRow's book in the main grid.
  const [books, setBooks] = useState<Record<string, BookState>>({})
  const [kalshiThis, setKalshiThis] = useState<KalshiBook | null>(null)
  const [kalshiOpp,  setKalshiOpp]  = useState<KalshiBook | null>(null)
  const [size, setSize] = useState<number>(100)
  const [mode, setMode] = useState<'FAK' | 'GTD'>('FAK')
  const [logLines, setLogLines] = useState<{ ts: string; ok: boolean; text: string }[]>([])
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)

  function log(ok: boolean, text: string) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogLines(prev => [{ ts, ok, text }, ...prev].slice(0, 30))
  }

  // ── Polymarket WS ────────────────────────────────────────────────────
  useEffect(() => {
    if (!thisTokenId) return
    const tokens = [thisTokenId, oppTokenId].filter(Boolean) as string[]
    let stopped = false
    let backoff = 500
    function connect() {
      if (stopped) return
      const ws = new WebSocket(POLY_WS_URL)
      wsRef.current = ws
      setWsStatus('connecting')
      ws.onopen = () => {
        setWsStatus('open')
        backoff = 500
        ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' }))
      }
      ws.onmessage = (e) => {
        let data: unknown
        try { data = JSON.parse(e.data) } catch { return }
        const msgs = Array.isArray(data) ? data : [data]
        setBooks(prev => {
          const next = { ...prev }
          for (const m of msgs as Record<string, unknown>[]) {
            const et = m['event_type'] as string | undefined
            if (et === 'book') {
              const aid = String(m['asset_id'] ?? '')
              if (!tokens.includes(aid)) continue
              const b = new Map<number, number>()
              const a = new Map<number, number>()
              for (const lvl of (m['bids'] as Array<Record<string, unknown>> ?? [])) {
                const px = roundPx(parseFloat(String(lvl['price'] ?? 0)))
                const sz = parseFloat(String(lvl['size'] ?? 0))
                if (px > 0 && sz > 0) b.set(px, (b.get(px) ?? 0) + sz)
              }
              for (const lvl of (m['asks'] as Array<Record<string, unknown>> ?? [])) {
                const px = roundPx(parseFloat(String(lvl['price'] ?? 0)))
                const sz = parseFloat(String(lvl['size'] ?? 0))
                if (px > 0 && sz > 0) a.set(px, (a.get(px) ?? 0) + sz)
              }
              next[aid] = { bids: b, asks: a, best_bid: recalcBest(b), best_ask: recalcMinAsk(a), connected: true }
            } else if (et === 'price_change') {
              for (const ch of (m['price_changes'] as Array<Record<string, unknown>> ?? [])) {
                const aid = String(ch['asset_id'] ?? '')
                if (!tokens.includes(aid)) continue
                const cur = next[aid] ?? emptyBook()
                const b = new Map(cur.bids); const a = new Map(cur.asks)
                const px = roundPx(parseFloat(String(ch['price'] ?? 0)))
                const sz = parseFloat(String(ch['size'] ?? 0))
                const side = String(ch['side'] ?? '').toUpperCase()
                const book = side === 'BUY' ? b : a
                if (sz <= 0) book.delete(px); else book.set(px, sz)
                next[aid] = { bids: b, asks: a, best_bid: recalcBest(b), best_ask: recalcMinAsk(a), connected: true }
              }
            }
          }
          return next
        })
      }
      ws.onerror = () => {/* swallow, onclose will handle */}
      ws.onclose = () => {
        setWsStatus('closed')
        if (stopped) return
        setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 8000)
      }
    }
    connect()
    return () => { stopped = true; wsRef.current?.close(); wsRef.current = null }
  }, [thisTokenId, oppTokenId])

  // ── Kalshi polling (REST) ────────────────────────────────────────────
  useEffect(() => {
    if (!kalshiSide?.ticker) return
    let stopped = false
    async function poll() {
      if (stopped) return
      const [tb, ob] = await Promise.all([
        fetchKalshiBook(kalshiSide!.ticker),
        kalshiOpposite?.ticker ? fetchKalshiBook(kalshiOpposite.ticker) : Promise.resolve(null),
      ])
      if (!stopped) { setKalshiThis(tb); setKalshiOpp(ob) }
      setTimeout(poll, 2000)
    }
    poll()
    return () => { stopped = true }
  }, [kalshiSide?.ticker, kalshiOpposite?.ticker])

  // ── Click-to-trade ───────────────────────────────────────────────────
  async function fire(tokenId: string, price: number, label: string) {
    if (!secret) { log(false, 'no relay secret set — connect trader first'); return }
    if (!tokenId) { log(false, `no token_id for ${label}`); return }
    if (size * price < 1.0) { log(false, `notional $${(size*price).toFixed(2)} < $1 min`); return }
    const t0 = Date.now()
    log(true, `→ ${label} ${size} @ ${price.toFixed(3)} (${mode})`)
    const resp = await placeOrder(secret, {
      token_id: tokenId,
      side: 'BUY',
      price,
      size,
      order_type: mode,
      gtd_seconds: mode === 'GTD' ? 300 : undefined,
    })
    const dt = Date.now() - t0
    const summary = resp.ok
      ? `✓ ${label} ${size}@${price.toFixed(3)} ${dt}ms — ${JSON.stringify(resp.response).slice(0, 120)}`
      : `✗ ${label} ${size}@${price.toFixed(3)} ${dt}ms — ${resp.detail ?? 'unknown error'}`
    log(resp.ok, summary)
  }

  function onClickAsk(price: number) {
    if (!thisTokenId) return
    fire(thisTokenId, price, `BUY ${thisRow.outcome_label}`)
  }
  function onClickBid(price: number) {
    // Synthetic sell: BUY the opposite outcome at 1-price
    if (!oppTokenId) return
    const oppPrice = roundPx(1 - price)
    fire(oppTokenId, oppPrice, `SELL ${thisRow.outcome_label} (=BUY ${oppositeRow.outcome_label})`)
  }
  // Quick-action: market-sell at best bid (synthetic = BUY opposite at 1-bestBid)
  function sellAtBestBid() {
    const thisBookSnap = thisTokenId ? books[thisTokenId] : null
    const bb = thisBookSnap?.best_bid ?? null
    if (bb == null) { log(false, `no best bid available for ${thisRow.outcome_label}`); return }
    onClickBid(bb)
  }
  // Quick-action: market-buy at best ask
  function buyAtBestAsk() {
    const thisBookSnap = thisTokenId ? books[thisTokenId] : null
    const ba = thisBookSnap?.best_ask ?? null
    if (ba == null) { log(false, `no best ask available for ${thisRow.outcome_label}`); return }
    onClickAsk(ba)
  }

  // ── Render the book ──────────────────────────────────────────────────
  // Centered around mid: N levels above + mid + N levels below at 1¢ granularity.
  // Polymarket binary markets tick at 0.01, so showing each cent is natural.
  // We aggregate any sub-cent depth (e.g. 0.745) into its nearest cent bucket
  // for display, while still being able to fire orders at sub-cent prices via
  // the actual price chosen at click time.
  const thisBook = thisTokenId ? books[thisTokenId] ?? emptyBook() : emptyBook()

  function bucketByCent(m: Map<number, number>): Map<number, number> {
    const out = new Map<number, number>()
    for (const [px, sz] of m) {
      const cents = Math.round(px * 100) / 100
      out.set(cents, (out.get(cents) ?? 0) + sz)
    }
    return out
  }
  const bidsByCent = bucketByCent(thisBook.bids)
  const asksByCent = bucketByCent(thisBook.asks)
  const bestBidC = thisBook.best_bid != null ? Math.round(thisBook.best_bid * 100) / 100 : null
  const bestAskC = thisBook.best_ask != null ? Math.round(thisBook.best_ask * 100) / 100 : null

  // Anchor: use mid if both sides known; else best ask; else best bid; else 0.5
  const midApprox =
    bestBidC != null && bestAskC != null ? (bestBidC + bestAskC) / 2 :
    bestAskC != null ? bestAskC :
    bestBidC != null ? bestBidC : 0.5
  const midC = Math.max(1, Math.min(99, Math.round(midApprox * 100)))

  // Build N ticks above + N below + center (rendered top-down: asks high → bids low)
  const sortedPrices: number[] = []
  for (let offset = LADDER_LEVELS_EACH_SIDE; offset >= -LADDER_LEVELS_EACH_SIDE; offset--) {
    const c = midC + offset
    if (c >= 1 && c <= 99) sortedPrices.push(c / 100)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-1 md:p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[95vh] md:max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-3 md:px-6 py-3 md:py-4 border-b border-gray-800 flex items-baseline gap-2 md:gap-4 flex-wrap">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide">{thisRow.market_label}</div>
            <div className="text-lg font-bold text-gray-100 mt-0.5">
              <span className="text-green-400">{thisRow.outcome_label}</span>
              <span className="text-gray-600 mx-2">·</span>
              <span className="text-gray-500 text-sm">opp: {oppositeRow.outcome_label}</span>
            </div>
          </div>
          <span className={`text-[10px] px-2 py-0.5 rounded ${wsStatus === 'open' ? 'bg-green-900/40 text-green-400' : wsStatus === 'connecting' ? 'bg-amber-900/40 text-amber-400' : 'bg-red-900/40 text-red-400'}`}>
            poly ws {wsStatus}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-gray-500">size</span>
            {[100, 500, 1000, 5000].map(s => (
              <button key={s} onClick={() => setSize(s)}
                className={`px-3 py-1 text-xs rounded font-mono ${size === s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                {s.toLocaleString()}
              </button>
            ))}
            <input type="number" value={size} onChange={e => setSize(parseFloat(e.target.value) || 0)}
              className="w-20 px-2 py-1 text-xs font-mono bg-gray-800 text-gray-100 rounded border border-gray-700" />
            <button onClick={() => setMode(mode === 'FAK' ? 'GTD' : 'FAK')}
              className={`px-3 py-1 text-xs rounded font-bold ${mode === 'FAK' ? 'bg-orange-900/40 text-orange-300' : 'bg-blue-900/40 text-blue-300'}`}
              title={mode === 'FAK' ? 'Fill-or-kill (clicks fire IOC orders)' : 'GTD 5min (clicks fire post-only resting orders)'}>
              {mode === 'FAK' ? 'IOC' : 'GTD 5m'}
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none ml-1">×</button>
          </div>
        </div>

        {/* Quick action bar */}
        <div className="px-3 md:px-6 py-2 border-b border-gray-800 bg-gray-900/40 flex flex-wrap items-center gap-2 md:gap-3 text-xs">
          <span className="text-gray-500 hidden md:inline">Quick:</span>
          <button
            onClick={sellAtBestBid}
            disabled={!secret || !oppTokenId}
            className="flex-1 md:flex-none px-3 py-2 md:py-1.5 rounded bg-green-700 hover:bg-green-600 active:bg-green-800 text-white font-bold disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed"
            title="Synthetic-sell at best bid (= BUY opposite outcome at 1−best_bid)">
            ▼ SELL <span className="truncate inline-block max-w-[120px] align-bottom">{thisRow.outcome_label}</span>
          </button>
          <button
            onClick={buyAtBestAsk}
            disabled={!secret || !thisTokenId}
            className="flex-1 md:flex-none px-3 py-2 md:py-1.5 rounded bg-red-700 hover:bg-red-600 active:bg-red-800 text-white font-bold disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed"
            title="Buy at best ask (lifts the offer)">
            ▲ BUY <span className="truncate inline-block max-w-[120px] align-bottom">{thisRow.outcome_label}</span>
          </button>
          <span className="text-gray-600 ml-2 hidden md:inline">
            (or click any price cell in the ladder — green BIDS = sell, red ASKS = buy)
          </span>
        </div>

        {/* Ladder + Kalshi side. On mobile: stack vertically. On md+: side-by-side. */}
        <div
          className={`flex-1 overflow-y-auto px-3 md:px-6 py-3 md:py-4 flex flex-col gap-4 md:gap-6 ${kalshiSide ? 'md:grid md:[grid-template-columns:2fr_1fr]' : 'md:grid md:grid-cols-1'}`}
        >
          {/* Polymarket ladder */}
          <div>
            <div className="text-xs uppercase text-gray-500 tracking-wide mb-2">Polymarket — click to fire</div>
            <div className="grid grid-cols-3 gap-px text-xs bg-gray-800 rounded overflow-hidden">
              <div className="bg-green-900/30 px-3 py-1.5 text-green-400 text-right font-bold">▼ SELL HERE · BID SIZE</div>
              <div className="bg-gray-900 px-3 py-1.5 text-center">
                <span className="text-green-400">BID</span>
                <span className="text-gray-700 mx-1.5">/</span>
                <span className="text-red-400">OFFER</span>
              </div>
              <div className="bg-red-900/30 px-3 py-1.5 text-red-400 font-bold">▲ BUY HERE · ASK SIZE</div>
              {sortedPrices.map(px => {
                const bidSz = bidsByCent.get(px) ?? 0
                const askSz = asksByCent.get(px) ?? 0
                const isBestBid = px === bestBidC
                const isBestAsk = px === bestAskC
                const isInsideSpread = bestBidC != null && bestAskC != null && px > bestBidC && px < bestAskC
                const isBidZone = bestBidC != null && px <= bestBidC
                const isAskZone = bestAskC != null && px >= bestAskC
                // Center column: emphasize what side this price is on.
                // - At best bid: bright green ("you would SELL here, getting filled vs bids")
                // - Bid zone (below best bid): dim green (sell side, deeper)
                // - At best ask: bright red ("you would BUY here, lifting the offer")
                // - Ask zone (above best ask): dim red (buy side, deeper)
                // - Inside spread (between bid and ask): blue, where you might rest a passive order
                let priceBg = 'bg-gray-900 text-gray-500'
                let priceLabel: string | null = null
                if (isBestBid) { priceBg = 'bg-green-700/70 text-white font-bold'; priceLabel = 'BID' }
                else if (isBestAsk) { priceBg = 'bg-red-700/70 text-white font-bold'; priceLabel = 'OFFER' }
                else if (isInsideSpread) priceBg = 'bg-blue-900/30 text-blue-200'
                else if (isBidZone) priceBg = 'bg-green-900/30 text-green-300'
                else if (isAskZone) priceBg = 'bg-red-900/30 text-red-300'
                return (
                  <Fragment key={px}>
                    <button
                      onClick={() => onClickBid(px)}
                      disabled={!secret || !oppTokenId}
                      className={`px-3 py-1.5 text-right font-mono tabular-nums hover:bg-green-900/40 cursor-pointer disabled:cursor-not-allowed disabled:hover:bg-transparent ${bidSz > 0 ? (isBestBid ? 'bg-green-900/60 text-green-200' : 'bg-green-900/20 text-green-300') : 'bg-gray-900 text-gray-700'}`}
                      title={`Click → synthetic SELL ${thisRow.outcome_label} at ${px.toFixed(2)} (= BUY ${oppositeRow.outcome_label} at ${(1-px).toFixed(2)})`}>
                      {bidSz > 0 ? Math.round(bidSz).toLocaleString() : ''}
                    </button>
                    <div className={`px-3 py-1.5 text-center font-mono ${priceBg}`}>
                      <span>{px.toFixed(2)}</span>
                      {priceLabel && <span className="ml-2 text-[10px] uppercase tracking-wider opacity-80">{priceLabel}</span>}
                    </div>
                    <button
                      onClick={() => onClickAsk(px)}
                      disabled={!secret || !thisTokenId}
                      className={`px-3 py-1.5 text-left font-mono tabular-nums hover:bg-red-900/40 cursor-pointer disabled:cursor-not-allowed disabled:hover:bg-transparent ${askSz > 0 ? (isBestAsk ? 'bg-red-900/60 text-red-200' : 'bg-red-900/20 text-red-300') : 'bg-gray-900 text-gray-700'}`}
                      title={`Click → BUY ${thisRow.outcome_label} at ${px.toFixed(2)}`}>
                      {askSz > 0 ? Math.round(askSz).toLocaleString() : ''}
                    </button>
                  </Fragment>
                )
              })}
            </div>
          </div>

          {/* Kalshi (display-only for now) — aligned to same price band as Polymarket */}
          {kalshiSide && (() => {
            const k = kalshiThis ?? { bids: new Map(), asks: new Map(), updated: 0 }
            // Kalshi's own best bid/ask within its book
            const kBest = (() => {
              let bb = -Infinity, ba = Infinity
              for (const p of k.bids.keys()) if (p > bb) bb = p
              for (const p of k.asks.keys()) if (p < ba) ba = p
              return { bb: bb === -Infinity ? null : bb, ba: ba === Infinity ? null : ba }
            })()
            const hasData = k.bids.size > 0 || k.asks.size > 0
            return (
              <div>
                <div className="text-xs uppercase text-gray-500 tracking-wide mb-2 flex items-baseline gap-2">
                  <span>Kalshi · {kalshiSide.team}</span>
                  <span className="text-gray-700 normal-case">(display only)</span>
                  {hasData && kBest.bb != null && kBest.ba != null && (
                    <span className="ml-auto text-[10px] font-mono normal-case">
                      <span className="text-green-400">{kBest.bb.toFixed(2)}</span>
                      <span className="text-gray-600"> / </span>
                      <span className="text-red-400">{kBest.ba.toFixed(2)}</span>
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-px text-xs bg-gray-800 rounded overflow-hidden">
                  <div className="bg-gray-900 px-2 py-1.5 text-gray-500 text-right">BID</div>
                  <div className="bg-gray-900 px-2 py-1.5 text-center">
                    <span className="text-green-400">BID</span>
                    <span className="text-gray-700 mx-1">/</span>
                    <span className="text-red-400">OFFER</span>
                  </div>
                  <div className="bg-gray-900 px-2 py-1.5 text-gray-500">ASK</div>
                  {!hasData && (
                    <div className="col-span-3 px-3 py-3 text-gray-600 text-center">loading Kalshi book…</div>
                  )}
                  {hasData && sortedPrices.map(p => {
                    const bs = k.bids.get(p) ?? 0
                    const as_ = k.asks.get(p) ?? 0
                    const isBB = p === kBest.bb
                    const isBA = p === kBest.ba
                    const inside = kBest.bb != null && kBest.ba != null && p > kBest.bb && p < kBest.ba
                    let centerBg = 'bg-gray-900 text-gray-600'
                    if (isBB) centerBg = 'bg-green-700/70 text-white font-bold'
                    else if (isBA) centerBg = 'bg-red-700/70 text-white font-bold'
                    else if (inside) centerBg = 'bg-blue-900/30 text-blue-200'
                    else if (kBest.bb != null && p < kBest.bb) centerBg = 'bg-green-900/20 text-green-400'
                    else if (kBest.ba != null && p > kBest.ba) centerBg = 'bg-red-900/20 text-red-400'
                    return (
                      <Fragment key={p}>
                        <div className={`px-2 py-1 text-right font-mono ${bs > 0 ? (isBB ? 'bg-green-900/60 text-green-200' : 'bg-green-900/20 text-green-300') : 'bg-gray-900 text-gray-700'}`}>{bs > 0 ? Math.round(bs).toLocaleString() : ''}</div>
                        <div className={`px-2 py-1 text-center font-mono ${centerBg}`}>{p.toFixed(2)}</div>
                        <div className={`px-2 py-1 font-mono ${as_ > 0 ? (isBA ? 'bg-red-900/60 text-red-200' : 'bg-red-900/20 text-red-300') : 'bg-gray-900 text-gray-700'}`}>{as_ > 0 ? Math.round(as_).toLocaleString() : ''}</div>
                      </Fragment>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>

        {/* Activity log */}
        <div className="border-t border-gray-800 px-6 py-3 max-h-32 overflow-y-auto bg-gray-950/50">
          {logLines.length === 0 ? (
            <div className="text-xs text-gray-600">Click an ask to BUY, click a bid to synthetic-SELL. {mode === 'FAK' ? 'IOC: fills immediately or cancels.' : 'GTD 5m: rests on the book for 5 minutes.'}</div>
          ) : (
            <div className="space-y-1 font-mono text-[11px]">
              {logLines.map((l, i) => (
                <div key={i} className={l.ok ? 'text-gray-300' : 'text-red-400'}>
                  <span className="text-gray-600">{l.ts}</span> {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Settings widget (relay secret) ─────────────────────────────────────────

function RelaySettings({ secret, onSave }: { secret: string | null; onSave: (s: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(secret ?? '')
  return (
    <>
      <button
        onClick={() => { setValue(secret ?? ''); setOpen(true) }}
        className={`text-xs px-2 py-1 rounded transition-colors ${secret ? 'bg-green-900/40 text-green-400 hover:bg-green-900/60' : 'bg-amber-900/40 text-amber-400 hover:bg-amber-900/60'}`}
        title={secret ? 'Trader relay configured. Click to reconfigure.' : 'Set X-Relay-Auth to enable trading.'}
      >
        {secret ? '✓ Trader connected' : 'Connect trader…'}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setOpen(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-[520px] p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="text-lg font-bold text-gray-100 mb-2">Connect trader relay</div>
            <p className="text-xs text-gray-500 mb-4">
              Paste your <span className="font-mono text-gray-300">RELAY_SECRET</span> from <code className="font-mono text-gray-300">/tmp/relay_secret.txt</code> or
              wherever you saved it. Stored in browser localStorage only — never sent to Vercel.
              Relay endpoint: <span className="font-mono text-gray-400">{RELAY_URL}</span>
            </p>
            <input
              type="password"
              autoFocus
              placeholder="64-char hex string"
              value={value}
              onChange={e => setValue(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono bg-gray-800 text-gray-100 rounded border border-gray-700 focus:outline-none focus:border-blue-500"
            />
            <div className="flex justify-between mt-4">
              <button
                onClick={() => { onSave(null); setOpen(false) }}
                className="text-xs text-red-400 hover:text-red-300"
              >Clear stored secret</button>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
                <button
                  onClick={() => { onSave(value.trim() || null); setOpen(false) }}
                  className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded"
                >Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
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
  const [relaySecret, setRelaySecret] = useState<string | null>(null)
  const [ladderPlan, setLadderPlan] = useState<LadderPlan | null>(null)
  const [positions, setPositions] = useState<PolyPosition[]>([])
  const detailReqId = useRef(0)

  // Load saved relay secret from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    const s = window.localStorage.getItem('relay_secret')
    if (s) setRelaySecret(s)
  }, [])
  const saveRelaySecret = useCallback((s: string | null) => {
    setRelaySecret(s)
    if (typeof window === 'undefined') return
    if (s) window.localStorage.setItem('relay_secret', s)
    else window.localStorage.removeItem('relay_secret')
  }, [])

  // Load predictions + Polymarket-only events on mount
  useEffect(() => {
    let cancelled = false
    async function load() {
      const [preds, pmb] = await Promise.all([
        supabase.from('upcoming_predictions')
          .select('blue_team,red_team,league,best_of,pred_blue_win,date,poly_event_slug,poly_team1,poly_volume,blue_elo,red_elo,elo_diff')
          .order('date', { ascending: true }),
        // Pull every Polymarket-tracked event so Challengers / Prime / CBLOL etc.
        // surface here even though the model doesn't predict them.
        supabase.from('poly_market_balance')
          .select('event_slug,event_title,tournament,team1,team2,best_of,market_type,total_volume_usd,last_trade_price,last_trade_ts'),
      ])
      if (cancelled) return
      if (preds.error) { setError(preds.error.message); setLoadingList(false); return }

      // 1) Events with a model prediction
      const predRows = ((preds.data ?? []) as Prediction[]).filter(p => p.poly_event_slug)
      const haveSlug = new Set(predRows.map(p => p.poly_event_slug))

      // Settled-event detection: a match is "stale" if its match_winner submarket's
      // last trade is pinned to 0/1 (resolved) AND the event has already started.
      // Polymarket-resolved markets don't always tag at exactly 1.00 — they sit
      // at ~0.96-0.98 since there's no incentive to trade after resolution.
      type PmbRow = {
        event_slug: string; event_title: string | null; tournament: string | null;
        team1: string | null; team2: string | null; best_of: number | null;
        market_type: string; total_volume_usd: number | null;
        last_trade_price: number | null; last_trade_ts: number | null;
      }
      const settledSlugs = new Set<string>()
      const nowSec = Date.now() / 1000
      for (const r of (pmb.data ?? []) as PmbRow[]) {
        if (r.market_type !== 'match_winner') continue
        const p = r.last_trade_price
        const ts = r.last_trade_ts
        // Extreme price + last trade >1h ago = resolved (live games still trade frequently)
        if (p != null && (p >= 0.95 || p <= 0.05) && ts != null && nowSec - ts > 3600) {
          settledSlugs.add(r.event_slug)
        }
      }

      // 2) Polymarket-only events (group balance rows by event_slug, dedupe)
      const pmbBySlug = new Map<string, Prediction>()
      for (const r of (pmb.data ?? []) as PmbRow[]) {
        if (!r.event_slug || haveSlug.has(r.event_slug)) continue
        const existing = pmbBySlug.get(r.event_slug)
        const vol = (existing?.poly_volume ?? 0) + (r.market_type === 'match_winner' ? (r.total_volume_usd ?? 0) : 0)
        // Date is encoded as the last segment of the slug: lol-…-YYYY-MM-DD
        const m = r.event_slug.match(/(\d{4}-\d{2}-\d{2})$/)
        const date = m ? `${m[1]}T00:00:00Z` : new Date().toISOString()
        // Map tournament → short league badge
        const tour = r.tournament ?? ''
        const league =
          /^LCK Challengers/i.test(tour) ? 'LCK-C' :
          /^LCK\b/i.test(tour)           ? 'LCK'  :
          /^LCS\b/i.test(tour)           ? 'LCS'  :
          /^LEC\b/i.test(tour)           ? 'LEC'  :
          /^LPL\b/i.test(tour)           ? 'LPL'  :
          /Esports World Cup/i.test(tour) ? 'EWC' :
          /Prime League/i.test(tour)     ? 'PRM'  :
          /CBLOL/i.test(tour)            ? 'CBLOL':
          /TCL/i.test(tour)              ? 'TCL'  :
          /LJL/i.test(tour)              ? 'LJL'  :
          /LCP/i.test(tour)              ? 'LCP'  :
          /Hitpoint|Hitpoint Masters/i.test(tour) ? 'HM' :
          /HLL/i.test(tour)              ? 'HLL'  :
          /LPLOL/i.test(tour)            ? 'LPLOL':
          /Rift Legends/i.test(tour)     ? 'RL'   :
          /North American Challengers/i.test(tour) ? 'NACL' :
          /LES\b/i.test(tour)            ? 'LES'  :
          /LIT\b/i.test(tour)            ? 'LIT'  :
          /Circuito Desafiante/i.test(tour) ? 'CDF' :
          /Road Of Legends/i.test(tour)  ? 'ROL'  :
          'OTHER'
        pmbBySlug.set(r.event_slug, existing ?? {
          blue_team: r.team1 ?? '',
          red_team:  r.team2 ?? '',
          league,
          best_of:   r.best_of ?? 3,
          pred_blue_win: null as unknown as number,  // sentinel: no model → fv columns blank
          date,
          poly_event_slug: r.event_slug,
          poly_team1: r.team1,
          poly_volume: vol,
          blue_elo: null,
          red_elo:  null,
          elo_diff: null,
        })
        if (existing) existing.poly_volume = vol
      }
      const merged: Prediction[] = [...predRows, ...pmbBySlug.values()]
        .filter(e => !e.poly_event_slug || !settledSlugs.has(e.poly_event_slug))
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))

      setEvents(merged)
      if (merged.length > 0) setSelectedSlug(merged[0].poly_event_slug ?? null)
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

  // Poll positions when relay is connected
  useEffect(() => {
    if (!relaySecret) { setPositions([]); return }
    let cancelled = false
    async function poll() {
      const ps = await fetchPositions(relaySecret!)
      if (!cancelled) setPositions(ps)
    }
    poll()
    const interval = setInterval(poll, 5_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [relaySecret])

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
        <RelaySettings secret={relaySecret} onSave={saveRelaySecret} />
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
              positions={positions}
              onClosePosition={(thisRow, oppositeRow) => {
                setLadderPlan(buildLadderPlan(thisRow, oppositeRow, detail))
              }}
              onPlanTrade={(thisRow, oppositeRow) => {
                setLadderPlan(buildLadderPlan(thisRow, oppositeRow, detail))
              }}
            />
          ) : (
            <div className="p-6 text-gray-500 text-sm">Select an event.</div>
          )}
        </main>
      </div>
      {ladderPlan && (
        <LadderModal
          plan={ladderPlan}
          secret={relaySecret}
          onClose={() => setLadderPlan(null)}
        />
      )}
    </div>
  )
}
