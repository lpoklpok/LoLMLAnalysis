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

// Live-model snapshot from LoLLivePredictor worker (via /api/lol/live-state).
// One per currently-live game. We match by team names (fuzzy lowercase/strip).
interface LiveSnapshot {
  game_id: string
  event_id: string
  league: string
  team_a_id: string
  team_a_name: string
  team_b_id: string
  team_b_name: string
  blue_team_id: string | null
  red_team_id: string | null
  game_number: number
  series_prior: number
  per_game_prior_blue: number
  clock_s: number
  state: string
  blue_kills: number; red_kills: number
  blue_towers: number; red_towers: number
  blue_dragons: number; red_dragons: number
  blue_soul: boolean; red_soul: boolean
  blue_barons: number; red_barons: number
  blue_inhib: number; red_inhib: number
  gold_diff: number
  kill_diff: number
  p_model: number
  p_adj: number
  buffer_s: number
  updated_ts: number
}

// ── Math helpers ────────────────────────────────────────────────────────────

// Draft-swap aware series probability. The G1 loser picks blue side in G2,
// which historically carries a small advantage — modeled by alpha_g2 (shrinks
// the per-game logit slightly) + beta_da (signed blue-side draft advantage).
// Matches src/predict_upcoming.py and /pre-live's computeProbs.
const ALPHA_G2 = 0.897
const BETA_DA  = 0.0929

function seriesProb(pG1: number, bestOf: number): number {
  if (bestOf <= 1) return pG1
  const z          = Math.log(pG1 / (1 - pG1))
  const g1         = pG1
  const g2_t1won   = 1 / (1 + Math.exp(-(ALPHA_G2 * z - BETA_DA)))
  const g2_t2won   = 1 / (1 + Math.exp(-(ALPHA_G2 * z + BETA_DA)))
  const g3plus     = g1
  const needed     = Math.ceil(bestOf / 2)
  function r(t1w: number, t2w: number, prev: 't1' | 't2' | null): number {
    if (t1w === needed) return 1
    if (t2w === needed) return 0
    const gnum = t1w + t2w + 1
    let p: number
    if      (gnum === 1) p = g1
    else if (gnum === 2) p = prev === 't1' ? g2_t1won : g2_t2won
    else                 p = g3plus
    return p * r(t1w + 1, t2w, 't1') + (1 - p) * r(t1w, t2w + 1, 't2')
  }
  return r(0, 0, null)
}

// Series probability that overrides game `liveGameNum` with `pLive` (the
// in-game team1 win prob from the live model), starting from a given series
// score (t1Wins-t2Wins). Other games use the static draft-aware formula.
//
// Use when a specific game is in progress: pLive replaces the static G_N prob
// for the live game. Settled games (G1 if we're in G2) are accounted for by
// passing the current series score, not 0-0.
function seriesProbLive(
  pStatic:     number,
  bestOf:      number,
  startT1Wins: number,
  startT2Wins: number,
  liveGameNum: number,
  pLive:       number,
): number {
  if (bestOf <= 1) return pLive
  const z         = Math.log(pStatic / (1 - pStatic))
  const g2_t1won  = 1 / (1 + Math.exp(-(ALPHA_G2 * z - BETA_DA)))
  const g2_t2won  = 1 / (1 + Math.exp(-(ALPHA_G2 * z + BETA_DA)))
  const g3plus    = pStatic
  const needed    = Math.ceil(bestOf / 2)
  function r(t1w: number, t2w: number, prev: 't1' | 't2' | null): number {
    if (t1w === needed) return 1
    if (t2w === needed) return 0
    const gnum = t1w + t2w + 1
    let p: number
    if      (gnum === liveGameNum) p = pLive
    else if (gnum === 1)           p = pStatic
    else if (gnum === 2)           p = prev === 't1' ? g2_t1won : g2_t2won
    else                           p = g3plus
    return p * r(t1w + 1, t2w, 't1') + (1 - p) * r(t1w, t2w + 1, 't2')
  }
  return r(startT1Wins, startT2Wins, null)
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

// SSE-driven live-model snapshot. The Fly worker pushes one snapshot per
// frame on /stream; we maintain a local map keyed by game_id and pick the
// freshest match by team-name fuzzy compare.
//
// Was polling /api/lol/live-state every 1s — meant 86,400 round-trips/day
// per open tab + 1s worst-case staleness + Vercel cold-start on every poll.
// SSE drops latency to ~10-50ms and traffic to "only when state changes."
// Safety-net /state pull every 30s in case SSE silently disconnects.
function useLiveSnapshot(blueTeam: string | null, redTeam: string | null): LiveSnapshot | null {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null)
  useEffect(() => {
    if (!blueTeam || !redTeam) { setSnap(null); return }
    const a_n = blueTeam.toLowerCase().replace(/[^a-z0-9]/g, '')
    const b_n = redTeam.toLowerCase().replace(/[^a-z0-9]/g, '')

    const matches = (g: LiveSnapshot): boolean => {
      const ga = (g.team_a_name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const gb = (g.team_b_name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
      return (a_n.includes(ga) || ga.includes(a_n)) && (b_n.includes(gb) || gb.includes(b_n))
          || (a_n.includes(gb) || gb.includes(a_n)) && (b_n.includes(ga) || ga.includes(b_n))
    }

    // Local games map (keyed by game_id) — built up from SSE pushes + seed.
    const games = new Map<string, LiveSnapshot>()
    const recompute = () => {
      let best: LiveSnapshot | null = null
      for (const g of games.values()) {
        if (!matches(g)) continue
        if (!best || g.updated_ts > best.updated_ts) best = g
      }
      setSnap(best)
    }

    // Initial state pull so the first paint isn't empty.
    let cancelled = false
    const seed = async () => {
      try {
        const r = await fetch('/api/lol/live-state', { cache: 'no-store' })
        if (!r.ok || cancelled) return
        const d = await r.json() as { games?: Record<string, LiveSnapshot> }
        for (const g of Object.values(d.games ?? {})) games.set(g.game_id, g)
        recompute()
      } catch { /* ignore */ }
    }
    seed()

    // SSE: each `data: <json>` is one snapshot.
    const es = new EventSource('/api/lol/live-stream')
    es.onmessage = (ev) => {
      try {
        const g = JSON.parse(ev.data) as LiveSnapshot
        if (g.game_id) {
          games.set(g.game_id, g)
          recompute()
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => { /* EventSource auto-reconnects */ }

    // Safety-net /state re-pull every 30s in case SSE silently dies.
    const safety = setInterval(seed, 30_000)

    return () => { cancelled = true; es.close(); clearInterval(safety) }
  }, [blueTeam, redTeam])
  return snap
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
  // True when fv was computed using the live in-game model (vs pre-game prior)
  fv_is_live: boolean
}

// Normalise team names for matching against Polymarket outcomes. Polymarket
// uses different spacing/punctuation than OE/our DB (e.g. "Nongshim Red Force"
// vs our "Nongshim RedForce"), so we strip all non-alphanumeric chars before
// comparing. Mirrors the python `_norm_team` in src/merge_polymarket_data.py.
const _normTeam = (s: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function buildRows(pred: Prediction, detail: EventDetail | null, liveSnap: LiveSnapshot | null): Row[] {
  if (!detail) return []
  const rows: Row[] = []
  const bo = pred.best_of
  // Per-game side-neutral prob for blue team. Null for events outside the
  // model's coverage (e.g. LCK Challengers League) — we still render the
  // row with prices, just no fair-value/edge columns.
  const pBlue = pred.pred_blue_win
  const hasModel = pBlue != null && !Number.isNaN(pBlue)

  // ── Live-model FV override ─────────────────────────────────────────────
  // When this matchup has an in-progress game, replace the static per-game
  // prior with the live `p_adj` for that game number. Match Winner gets
  // recomputed via seriesProbLive accounting for any settled games.
  //
  // IMPORTANT: Supabase's `pred.blue_team` (the row's "blue_team" column) does
  // NOT always match lolesports' team_a (first-listed team). They can diverge
  // when the schedule lists teams in a different order. So we derive the
  // actual in-game blue side name directly from the worker fields, then match
  // each market's outcome[0] against THAT name (not via pred.blue_team).
  let liveGameNum: number | null = null
  let ingameBlueNameNorm: string | null = null
  let t1Wins = 0, t2Wins = 0
  if (liveSnap && hasModel) {
    liveGameNum = liveSnap.game_number
    const ingameBlueIsWorkerA = liveSnap.blue_team_id !== null
      ? liveSnap.blue_team_id === liveSnap.team_a_id
      : true
    const ingameBlueName = ingameBlueIsWorkerA ? liveSnap.team_a_name : liveSnap.team_b_name
    ingameBlueNameNorm = _normTeam(ingameBlueName)

    // Detect settled prior games from pinned game_N_winner mids (relative to team1)
    for (const sm of detail.submarkets) {
      if (!sm.market_type.startsWith('game_') || !sm.market_type.endsWith('_winner')) continue
      const n = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
      if (!Number.isFinite(n) || n >= liveGameNum) continue
      const [m1, m2] = sm.outcome_mids
      const t1IsThisMarketBlue = _normTeam(sm.outcomes[0]) === _normTeam(pred.blue_team)
      const t1Pin = t1IsThisMarketBlue ? m1 : m2
      if (t1Pin != null && t1Pin >= 0.98) t1Wins++
      else if (t1Pin != null && t1Pin <= 0.02) t2Wins++
    }
  }
  // Per-market resolver: P(market.outcome[0] wins the live game) from p_adj.
  // Computed per submarket because outcome ordering varies across markets.
  function pTeam1LiveFor(o1: string): number | null {
    if (!liveSnap || ingameBlueNameNorm == null) return null
    const t1 = _normTeam(o1)
    const isBlue = t1 === ingameBlueNameNorm
      || t1.includes(ingameBlueNameNorm) || ingameBlueNameNorm.includes(t1)
    return isBlue ? liveSnap.p_adj : 1 - liveSnap.p_adj
  }

  // For each polymarket submarket, compute model fair value for outcomes[0] and outcomes[1].
  for (const sm of detail.submarkets) {
    const [o1, o2] = sm.outcomes
    const [mid1, mid2] = sm.outcome_mids

    let fv1: number | null = null
    let fv2: number | null = null
    let fv_is_live = false
    let market_label: string = sm.question

    if (sm.market_type === 'match_winner') {
      market_label = 'Match Winner'
      if (hasModel) {
        const team1IsBlue = _normTeam(o1) === _normTeam(pred.blue_team)
        const pTeam1Game = team1IsBlue ? (pBlue as number) : 1 - (pBlue as number)
        const pT1Live = liveGameNum != null ? pTeam1LiveFor(o1) : null
        if (liveGameNum != null && pT1Live != null) {
          fv1 = seriesProbLive(pTeam1Game, bo, t1Wins, t2Wins, liveGameNum, pT1Live)
          fv_is_live = true
        } else {
          fv1 = seriesProb(pTeam1Game, bo)
        }
        fv2 = 1 - fv1
      }
    } else if (sm.market_type.startsWith('game_') && sm.market_type.endsWith('_winner')) {
      const gnum = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
      market_label = `Game ${gnum} Winner`
      if (hasModel) {
        const team1IsBlue = _normTeam(o1) === _normTeam(pred.blue_team)
        if (liveGameNum != null && gnum === liveGameNum) {
          const pT1Live = pTeam1LiveFor(o1)
          if (pT1Live != null) {
            fv1 = pT1Live
            fv_is_live = true
          } else {
            fv1 = team1IsBlue ? (pBlue as number) : 1 - (pBlue as number)
          }
        } else {
          fv1 = team1IsBlue ? (pBlue as number) : 1 - (pBlue as number)
        }
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
      fv_is_live,
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
      fv_is_live,
    })
  }
  return rows
}

function MainPanel({
  pred, detail, loading, lastRefreshed, onRefresh, onPlanTrade, positions, onClosePosition,
  openLadderTokenId, onLadderRefresh,
}: {
  pred: Prediction
  detail: EventDetail | null
  loading: boolean
  lastRefreshed: Date | null
  onRefresh: () => void
  onPlanTrade: (thisRow: Row, oppositeRow: Row) => void
  positions: PolyPosition[]
  onClosePosition: (thisRow: Row, oppositeRow: Row) => void
  openLadderTokenId: string | null            // token_id of the row whose ladder modal is currently open
  onLadderRefresh: (thisRow: Row, oppositeRow: Row) => void
}) {
  // Live-model snapshot (if this game is currently live)
  const liveSnap = useLiveSnapshot(pred.blue_team, pred.red_team)
  const rows = useMemo(() => buildRows(pred, detail, liveSnap), [pred, detail, liveSnap])

  // When the live model updates `rows`, push the refreshed thisRow/oppositeRow
  // into the open ladder modal so its highlighted FAIR row follows live changes.
  // Stable ref to avoid infinite re-renders if parent passes a fresh callback
  // every render (onLadderRefresh isn't wrapped in useCallback at the caller).
  const onLadderRefreshRef = useRef(onLadderRefresh)
  useEffect(() => { onLadderRefreshRef.current = onLadderRefresh }, [onLadderRefresh])
  useEffect(() => {
    if (!openLadderTokenId) return
    const i = rows.findIndex(r => r.token_id === openLadderTokenId)
    if (i < 0) return
    const same = rows.filter(r => r.market_type === rows[i].market_type)
    const opp  = same.find(r => r.token_id !== openLadderTokenId)
    if (opp) onLadderRefreshRef.current(rows[i], opp)
  }, [rows, openLadderTokenId])

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

  // Kalshi positions per ticker — for delta calc on Kalshi side. SSE-driven
  // instant updates on fill events, plus a 2s safety-net poll.
  const [kalshiPositions, setKalshiPositions] = useState<Record<string, number>>({})
  useEffect(() => {
    // Only fetch if event has any Kalshi tickers
    const hasKalshi = detail?.submarkets?.some(s => s.kalshi_sides?.some(k => k?.ticker))
    if (!hasKalshi) { setKalshiPositions({}); return }
    let cancelled = false
    const pull = async () => {
      try {
        const r = await fetch('/api/kalshi/positions', { cache: 'no-store' })
        if (!r.ok) return
        const d = await r.json() as { market_positions?: Array<{ ticker: string; position_fp?: string; position?: number }> }
        if (cancelled) return
        const m: Record<string, number> = {}
        for (const p of d.market_positions ?? []) {
          // Kalshi field is `position_fp` (signed string, e.g. "2.00" = long YES, "-3.50" = long NO).
          // Fall back to `position` for forward compat if API ever returns number.
          const raw = p.position_fp != null ? parseFloat(p.position_fp) :
                       p.position    != null ? Number(p.position) : 0
          if (Number.isFinite(raw)) m[p.ticker] = raw
        }
        setKalshiPositions(m)
      } catch { /* ignore */ }
    }
    pull()
    // SSE: push-driven instant refresh on fill events
    const es = new EventSource('/api/kalshi/user-stream')
    es.onmessage = () => pull()
    es.onerror = () => { /* browser auto-reconnects */ }
    // Safety-net poll (down from 5s → 2s)
    const id = setInterval(pull, 2000)
    return () => { cancelled = true; clearInterval(id); es.close() }
  }, [detail])

  // ── Game-level delta tracker ────────────────────────────────────────────
  // For each game in the series, compute net delta to team1 winning that game.
  // Delta sources for a position on team1 outcome of market M:
  //   - match_winner shares × ∂(series_prob_t1) / ∂(p_game_N) at current state
  //   - game_N_winner shares × 1   (direct exposure)
  //   - game_M_winner shares × 0  (M ≠ N)
  // Auto-detects completed games from `detail.submarkets[i].outcome_mids` being
  // pinned at 0/1 (resolved Polymarket games) — those contribute 0 delta and
  // shift the series state for remaining games.
  const gameDeltas = useMemo(() => {
    if (!detail || !pred.best_of || pred.best_of <= 1) return null
    const pRaw = pred.pred_blue_win
    if (pRaw == null || !Number.isFinite(pRaw)) return null
    const p: number = pRaw
    const bo  = pred.best_of
    const needed = Math.ceil(bo / 2)

    const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    // Game considered done when its game_N_winner submarket mid pins at ≥0.98 or ≤0.02.
    // (Polymarket resolved markets stop trading and pin near the outcome.)
    let t1Wins = 0, t2Wins = 0
    const settledGames: number[] = []
    for (const sm of detail.submarkets) {
      if (!sm.market_type.startsWith('game_') || !sm.market_type.endsWith('_winner')) continue
      const n = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
      if (!Number.isFinite(n)) continue
      const t1IsBlue = norm(sm.outcomes[0]) === norm(pred.blue_team)
      const [m1, m2] = sm.outcome_mids
      const settled = (m1 != null && (m1 >= 0.98 || m1 <= 0.02)) ||
                       (m2 != null && (m2 >= 0.98 || m2 <= 0.02))
      if (!settled) continue
      const t1Won = (t1IsBlue && (m1 ?? 0) > 0.5) || (!t1IsBlue && (m2 ?? 0) > 0.5)
      if (t1Won) t1Wins++; else t2Wins++
      settledGames.push(n)
    }

    // Series prob from a (b, r) state (constant-p model, no draft swap)
    function sProb(b: number, r: number): number {
      if (b >= needed) return 1
      if (r >= needed) return 0
      return p * sProb(b+1, r) + (1-p) * sProb(b, r+1)
    }

    // Delta to (next undecided) game N's outcome = P(reach G_N AND win) − P(reach G_N AND lose),
    // measured as how series_prob changes when conditioning game N on win vs loss.
    // Computed by walking the tree: for each future game position equal to N,
    // accumulate (path_prob_to_reaching_that_game) × Δ_one_game.
    // Implementation: recursive walk that tracks "what game number we're at" relative to settled state.
    function deltaForGame(targetN: number): number {
      // gameNum 1..bo; we're starting after `t1Wins + t2Wins` games already settled
      const startGame = t1Wins + t2Wins + 1
      if (targetN < startGame) return 0   // game already played
      if (targetN > bo) return 0
      // Walk
      function w(b: number, r: number, gameNum: number): { wReach: number; lReach: number } {
        if (b >= needed) return { wReach: 0, lReach: 0 }
        if (r >= needed) return { wReach: 0, lReach: 0 }
        if (gameNum > bo) return { wReach: 0, lReach: 0 }
        if (gameNum === targetN) {
          // At target. If t1 wins it, contributes sProb(b+1,r) to win-conditional series_prob.
          return { wReach: sProb(b+1, r), lReach: sProb(b, r+1) }
        }
        const nW = w(b+1, r, gameNum+1)
        const nL = w(b, r+1, gameNum+1)
        return {
          wReach: p * nW.wReach + (1-p) * nL.wReach,
          lReach: p * nW.lReach + (1-p) * nL.lReach,
        }
      }
      const { wReach, lReach } = w(t1Wins, t2Wins, startGame)
      return wReach - lReach
    }

    // Helper to compute "net long team1" for a submarket, combining PM + Kalshi.
    // Kalshi position is signed (positive = YES contracts, negative = NO contracts).
    // YES on team1's ticker = long team1; YES on team2's ticker = long team2 (= short team1).
    const norm2 = norm
    function netT1(sm: { outcomes: [string, string]; token_ids: [string | null, string | null]; kalshi_sides: Array<{ ticker: string } | null> }): number {
      const t1Idx = norm2(sm.outcomes[0]) === norm2(pred.blue_team) ? 0 : 1
      // Polymarket
      const t1Tok = sm.token_ids[t1Idx]
      const t2Tok = sm.token_ids[1 - t1Idx]
      const pmT1 = t1Tok ? num(positionByToken.get(t1Tok)?.size) : 0
      const pmT2 = t2Tok ? num(positionByToken.get(t2Tok)?.size) : 0
      // Kalshi: position is signed per ticker (+ = YES contracts, - = NO contracts)
      const kT1Ticker = sm.kalshi_sides[t1Idx]?.ticker
      const kT2Ticker = sm.kalshi_sides[1 - t1Idx]?.ticker
      // Long team1 = +YES on t1 ticker, -NO on t1 ticker, -YES on t2 ticker, +NO on t2 ticker
      // Equivalent to: kT1Pos - kT2Pos  (where pos = yes count - no count)
      const kT1 = kT1Ticker ? (kalshiPositions[kT1Ticker] ?? 0) : 0
      const kT2 = kT2Ticker ? (kalshiPositions[kT2Ticker] ?? 0) : 0
      return (pmT1 - pmT2) + (kT1 - kT2)
    }

    // Aggregate positions: for each game N, sum
    //   match_winner_net × deltaPerShare(N) + game_N_winner_net × 1
    const mwSm = detail.submarkets.find(s => s.market_type === 'match_winner')
    const mwNetT1 = mwSm ? netT1(mwSm) : 0

    const rows: Array<{ n: number; settled: boolean; delta_per_share: number; direct_pm: number; direct_kalshi: number; mw_contrib: number; total_t1: number }> = []
    for (let n = 1; n <= bo; n++) {
      const isSettled = settledGames.includes(n)
      const deltaPS = isSettled ? 0 : deltaForGame(n)
      const gw: Submarket | undefined = detail.submarkets.find(s => s.market_type === `game_${n}_winner`)
      let direct_pm = 0, direct_kalshi = 0
      if (gw) {
        const t1Idx = norm(gw.outcomes[0]) === norm(pred.blue_team) ? 0 : 1
        const t1Tok = gw.token_ids[t1Idx]
        const t2Tok = gw.token_ids[1 - t1Idx]
        direct_pm = (t1Tok ? num(positionByToken.get(t1Tok)?.size) : 0) - (t2Tok ? num(positionByToken.get(t2Tok)?.size) : 0)
        const kT1 = gw.kalshi_sides[t1Idx]?.ticker
        const kT2 = gw.kalshi_sides[1 - t1Idx]?.ticker
        direct_kalshi = (kT1 ? (kalshiPositions[kT1] ?? 0) : 0) - (kT2 ? (kalshiPositions[kT2] ?? 0) : 0)
      }
      const mw_contrib = mwNetT1 * deltaPS
      const total_t1 = mw_contrib + direct_pm + direct_kalshi
      rows.push({ n, settled: isSettled, delta_per_share: deltaPS, direct_pm, direct_kalshi, mw_contrib, total_t1 })
    }
    return { rows, t1Wins, t2Wins, needed, mwNetT1, p }
  }, [detail, pred, positionByToken, kalshiPositions])

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

      {/* Game-level delta tracker */}
      {gameDeltas && (gameDeltas.mwNetT1 !== 0 || gameDeltas.rows.some(r => r.direct_pm !== 0 || r.direct_kalshi !== 0)) && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-300">Per-game delta</h3>
            <div className="text-[10px] text-gray-500">
              Series state: {gameDeltas.t1Wins}–{gameDeltas.t2Wins} (need {gameDeltas.needed})
              {gameDeltas.mwNetT1 !== 0 && (
                <span className="ml-3">Match-Winner net: {gameDeltas.mwNetT1 > 0 ? '+' : ''}{gameDeltas.mwNetT1.toFixed(0)} {pred.blue_team}</span>
              )}
            </div>
          </div>
          <table className="w-full text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="text-left py-1 pr-2">Game</th>
                <th className="text-right py-1 pr-2" title="Delta-per-share: how much owning 1 match_winner share moves with this game's outcome">δ/share</th>
                <th className="text-right py-1 pr-2" title="Match-winner delta contribution to this game (PM + Kalshi)">from MW</th>
                <th className="text-right py-1 pr-2" title="Net Polymarket position on game_N_winner market (long t1 − long t2)">PM g_N</th>
                <th className="text-right py-1 pr-2" title="Net Kalshi position on game_N market (yes_t1 − yes_t2, signed)">Kalshi g_N</th>
                <th className="text-right py-1" title="Net delta = MW contribution + direct PM + direct Kalshi">Net δ ({pred.blue_team.slice(0,8)})</th>
              </tr>
            </thead>
            <tbody>
              {gameDeltas.rows.map(r => (
                <tr key={r.n} className={`border-t border-gray-800/50 ${r.settled ? 'opacity-50' : ''}`}>
                  <td className="py-1 pr-2 font-mono">
                    G{r.n} {r.settled && <span className="text-[9px] text-gray-600 uppercase">done</span>}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono text-gray-400">{r.settled ? '—' : r.delta_per_share.toFixed(3)}</td>
                  <td className="py-1 pr-2 text-right font-mono text-gray-400">{r.mw_contrib === 0 ? '—' : (r.mw_contrib > 0 ? '+' : '') + r.mw_contrib.toFixed(1)}</td>
                  <td className={`py-1 pr-2 text-right font-mono ${r.direct_pm > 0 ? 'text-emerald-400' : r.direct_pm < 0 ? 'text-rose-400' : 'text-gray-700'}`}>{r.direct_pm === 0 ? '—' : (r.direct_pm > 0 ? '+' : '') + r.direct_pm.toFixed(0)}</td>
                  <td className={`py-1 pr-2 text-right font-mono ${r.direct_kalshi > 0 ? 'text-emerald-400' : r.direct_kalshi < 0 ? 'text-rose-400' : 'text-gray-700'}`}>{r.direct_kalshi === 0 ? '—' : (r.direct_kalshi > 0 ? '+' : '') + r.direct_kalshi.toFixed(0)}</td>
                  <td className={`py-1 text-right font-mono font-semibold ${r.total_t1 > 0 ? 'text-emerald-400' : r.total_t1 < 0 ? 'text-rose-400' : 'text-gray-500'}`}>
                    {r.total_t1 === 0 ? '0' : (r.total_t1 > 0 ? '+' : '') + r.total_t1.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[10px] text-gray-600 mt-2">
            Per-game probability used: {(gameDeltas.p * 100).toFixed(1)}% for {pred.blue_team}.
            Net δ &gt; 0 = long {pred.blue_team} on that game; &lt; 0 = long {pred.red_team}. Settled games show δ = 0 and shift remaining states.
          </div>
        </div>
      )}

      {/* Live model — only renders when this matchup has an in-progress game */}
      {liveSnap && (() => {
        // Resolve the actual in-game blue side directly from the worker.
        // `liveSnap.blue_team_id` matches one of (team_a_id, team_b_id).
        const ingameBlueIsWorkerA = liveSnap.blue_team_id !== null
          ? liveSnap.blue_team_id === liveSnap.team_a_id
          : true
        const liveBlueLabel = ingameBlueIsWorkerA ? liveSnap.team_a_name : liveSnap.team_b_name
        // p_model / p_adj from the worker are ALREADY P(in-game blue wins).
        // No conditional flip needed.
        const pBlueModel = liveSnap.p_model
        const pBlueAdj   = liveSnap.p_adj
        const mins = Math.floor(liveSnap.clock_s / 60)
        const secs = Math.floor(liveSnap.clock_s % 60)
        const clockStr = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`
        // FV for series, using live p_blue for the CURRENT live game only.
        // Map team1 (= pred.blue_team, our DB's reference frame) to the live
        // game's blue side via name. pred.blue_team may or may not match the
        // in-game blue side name.
        const liveBlueNorm  = _normTeam(liveBlueLabel)
        const predBlueNorm  = _normTeam(pred.blue_team)
        const predBlueIsIngameBlue =
          predBlueNorm === liveBlueNorm
          || predBlueNorm.includes(liveBlueNorm) || liveBlueNorm.includes(predBlueNorm)
        const pStaticT1 = pred.pred_blue_win ?? 0.5  // already team1 = pred.blue_team
        const pTeam1LiveForSeries = predBlueIsIngameBlue ? pBlueAdj : 1 - pBlueAdj
        // Detect settled prior games (team1 = pred.blue_team perspective)
        let t1W = 0, t2W = 0
        for (const sm of detail?.submarkets ?? []) {
          if (!sm.market_type.startsWith('game_') || !sm.market_type.endsWith('_winner')) continue
          const n = parseInt(sm.market_type.replace('game_','').replace('_winner',''), 10)
          if (!Number.isFinite(n) || n >= liveSnap.game_number) continue
          const t1IsThisMarketBlue = _normTeam(sm.outcomes[0]) === _normTeam(pred.blue_team)
          const t1Pin = t1IsThisMarketBlue ? sm.outcome_mids[0] : sm.outcome_mids[1]
          if (t1Pin != null && t1Pin >= 0.98) t1W++
          else if (t1Pin != null && t1Pin <= 0.02) t2W++
        }
        const liveSeriesFV = seriesProbLive(
          pStaticT1, pred.best_of, t1W, t2W, liveSnap.game_number, pTeam1LiveForSeries,
        )
        return (
          <div className="bg-gradient-to-r from-red-950/40 to-pink-950/30 border border-red-900/50 rounded-xl p-4 space-y-2">
            <div className="flex items-baseline gap-3">
              <span className="text-xs uppercase tracking-wide text-red-300 font-semibold">● LIVE Model</span>
              <span className="text-xs text-gray-400">Game {liveSnap.game_number} · {clockStr} · {liveSnap.state}</span>
              <span className="text-[10px] text-gray-600 ml-auto">
                buf {liveSnap.buffer_s}s · upd {Math.round((Date.now()/1000) - liveSnap.updated_ts)}s ago
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-2 text-sm">
              <div>
                <div className="text-[10px] uppercase text-gray-500">In-game state</div>
                <div className="font-mono text-gray-100">
                  {liveSnap.blue_kills}–{liveSnap.red_kills} K · {liveSnap.blue_towers}–{liveSnap.red_towers} T
                </div>
                <div className="font-mono text-[11px] text-gray-400">
                  {liveSnap.blue_dragons}{liveSnap.blue_soul ? '🐲SOUL' : ''}–{liveSnap.red_dragons}{liveSnap.red_soul ? '🐲SOUL' : ''} D · {liveSnap.blue_barons}–{liveSnap.red_barons} B · {liveSnap.blue_inhib}–{liveSnap.red_inhib} I
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-gray-500">Gold diff</div>
                <div className={`font-mono text-base ${liveSnap.gold_diff > 0 ? 'text-blue-300' : liveSnap.gold_diff < 0 ? 'text-rose-300' : 'text-gray-300'}`}>
                  {liveSnap.gold_diff > 0 ? '+' : ''}{Math.round(liveSnap.gold_diff).toLocaleString()}
                </div>
                <div className="text-[10px] text-gray-600">in-game blue</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-gray-500">p_blue (model)</div>
                <div className="font-mono text-base text-gray-100">{fmtPct(pBlueModel)}</div>
                <div className="text-[10px] text-gray-600">{liveBlueLabel.slice(0,12)} on blue</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-gray-500">p_blue (+overlay)</div>
                <div className="font-mono text-base text-red-200 font-semibold">{fmtPct(pBlueAdj)}</div>
                <div className="text-[10px] text-gray-600">soul/baron/inhib aware</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-gray-500">Live series FV (t1)</div>
                <div className="font-mono text-base text-pink-200 font-semibold">{fmtPct(liveSeriesFV)}</div>
                <div className="text-[10px] text-gray-600">replaces pre-game FV</div>
              </div>
            </div>
            <div className="text-[10px] text-gray-600 pt-1">
              Note: ~22-25s lag vs broadcast (lolesports floor). MMs with GRID see this ~18-22s earlier.
            </div>
          </div>
        )
      })()}

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
                          {r.fv_is_live ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-950/70 border border-red-700/60 text-red-200 font-mono text-xs font-semibold">
                              <span className="text-red-400 text-[9px] animate-pulse">●</span>
                              fair {fmtPct(r.fv)}
                            </span>
                          ) : (
                            <div className="text-xs text-gray-400 font-mono">fair {fmtPct(r.fv)}</div>
                          )}
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
                    <td className="px-4 py-2 text-right tabular-nums font-mono"
                        title={r.fv_is_live ? 'Live in-game model FV (replaces pre-game prior)' : 'Pre-game model FV'}>
                      {r.fv_is_live ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-950/70 border border-red-700/60 text-red-200 font-semibold">
                          <span className="text-red-400 text-[10px] animate-pulse">●</span>
                          {fmtPct(r.fv)}
                        </span>
                      ) : (
                        <span className="text-gray-300">{fmtPct(r.fv)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono text-xs">
                      {r.bid != null || r.ask != null ? (
                        <span>
                          <span className="text-green-400">{r.bid != null ? (r.bid * 100).toFixed(1) : '–'}</span>
                          <span className="text-gray-700 mx-1">·</span>
                          {r.fv != null && (
                            <>
                              <span className={r.fv_is_live ? 'text-amber-300 font-bold' : 'text-amber-500/80'}
                                    title={r.fv_is_live ? 'Live in-game model fair' : 'Pre-game model fair'}>
                                {r.fv_is_live && '●'}{Math.round(r.fv * 100)}
                              </span>
                              <span className="text-gray-700 mx-1">·</span>
                            </>
                          )}
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
  plan, secret, polyPositions, onOrderFired, onClose,
}: {
  plan:          LadderPlan
  secret:        string | null
  polyPositions: PolyPosition[]
  onOrderFired?: () => void   // called after each successful fire so parent can refresh PM positions
  onClose:       () => void
}) {
  const { thisRow, oppositeRow, kalshiSide, kalshiOpposite } = plan
  const thisTokenId = thisRow.token_id
  const oppTokenId  = oppositeRow.token_id

  // Books indexed by token_id; we render thisRow's book in the main grid.
  const [books, setBooks] = useState<Record<string, BookState>>({})
  const [kalshiThis, setKalshiThis] = useState<KalshiBook | null>(null)
  const [kalshiOpp,  setKalshiOpp]  = useState<KalshiBook | null>(null)
  // Kalshi positions: yes_count + no_count keyed by ticker
  const [kalshiPositions, setKalshiPositions] = useState<Record<string, { yes: number; no: number; avg_yes?: number; avg_no?: number }>>({})

  // Pull function exposed for instant-refresh after a fill
  const pullKalshiPositions = useCallback(async () => {
    try {
      const r = await fetch('/api/kalshi/positions', { cache: 'no-store' })
      if (!r.ok) return
      const d = await r.json() as { market_positions?: Array<{ ticker: string; position_fp?: string; position?: number }> }
      const map: Record<string, { yes: number; no: number }> = {}
      for (const p of d.market_positions ?? []) {
        const raw = p.position_fp != null ? parseFloat(p.position_fp) :
                     p.position    != null ? Number(p.position) : 0
        if (!Number.isFinite(raw)) continue
        const yes = raw > 0 ? raw : 0
        const no  = raw < 0 ? -raw : 0
        map[p.ticker] = { yes, no }
      }
      setKalshiPositions(map)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!kalshiSide?.ticker && !kalshiOpposite?.ticker) return
    pullKalshiPositions()
    // WSS-driven instant refresh: subscribe to fill events from the Kalshi
    // worker. Each fill triggers a position re-pull. Safety-net slow poll
    // (30s) in case SSE silently dies.
    const es = new EventSource('/api/kalshi/user-stream')
    es.onmessage = () => { pullKalshiPositions() }
    es.onerror   = () => { /* browser auto-reconnects */ }
    const safety = setInterval(pullKalshiPositions, 30_000)
    return () => { es.close(); clearInterval(safety) }
  }, [kalshiSide?.ticker, kalshiOpposite?.ticker, pullKalshiPositions])
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
    // Instant-refresh PM positions (data-api is laggy ~30-60s so this only
    // shortens the visible delay vs the 5s poll, not the underlying lag).
    if (resp.ok) {
      onOrderFired?.()
      setTimeout(() => onOrderFired?.(), 1200)
    }
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

  // ── Kalshi click-to-trade ────────────────────────────────────────────
  async function fireKalshi(args: {
    ticker:   string
    side:     'yes' | 'no'
    px_cents: number       // 1..99
    count:    number
    label:    string
  }) {
    if (size < 1 || !Number.isInteger(size)) {
      log(false, `kalshi size must be positive integer (got ${size})`)
      return
    }
    const t0 = Date.now()
    // Honor the IOC/GTD toggle from the top of the modal:
    //   FAK (IOC): expiration_ts = now+5s → Kalshi treats any expiry ≤ now+59s as IOC
    //              (match immediately, cancel any unfilled remainder). The +5s buffer
    //              avoids "expiration in the past" rejections from clock skew or
    //              network/proxy latency between browser → Vercel → Kalshi.
    //   GTD     : expiration_ts 5min from now → rests on the book
    const nowSec     = Math.floor(Date.now() / 1000)
    const expiration = mode === 'FAK' ? nowSec + 5 : nowSec + 300
    const modeTag    = mode === 'FAK' ? 'IOC' : 'GTD'
    log(true, `→ ${args.label} ${args.count} @ ${args.px_cents}¢ (kalshi · ${modeTag})`)
    try {
      const r = await fetch('/api/kalshi/order', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker:         args.ticker,
          side:           args.side,
          action:         'buy',
          count:          args.count,
          expiration_ts:  expiration,
          [args.side === 'yes' ? 'yes_price' : 'no_price']: args.px_cents,
        }),
      })
      const dt = Date.now() - t0
      const body = await r.json().catch(() => ({}))
      const ok = r.ok && body.ok !== false
      const summary = ok
        ? `✓ ${args.label} ${args.count}@${args.px_cents}¢ ${dt}ms — ${JSON.stringify(body).slice(0,150)}`
        : `✗ ${args.label} ${args.count}@${args.px_cents}¢ ${dt}ms — ${JSON.stringify(body).slice(0,180)}`
      log(ok, summary)
      // Instant-refresh positions so the user sees the fill without waiting for the 5s poll.
      // We do it twice: immediately (catches Kalshi side, REST is fast) and at 800ms
      // (catches any settled fills that needed a moment).
      if (ok) {
        pullKalshiPositions()
        setTimeout(() => { pullKalshiPositions(); onOrderFired?.() }, 800)
      }
    } catch (e) {
      log(false, `kalshi error: ${(e as Error).message}`)
    }
  }
  // Smart router: pick the ticker (team1 vs team2) whose book actually has the
  // resting offer at the user's chosen price. All orders are BUYs (no short
  // selling required).
  //
  // ASK click @ $p (user wants LONG team1, pay $p):
  //   - team1 has matching offer if kalshiThis.asks[$p] > 0  (= team1.no_dollars at $(1−p))
  //       → BUY YES on team1 at $p
  //   - team2 has matching offer if kalshiOpp.bids[$(1−p)] > 0  (= team2.yes_dollars at $(1−p))
  //       → BUY NO on team2 at $p
  //   - pick whichever has more visible size; default team1 if tied or both empty
  //
  // BID click @ $p (user wants SHORT team1 / synthetic SELL at $p):
  //   - team1 has matching bid if kalshiThis.bids[$p] > 0  (= team1.yes_dollars at $p)
  //       → BUY NO on team1 at $(1−p)
  //   - team2 has matching bid if kalshiOpp.asks[$(1−p)] > 0  (= team2.no_dollars at $p)
  //       → BUY YES on team2 at $(1−p)
  //   - pick whichever has more visible size; default team1 if tied or both empty
  function onClickKalshiAsk(price_yes: number) {
    const p_cents = Math.round(price_yes * 100)
    const inv_cents = 100 - p_cents
    const t1Size = kalshiThis?.asks.get(price_yes) ?? kalshiThis?.asks.get(Math.round(price_yes * 100) / 100) ?? 0
    const t2Size = kalshiOpp?.bids.get(Math.round((1 - price_yes) * 100) / 100) ?? 0
    const useTeam2 = t2Size > t1Size && !!kalshiOpposite?.ticker
    if (useTeam2) {
      fireKalshi({
        ticker:   kalshiOpposite!.ticker,
        side:     'no',
        px_cents: p_cents,
        count:    Math.round(size),
        label:    `BUY NO ${kalshiOpposite!.team} (=long ${kalshiSide?.team ?? 'team1'} @ ${p_cents}¢; routed via team2)`,
      })
    } else if (kalshiSide?.ticker) {
      fireKalshi({
        ticker:   kalshiSide.ticker,
        side:     'yes',
        px_cents: p_cents,
        count:    Math.round(size),
        label:    `BUY YES ${kalshiSide.team} @ ${p_cents}¢`,
      })
    }
    void inv_cents  // (silence unused — used as comment math)
  }
  function onClickKalshiBid(price_yes: number) {
    const p_cents     = Math.round(price_yes * 100)
    const inv_cents   = 100 - p_cents
    const t1Size = kalshiThis?.bids.get(Math.round(price_yes * 100) / 100) ?? 0
    const t2Size = kalshiOpp?.asks.get(Math.round((1 - price_yes) * 100) / 100) ?? 0
    const useTeam2 = t2Size > t1Size && !!kalshiOpposite?.ticker
    if (useTeam2) {
      fireKalshi({
        ticker:   kalshiOpposite!.ticker,
        side:     'yes',
        px_cents: inv_cents,
        count:    Math.round(size),
        label:    `BUY YES ${kalshiOpposite!.team} @ ${inv_cents}¢ (=short ${kalshiSide?.team ?? 'team1'} @ ${p_cents}¢; routed via team2)`,
      })
    } else if (kalshiSide?.ticker) {
      fireKalshi({
        ticker:   kalshiSide.ticker,
        side:     'no',
        px_cents: inv_cents,
        count:    Math.round(size),
        label:    `BUY NO ${kalshiSide.team} @ ${inv_cents}¢ (=short ${kalshiSide.team} @ ${p_cents}¢)`,
      })
    }
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

  // Model fair value, rounded to the nearest cent — used to highlight the
  // price row where our fair lives so you can see edge vs market at a glance.
  const fvCents: number | null = thisRow.fv != null && Number.isFinite(thisRow.fv)
    ? Math.max(1, Math.min(99, Math.round(thisRow.fv * 100)))
    : null
  // Same for the opposite outcome → maps to (1 - fv) cents on Kalshi book
  // (Kalshi is shown in team1's YES space, same as Polymarket here)

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
              title={mode === 'FAK' ? 'IOC mode — clicks fire fill-or-kill orders on both Polymarket (FAK) and Kalshi (expiration_ts=now+2s)' : 'GTD 5 min — clicks rest as limit orders on both PM and Kalshi for ~5 minutes'}>
              {mode === 'FAK' ? 'IOC' : 'GTD 5m'}
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none ml-1">×</button>
          </div>
        </div>

        {/* Positions banner — cumulative long/short for this team across PM + Kalshi */}
        {(() => {
          // Polymarket: positions matched by token_id (this outcome = long, opp = short)
          const pmLongShares  = polyPositions.find(p => (p.tokenId ?? p.token_id ?? p.asset) === thisTokenId)
          const pmShortShares = polyPositions.find(p => (p.tokenId ?? p.token_id ?? p.asset) === oppTokenId)
          const pmLong  = pmLongShares  ? num(pmLongShares.size) : 0
          const pmShort = pmShortShares ? num(pmShortShares.size) : 0
          // Kalshi: yes contracts on this team's ticker = long; no contracts = short (= long NO)
          const kThis = kalshiSide?.ticker ? kalshiPositions[kalshiSide.ticker] : undefined
          const kOpp  = kalshiOpposite?.ticker ? kalshiPositions[kalshiOpposite.ticker] : undefined
          const kLong  = (kThis?.yes ?? 0) + (kOpp?.no ?? 0)   // long this team = YES this OR NO opposite
          const kShort = (kThis?.no  ?? 0) + (kOpp?.yes ?? 0)  // short this team = NO this OR YES opposite

          const totalLong  = pmLong + kLong
          const totalShort = pmShort + kShort
          const net        = totalLong - totalShort
          const hasAny     = totalLong > 0 || totalShort > 0
          if (!hasAny) return (
            <div className="px-3 md:px-6 py-2 border-b border-gray-800 bg-gray-950/40 text-[11px] text-gray-600">
              No open positions on {thisRow.outcome_label}.
            </div>
          )
          return (
            <div className="px-3 md:px-6 py-2 border-b border-gray-800 bg-gray-950/40 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-gray-500 uppercase tracking-wide text-[10px]">Position · {thisRow.outcome_label}:</span>
              <span className="font-mono">
                <span className={net > 0 ? 'text-emerald-400 font-bold' : net < 0 ? 'text-rose-400 font-bold' : 'text-gray-400'}>
                  {net >= 0 ? '+' : ''}{net.toLocaleString()}
                </span>
                <span className="text-gray-500"> net</span>
              </span>
              <span className="text-gray-700">·</span>
              <span className="font-mono">
                <span className="text-emerald-400">{totalLong.toLocaleString()}</span>
                <span className="text-gray-500"> long</span>
              </span>
              <span className="font-mono">
                <span className="text-rose-400">{totalShort.toLocaleString()}</span>
                <span className="text-gray-500"> short</span>
              </span>
              {(pmLong > 0 || pmShort > 0) && (
                <span className="text-gray-600 text-[10px]">
                  PM: +{pmLong.toLocaleString()} / −{pmShort.toLocaleString()}
                </span>
              )}
              {(kLong > 0 || kShort > 0) && (
                <span className="text-gray-600 text-[10px]">
                  Kalshi: +{kLong.toLocaleString()} / −{kShort.toLocaleString()}
                </span>
              )}
            </div>
          )
        })()}

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
                const isFair = fvCents != null && Math.round(px * 100) === fvCents
                // Center column: emphasize what side this price is on.
                // - At best bid: bright green ("you would SELL here, getting filled vs bids")
                // - Bid zone (below best bid): dim green (sell side, deeper)
                // - At best ask: bright red ("you would BUY here, lifting the offer")
                // - Ask zone (above best ask): dim red (buy side, deeper)
                // - Inside spread (between bid and ask): blue, where you might rest a passive order
                // - Model fair: amber halo, overrides above (so you can see edge against book)
                let priceBg = 'bg-gray-900 text-gray-500'
                let priceLabel: string | null = null
                if (isBestBid) { priceBg = 'bg-green-700/70 text-white font-bold'; priceLabel = 'BID' }
                else if (isBestAsk) { priceBg = 'bg-red-700/70 text-white font-bold'; priceLabel = 'OFFER' }
                else if (isInsideSpread) priceBg = 'bg-blue-900/30 text-blue-200'
                else if (isBidZone) priceBg = 'bg-green-900/30 text-green-300'
                else if (isAskZone) priceBg = 'bg-red-900/30 text-red-300'
                if (isFair) {
                  // Amber/yellow takes priority — the fair-value highlight
                  priceBg = `bg-amber-500/80 text-gray-950 font-bold ring-2 ring-amber-300 ring-inset`
                  priceLabel = thisRow.fv_is_live ? 'LIVE FAIR' : 'FAIR'
                }
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

          {/* Kalshi — combined book across team1 + team2 tickers in team1-YES price space.
              Team1 and team2 tickers are economically identical (1v1 binary), but Kalshi tracks
              them as separate orderbooks. Here we merge:
                BID at $p:  team1.yes_dollars[$p]   + team2.no_dollars[$p]      (people buying team1)
                ASK at $p:  team1.no_dollars[$(1−p)] + team2.yes_dollars[$(1−p)] (people selling team1)
              Both kalshiThis and kalshiOpp come from /api/kalshi-book which has already inverted
              no_dollars → asks at (1−p) in each ticker's YES space. So we map team2-YES space → team1-YES
              by swapping bids/asks and inverting the price (p → 1−p). */}
          {kalshiSide && (() => {
            const t1 = kalshiThis ?? { bids: new Map<number, number>(), asks: new Map<number, number>(), updated: 0 }
            const t2 = kalshiOpp  ?? { bids: new Map<number, number>(), asks: new Map<number, number>(), updated: 0 }
            const bids = new Map<number, number>()
            const asks = new Map<number, number>()
            // Helper: round to 2 decimals to align across both books
            const r2 = (p: number) => Math.round(p * 100) / 100
            // Direct team1 bids and asks
            for (const [p, sz] of t1.bids) { const k = r2(p); bids.set(k, (bids.get(k) ?? 0) + sz) }
            for (const [p, sz] of t1.asks) { const k = r2(p); asks.set(k, (asks.get(k) ?? 0) + sz) }
            // team2 inverts: team2 asks at $q → team1 bids at $(1−q); team2 bids at $q → team1 asks at $(1−q)
            for (const [q, sz] of t2.asks) { const k = r2(1 - q); bids.set(k, (bids.get(k) ?? 0) + sz) }
            for (const [q, sz] of t2.bids) { const k = r2(1 - q); asks.set(k, (asks.get(k) ?? 0) + sz) }
            const k = { bids, asks, updated: Math.max(t1.updated ?? 0, t2.updated ?? 0) }
            // Best bid = highest BID price; best ask = lowest ASK price
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
                  <span className="text-gray-700 normal-case">YES book (sells = synth BUY NO)</span>
                  {hasData && kBest.bb != null && kBest.ba != null && (
                    <span className="ml-auto text-[10px] font-mono normal-case">
                      <span className="text-green-400">{kBest.bb.toFixed(2)}</span>
                      <span className="text-gray-600"> / </span>
                      <span className="text-red-400">{kBest.ba.toFixed(2)}</span>
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-px text-xs bg-gray-800 rounded overflow-hidden">
                  <div className="bg-green-900/40 px-2 py-1.5 text-green-300 text-right font-bold">▼ SELL · BID SIZE</div>
                  <div className="bg-gray-900 px-2 py-1.5 text-center">
                    <span className="text-green-400">BID</span>
                    <span className="text-gray-700 mx-1">/</span>
                    <span className="text-red-400">OFFER</span>
                  </div>
                  <div className="bg-red-900/40 px-2 py-1.5 text-red-300 font-bold">▲ BUY · ASK SIZE</div>
                  {!hasData && (
                    <div className="col-span-3 px-3 py-3 text-gray-600 text-center">loading Kalshi book…</div>
                  )}
                  {hasData && sortedPrices.map(p => {
                    const bs = k.bids.get(p) ?? 0
                    const as_ = k.asks.get(p) ?? 0
                    const isBB = p === kBest.bb
                    const isBA = p === kBest.ba
                    const inside = kBest.bb != null && kBest.ba != null && p > kBest.bb && p < kBest.ba
                    const isFair = fvCents != null && Math.round(p * 100) === fvCents
                    let centerBg = 'bg-gray-900 text-gray-600'
                    let centerLabel: string | null = null
                    if (isBB) centerBg = 'bg-green-700/70 text-white font-bold'
                    else if (isBA) centerBg = 'bg-red-700/70 text-white font-bold'
                    else if (inside) centerBg = 'bg-blue-900/30 text-blue-200'
                    else if (kBest.bb != null && p < kBest.bb) centerBg = 'bg-green-900/20 text-green-400'
                    else if (kBest.ba != null && p > kBest.ba) centerBg = 'bg-red-900/20 text-red-400'
                    if (isFair) {
                      centerBg = 'bg-amber-500/80 text-gray-950 font-bold ring-2 ring-amber-300 ring-inset'
                      centerLabel = thisRow.fv_is_live ? 'LIVE' : 'FAIR'
                    }
                    return (
                      <Fragment key={p}>
                        <button
                          onClick={() => onClickKalshiBid(p)}
                          disabled={!kalshiSide?.ticker}
                          className={`px-2 py-1 text-right font-mono tabular-nums hover:bg-green-900/40 cursor-pointer disabled:cursor-not-allowed ${bs > 0 ? (isBB ? 'bg-green-900/60 text-green-200' : 'bg-green-900/20 text-green-300') : 'bg-gray-900 text-gray-700'}`}
                          title={`Click → SELL YES ${kalshiSide.team} at ${p.toFixed(2)} (= BUY NO at ${(1-p).toFixed(2)})`}>
                          {bs > 0 ? Math.round(bs).toLocaleString() : ''}
                        </button>
                        <div className={`px-2 py-1 text-center font-mono ${centerBg}`}>
                          <span>{p.toFixed(2)}</span>
                          {centerLabel && <span className="ml-1 text-[9px] uppercase tracking-wider opacity-80">{centerLabel}</span>}
                        </div>
                        <button
                          onClick={() => onClickKalshiAsk(p)}
                          disabled={!kalshiSide?.ticker}
                          className={`px-2 py-1 text-left font-mono tabular-nums hover:bg-red-900/40 cursor-pointer disabled:cursor-not-allowed ${as_ > 0 ? (isBA ? 'bg-red-900/60 text-red-200' : 'bg-red-900/20 text-red-300') : 'bg-gray-900 text-gray-700'}`}
                          title={`Click → BUY YES ${kalshiSide.team} at ${p.toFixed(2)}`}>
                          {as_ > 0 ? Math.round(as_).toLocaleString() : ''}
                        </button>
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

      // Settled-event detection: a match is "stale" if either
      //  (a) the event date is already >18h in the past (LoL Bo5 maxes ~5h), OR
      //  (b) its match_winner submarket's last trade is pinned near 0/1 AND the
      //      last trade is >1h old (resolved markets stop trading).
      // Polymarket-resolved markets don't always pin at 1.00 — they often sit
      // at ~0.93-0.98 since there's no incentive to trade once resolved, so
      // 0.90 is a more reliable threshold than 0.95 or 0.99.
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
        if (p != null && (p >= 0.90 || p <= 0.10) && ts != null && nowSec - ts > 3600) {
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
      const STALE_AGE_HOURS = 18
      const merged: Prediction[] = [...predRows, ...pmbBySlug.values()]
        .filter(e => {
          // Drop if match_winner is resolved (price pinned + last trade > 1h ago)
          if (e.poly_event_slug && settledSlugs.has(e.poly_event_slug)) return false
          // Drop if event started > 18h ago — safe upper bound on Bo5 duration
          if (e.date) {
            const ageH = (Date.now() - new Date(e.date).getTime()) / 3600_000
            if (ageH > STALE_AGE_HOURS) return false
          }
          return true
        })
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

  // Positions: initial pull + SSE-driven optimistic updates + slow safety poll.
  //
  // Polymarket's /positions REST endpoint (the data-api) lags fills by 30-60s.
  // That's not network — it's their server. So even if we re-fetch instantly
  // on a fill SSE, the response is stale.
  //
  // We side-step the lag by applying the SSE payload as an OPTIMISTIC LOCAL
  // delta to the positions state. The next safety-net fetch reconciles.
  //
  // SSE event shape: { transaction_hash, market, asset, side ('BUY'|'SELL'),
  //                    price, size, outcome, order_ids[], ts }
  useEffect(() => {
    if (!relaySecret) { setPositions([]); return }
    let cancelled = false
    async function pull() {
      const ps = await fetchPositions(relaySecret!)
      if (!cancelled) setPositions(ps)
    }
    pull()
    // Dedupe SSE events by transaction_hash (relay can deliver duplicates if
    // it reconnects mid-stream).
    const seen = new Set<string>()
    const es = new EventSource('/api/trader/user-stream')
    es.onmessage = (ev) => {
      let fill: { asset?: string; side?: string; size?: number | string; price?: number | string; transaction_hash?: string; outcome?: string; title?: string } | null = null
      try { fill = JSON.parse(ev.data) } catch { /* ignore parse errors */ }
      if (!fill) { pull(); return }
      const tx = fill.transaction_hash
      if (tx && seen.has(tx)) return
      if (tx) seen.add(tx)
      const asset = fill.asset
      const sz = typeof fill.size === 'string' ? parseFloat(fill.size) : (fill.size ?? 0)
      const px = typeof fill.price === 'string' ? parseFloat(fill.price) : (fill.price ?? 0)
      const side = (fill.side ?? '').toUpperCase()
      if (asset && Number.isFinite(sz) && sz > 0 && (side === 'BUY' || side === 'SELL')) {
        const delta = side === 'BUY' ? sz : -sz
        setPositions(prev => {
          const idx = prev.findIndex(p => (p.asset ?? p.tokenId ?? p.token_id) === asset)
          if (idx < 0) {
            if (delta <= 0) return prev   // selling nothing — wait for fetch to reconcile
            return [...prev, {
              asset, size: delta, avgPrice: px,
              outcome: fill.outcome, title: fill.title,
            }]
          }
          const next = [...prev]
          const cur  = next[idx]
          const curSize = typeof cur.size === 'string' ? parseFloat(cur.size) : (cur.size ?? 0)
          const newSize = curSize + delta
          if (Math.abs(newSize) < 0.0001) {
            next.splice(idx, 1)
          } else {
            // For BUY: blended avg = (cur*avgPrice + delta*px) / newSize (only positive deltas)
            const curAvg = typeof cur.avgPrice === 'string' ? parseFloat(cur.avgPrice) : (cur.avgPrice ?? px)
            const newAvg = delta > 0 && curSize > 0
              ? (curSize * curAvg + delta * px) / newSize
              : curAvg
            next[idx] = { ...cur, size: newSize, avgPrice: newAvg }
          }
          return next
        })
      }
      // Still trigger a reconcile fetch in the background so other fields
      // (currentValue, pnl) eventually become accurate. The lag is fine —
      // the visible size/avgPrice that drives the UI was already updated.
      pull()
    }
    es.onerror = () => { /* EventSource auto-reconnects */ }
    // Safety-net poll (30s) in case SSE silently disconnects
    const safety = setInterval(pull, 30_000)
    return () => {
      cancelled = true
      es.close()
      clearInterval(safety)
    }
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
              openLadderTokenId={ladderPlan?.thisRow.token_id ?? null}
              onLadderRefresh={(thisRow, oppositeRow) => {
                // Keep modal open; just swap in updated row data so the
                // amber FAIR row in the ladder tracks live model updates.
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
          polyPositions={positions}
          onOrderFired={() => {
            // Instant-refresh PM positions (relay → Polymarket data-api).
            // data-api can lag 30-60s but this at least cuts the visible delay
            // from "up to 5s + lag" to "lag only".
            if (relaySecret) fetchPositions(relaySecret).then(ps => setPositions(ps))
          }}
          onClose={() => setLadderPlan(null)}
        />
      )}
    </div>
  )
}
