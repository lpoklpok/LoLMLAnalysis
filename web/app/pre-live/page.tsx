'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

// ── types ──────────────────────────────────────────────────────────────────

interface TeamStats {
  league:       string
  elo:          number | null
  rwr:          number | null
  gd15:         number | null
  outperf:      number | null
  po_adj:       number
  coaching_adj: number
}

interface PlayerH2HEntry { n: number; wins: number }

interface ModelParams {
  generated:  string
  features:   string[]
  fill:       Record<string, number>
  scaler:     { mean: number[]; scale: number[] }
  coef:       number[]
  alpha_g2:   number
  beta_da:    number
  teams:      Record<string, TeamStats>
  rosters:    Record<string, string[]>
  h2h:        Record<string, number>
  player_h2h: Record<string, PlayerH2HEntry>
  player_elos: Record<string, number>
}

interface EventListing {
  slug: string; title: string; team1: string; team2: string
  team1_key: string; team2_key: string
  match_date: string | null; game_start: string | null
  best_of: number | null; tournament: string
  volume: number; liquidity: number; has_pregame: boolean
}

interface Submarket {
  market_type: string
  question: string
  outcomes: [string, string]
  outcome_mids: [number, number]
  outcome_bids: [number | null, number | null]
  outcome_asks: [number | null, number | null]
  token_ids: [string | null, string | null]
  volume: number
}

interface EventDetail {
  slug: string; title: string; team1: string; team2: string
  best_of: number; match_date: string | null
  submarkets: Submarket[]
}

// ── math (mirrors /calculator) ─────────────────────────────────────────────

function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)) }

function _norm(s: string): string {
  return s.toLowerCase()
    .replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}
const TEAM_ALIASES: Record<string,string> = {
  t1academy:'t1esportsacademy', pcific:'pcificesports', ucamesportsclub:'ucamesports',
  senshiesportsclub:'senshiesports', theotterside:'otterside', orbitanonymo:'anonymoesports',
  big:'berlininternationalgaming', furiaesports:'furia', nrgesports:'nrg',
}
function normTeamKey(s: string): string {
  const k = _norm(s)
  return TEAM_ALIASES[k] ?? k
}
function findTeamInParams(params: ModelParams, name: string): string | null {
  if (params.teams[name]) return name
  const target = normTeamKey(name)
  for (const t of Object.keys(params.teams)) {
    if (normTeamKey(t) === target) return t
  }
  return null
}

function getH2H(params: ModelParams, t1: string, t2: string): number {
  const k1 = `${t1}|||${t2}`; const k2 = `${t2}|||${t1}`
  if (params.h2h[k1] !== undefined) return params.h2h[k1]
  if (params.h2h[k2] !== undefined) return 1 - params.h2h[k2]
  return params.fill.h2h_wr ?? 0.5
}

function rawZ(p: ModelParams, t1: string, t2: string, playoffs: boolean, elo1?: number, elo2?: number): number {
  const s1 = p.teams[t1], s2 = p.teams[t2], f = p.fill
  const raw: Record<string, number> = {
    elo_diff:     (elo1 ?? s1.elo ?? 0) - (elo2 ?? s2.elo ?? 0),
    rwr_diff:     s1.rwr !== null && s2.rwr !== null ? s1.rwr - s2.rwr : f.rwr_diff,
    h2h_wr:       getH2H(p, t1, t2),
    playoffs:     playoffs ? 1 : 0,
    gd15_diff:    s1.gd15 !== null && s2.gd15 !== null ? s1.gd15 - s2.gd15 : f.gd15_diff,
    outperf_diff: s1.outperf !== null && s2.outperf !== null ? s1.outperf - s2.outperf : f.outperf_diff,
  }
  let z = 0
  for (let i = 0; i < p.features.length; i++) {
    z += ((raw[p.features[i]] - p.scaler.mean[i]) / p.scaler.scale[i]) * p.coef[i]
  }
  return z
}

interface ProbBundle {
  g1:        number    // model probability team1 wins one game (no side advantage in our model)
  series:    number    // P(team1 wins series) using model_pred + draft swap rules
  g2_t1won:  number
  g2_t2won:  number
}

function computeProbs(params: ModelParams, t1: string, t2: string, playoffs: boolean,
                       elo1: number | undefined, elo2: number | undefined,
                       logitNudge: number, bestOf: number): ProbBundle {
  // Symmetric z by averaging forward/reverse (cancels scaler bias)
  const zBase = (rawZ(params, t1, t2, playoffs, elo1, elo2) - rawZ(params, t2, t1, playoffs, elo2, elo1)) / 2
  const poNet = playoffs ? ((params.teams[t1].po_adj ?? 0) - (params.teams[t2].po_adj ?? 0)) : 0
  const coachingNet = (params.teams[t1].coaching_adj ?? 0) - (params.teams[t2].coaching_adj ?? 0)
  const z = zBase + poNet + coachingNet + logitNudge

  const g1 = sigmoid(z)
  const a  = params.alpha_g2, b = params.beta_da
  const g2_t1won = sigmoid(a * z + b * (-1))   // t1 won G1 → t2 picks blue side in G2
  const g2_t2won = sigmoid(a * z + b * (+1))
  const g3plus   = g1

  function seriesWinProb(needed: number): number {
    function r(t1w: number, t2w: number, prev: 't1'|'t2'|null): number {
      if (t1w === needed) return 1
      if (t2w === needed) return 0
      const gnum = t1w + t2w + 1
      let p: number
      if (gnum === 1) p = g1
      else if (gnum === 2) p = prev === 't1' ? g2_t1won : g2_t2won
      else p = g3plus
      return p * r(t1w + 1, t2w, 't1') + (1 - p) * r(t1w, t2w + 1, 't2')
    }
    return r(0, 0, null)
  }

  const needed = Math.ceil(bestOf / 2)
  return { g1, series: seriesWinProb(needed), g2_t1won, g2_t2won }
}

// ── small UI helpers ───────────────────────────────────────────────────────

function pct(p: number, d = 1): string { return `${(p * 100).toFixed(d)}%` }

/**
 * Enumerate every (team1_wins, team2_wins) terminal state for a Bo(N) series,
 * weighted by probability, using the model's actual per-game probabilities
 * (g1, g2 conditional on G1 winner, and g3+ side-agnostic). Returns an array
 * of {t1, t2, prob}.
 */
function seriesScoreDistribution(
  g1: number, g2_t1won: number, g2_t2won: number, g3plus: number, bestOf: number,
): { t1: number; t2: number; prob: number }[] {
  const k = Math.ceil(bestOf / 2)
  const out: { t1: number; t2: number; prob: number }[] = []
  function walk(t1w: number, t2w: number, prev: 't1' | 't2' | null, prob: number) {
    if (t1w === k || t2w === k) {
      out.push({ t1: t1w, t2: t2w, prob }); return
    }
    const gameNum = t1w + t2w + 1
    let pT1: number
    if (gameNum === 1) pT1 = g1
    else if (gameNum === 2) pT1 = prev === 't1' ? g2_t1won : g2_t2won
    else pT1 = g3plus
    walk(t1w + 1, t2w, 't1', prob * pT1)
    walk(t1w, t2w + 1, 't2', prob * (1 - pT1))
  }
  walk(0, 0, null, 1)
  return out
}

/**
 * P(team wins by at least `coverBy` games) given a full ProbBundle. `which`
 * picks which team's perspective (1 = event's team1, 2 = team2). Uses the
 * exact per-game series-score distribution rather than the constant-p
 * negative binomial — handles the G2 draft swap correctly.
 */
function coverProb(probs: ProbBundle, bestOf: number, coverBy: number,
                    which: 1 | 2): number {
  if (coverBy < 1) return which === 1 ? probs.series : 1 - probs.series
  const dist = seriesScoreDistribution(probs.g1, probs.g2_t1won, probs.g2_t2won, probs.g1, bestOf)
  let total = 0
  for (const { t1, t2, prob } of dist) {
    const margin = which === 1 ? t1 - t2 : t2 - t1
    if (margin >= coverBy) total += prob
  }
  return total
}

/** Parse 'Game Handicap: <A> (-X.5) vs <B> (+X.5)' → {favName, spread}. */
function parseHandicap(question: string): { favName: string; spread: number } | null {
  const m = question.match(/Handicap:\s*(.+?)\s*\(-?(\d+(?:\.\d+)?)\)\s*vs/i)
  if (!m) return null
  return { favName: m[1].trim(), spread: parseFloat(m[2]) }
}

/** Find which outcome index matches a (possibly abbreviated) team name. */
function matchOutcome(outcomes: [string, string], name: string): 0 | 1 | null {
  const n = _norm(name)
  const o0 = _norm(outcomes[0])
  const o1 = _norm(outcomes[1])
  if (o0 === n || o0.startsWith(n) || n.startsWith(o0) || o0.includes(n) || n.includes(o0)) return 0
  if (o1 === n || o1.startsWith(n) || n.startsWith(o1) || o1.includes(n) || n.includes(o1)) return 1
  return null
}

function fmtSigned(v: number, d = 1): string {
  const s = v.toFixed(d); return v >= 0 ? `+${s}` : s
}
function clrEdge(pp: number): string {
  const a = Math.abs(pp)
  if (a >= 5) return 'text-green-300 font-bold'
  if (a >= 3) return 'text-green-400 font-semibold'
  if (a >= 1) return 'text-gray-300'
  return 'text-gray-500'
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/60 rounded p-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-sm font-mono text-gray-100 mt-0.5">{value}</div>
    </div>
  )
}

function TeamPanel({
  params, teamName, teamKey, otherTeamName, customRoster, customElo, side,
}: {
  params: ModelParams; teamName: string; teamKey: string | null
  otherTeamName: string; customRoster: string[]; customElo: number | null
  side: 'left' | 'right'
}) {
  if (!teamKey) {
    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-yellow-400">{teamName}</h3>
        <p className="text-xs text-gray-500 mt-2">Not found in model params — fair value will fall back to averages.</p>
      </div>
    )
  }
  const s = params.teams[teamKey]
  const baseElo = s.elo ?? null
  const color = side === 'left' ? 'text-blue-300' : 'text-red-300'

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-3">
      <h3 className={`text-sm font-semibold ${color}`}>{teamName}</h3>
      <div className="grid grid-cols-3 gap-2">
        <StatCell label="ELO"  value={customElo != null ? customElo.toFixed(0) : (baseElo?.toFixed(0) ?? '—')} />
        <StatCell label="RWR"  value={s.rwr  != null ? pct(s.rwr, 0)         : '—'} />
        <StatCell label="GD15" value={s.gd15 != null ? fmtSigned(s.gd15, 0)  : '—'} />
        <StatCell label="Outperf" value={s.outperf != null ? fmtSigned(s.outperf, 3) : '—'} />
        <StatCell label="PO adj"  value={s.po_adj ? fmtSigned(s.po_adj, 3) : '—'} />
        <StatCell label="Coach adj" value={s.coaching_adj ? fmtSigned(s.coaching_adj, 3) : '—'} />
      </div>
      <div className="text-xs text-gray-500">H2H WR (this team perspective): <span className="text-gray-300 font-mono">{pct(getH2H(params, teamKey, findTeamInParams(params, otherTeamName) ?? otherTeamName))}</span></div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Lineup (player ELOs)</div>
        <div className="space-y-1">
          {(['top','jng','mid','bot','sup'] as const).map((pos, i) => {
            const player = customRoster[i] ?? (params.rosters[teamKey]?.[i] ?? '—')
            const elo    = params.player_elos[player]
            const isSub  = player !== (params.rosters[teamKey]?.[i] ?? '')
            return (
              <div key={pos} className="grid grid-cols-[40px_1fr_auto] gap-2 items-center text-xs">
                <span className="font-mono text-[10px] text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded text-center">
                  {pos.toUpperCase()}
                </span>
                <span className={`truncate ${isSub ? 'text-purple-300' : 'text-gray-200'}`}>{player}</span>
                <span className="font-mono text-xs text-gray-400">{elo != null ? elo.toFixed(0) : '—'}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── page ───────────────────────────────────────────────────────────────────

export default function PreLivePage() {
  const [params, setParams]       = useState<ModelParams | null>(null)
  const [events, setEvents]       = useState<EventListing[]>([])
  const [selectedSlug, setSlug]   = useState<string | null>(null)
  const [detail, setDetail]       = useState<EventDetail | null>(null)
  const [error, setError]         = useState<string | null>(null)

  // Adjustments per event (keyed by slug)
  const [subs, setSubs] = useState<Record<string, { blue: string[]; red: string[] }>>({})
  const [logitNudge, setLogitNudge] = useState<Record<string, number>>({})

  // Active quotes across ALL events. Rendered as the primary view at the top
  // of the page; event-detail panels become a drill-down.
  interface ActiveRow {
    event_slug: string; event_title: string | null; match_question: string | null
    market_type: string; outcome_idx: number; outcome_name: string | null
    enabled: boolean; max_size_usd: number; edge_threshold_pp: number
    target_fair: number | null; token_id: string | null
    updated_at: string
  }
  const [activeRows, setActiveRows] = useState<ActiveRow[]>([])
  const [liveOrders, setLiveOrders] = useState<Record<string, unknown>[]>([])  // from relay /orders
  const [maxSizeUsd, setMaxSizeUsd]       = useState(25)
  const [edgeThreshold, setEdgeThreshold] = useState(3)
  const [submitting, setSubmitting]       = useState(false)
  const activeKey = (slug: string, mt: string, idx: number) => `${slug}|${mt}|${idx}`

  // Map keyed by composite key for fast lookup from the per-event detail table.
  const activeQuotes = useMemo(() => {
    const m: Record<string, { enabled: boolean; max_size_usd: number; edge_threshold_pp: number }> = {}
    for (const r of activeRows) {
      m[activeKey(r.event_slug, r.market_type, r.outcome_idx)] = {
        enabled: r.enabled, max_size_usd: r.max_size_usd, edge_threshold_pp: r.edge_threshold_pp,
      }
    }
    return m
  }, [activeRows])

  async function reloadActive() {
    try {
      // No slug filter → all rows across all events
      const r = await fetch(`/api/quoter/active`, { cache: 'no-store' })
      const j = await r.json()
      setActiveRows((j.rows ?? []) as ActiveRow[])
    } catch (e) { console.warn('reload active failed', e) }
    // Also refresh live order state
    try {
      const r = await fetch(`/api/quoter/orders`, { cache: 'no-store' })
      const j = await r.json()
      setLiveOrders(((j.orders ?? []) as Record<string, unknown>[]))
    } catch { /* relay might be unavailable; soft-fail */ }
  }
  // Initial + on event change (the toggle handlers also call reload)
  useEffect(() => { reloadActive() }, [selectedSlug])
  // Periodic refresh while page is open
  useEffect(() => {
    const t = setInterval(() => reloadActive(), 15_000)
    return () => clearInterval(t)
  }, [])

  // Compute eligible quote rows for ONE event (used by per-event bulk button
  // AND the global "quote all events" sweep). Pulls /api/trader-event, walks
  // every submarket, computes fair via the same logic as the table.
  async function computeEligibleRowsForEvent(ev: EventListing): Promise<{
    market_type: string; outcome_idx: 0|1; enabled: boolean;
    outcome_name?: string; match_question?: string;
    target_fair?: number; token_id?: string; event_slug: string; event_title: string;
  }[]> {
    if (!params) return []
    const tk1 = findTeamInParams(params, ev.team1)
    const tk2 = findTeamInParams(params, ev.team2)
    if (!tk1 || !tk2) return []
    // Pull this event's overrides so the sweep respects saved subs/nudge
    let blueRoster: string[] | null = null
    let redRoster:  string[] | null = null
    let nudge_ev   = 0
    try {
      const or = await fetch(`/api/quoter/event-overrides?slug=${encodeURIComponent(ev.slug)}`, { cache: 'no-store' })
      const oj = await or.json()
      if (oj.row) {
        blueRoster = (oj.row.blue_roster ?? null) as string[] | null
        redRoster  = (oj.row.red_roster  ?? null) as string[] | null
        nudge_ev   = typeof oj.row.logit_nudge === 'number' ? oj.row.logit_nudge : 0
      }
    } catch { /* fine, use base */ }
    const elo1 = blueRoster && blueRoster.length === 5
      ? Math.round(blueRoster.map(p => params.player_elos[p] ?? (params.teams[tk1]?.elo ?? 1500)).reduce((a,b)=>a+b,0) / 5 * 10)/10
      : undefined
    const elo2 = redRoster && redRoster.length === 5
      ? Math.round(redRoster.map(p => params.player_elos[p] ?? (params.teams[tk2]?.elo ?? 1500)).reduce((a,b)=>a+b,0) / 5 * 10)/10
      : undefined
    const bo = ev.best_of ?? 5
    const evProbs = computeProbs(params, tk1, tk2, false, elo1, elo2, nudge_ev, bo)

    let evDetail: EventDetail | null = null
    try {
      const dr = await fetch(`/api/trader-event?slug=${encodeURIComponent(ev.slug)}`, { cache: 'no-store' })
      if (dr.ok) evDetail = await dr.json()
    } catch { /* skip event */ }
    if (!evDetail) return []

    const out: Awaited<ReturnType<typeof computeEligibleRowsForEvent>> = []
    for (const sm of evDetail.submarkets) {
      const mid1 = sm.outcome_mids[0]; const mid2 = sm.outcome_mids[1]
      const o1IsT1 = _norm(sm.outcomes[0]) === _norm(ev.team1)
      const lab = sm.market_type
      let fair_o1: number | null = null
      if (lab === 'match_winner') fair_o1 = o1IsT1 ? evProbs.series : 1 - evProbs.series
      else if (lab === 'game_handicap') {
        const h = parseHandicap(sm.question)
        if (h) {
          const fIdx = matchOutcome(sm.outcomes, h.favName)
          if (fIdx !== null) {
            const favIsT1 = (fIdx === 0) === o1IsT1
            const cv = coverProb(evProbs, bo, Math.ceil(h.spread), favIsT1 ? 1 : 2)
            fair_o1 = fIdx === 0 ? cv : 1 - cv
          }
        }
      } else if (lab.startsWith('game_')) {
        fair_o1 = o1IsT1 ? evProbs.g1 : 1 - evProbs.g1
      }
      if (fair_o1 == null) continue
      const fair_o2 = 1 - fair_o1
      const e1 = fair_o1 - mid1; const e2 = fair_o2 - mid2
      const fIdx: 0 | 1 = e1 >= e2 ? 0 : 1
      const ePP = Math.abs(fIdx === 0 ? e1 : e2) * 100
      if (ePP < edgeThreshold) continue
      const tgt = fIdx === 0 ? fair_o1 : fair_o2
      out.push({
        event_slug: ev.slug, event_title: ev.title,
        market_type: sm.market_type, outcome_idx: fIdx, enabled: true,
        outcome_name: sm.outcomes[fIdx], match_question: sm.question,
        target_fair: tgt, token_id: sm.token_ids[fIdx] ?? undefined,
      })
    }
    return out
  }

  async function toggleQuote(args: {
    market_type: string; outcome_idx: 0 | 1; enabled: boolean
    outcome_name?: string; match_question?: string
    target_fair?: number | null; token_id?: string | null
  }) {
    if (!selectedSlug || !selectedEvent) return
    setSubmitting(true)
    try {
      await fetch('/api/quoter/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_slug: selectedSlug,
          event_title: selectedEvent.title,
          market_type: args.market_type,
          outcome_idx: args.outcome_idx,
          outcome_name: args.outcome_name,
          match_question: args.match_question,
          enabled: args.enabled,
          max_size_usd: maxSizeUsd,
          edge_threshold_pp: edgeThreshold,
          target_fair: args.target_fair,
          token_id: args.token_id,
        }),
      })
      await reloadActive()
    } catch (e) { console.warn(e) }
    setSubmitting(false)
  }

  useEffect(() => {
    Promise.all([
      fetch('/model_params.json').then(r => r.json()),
      fetch('/api/pre-live-events').then(r => r.json()),
    ]).then(([mp, ev]) => {
      setParams(mp as ModelParams)
      setEvents((ev.events ?? []) as EventListing[])
      // Auto-select first upcoming event
      const first = ((ev.events ?? []) as EventListing[]).find(e => e.has_pregame)
      if (first) setSlug(first.slug)
    }).catch(e => setError(String(e)))
  }, [])

  useEffect(() => {
    if (!selectedSlug) { setDetail(null); return }
    setDetail(null)
    fetch(`/api/trader-event?slug=${encodeURIComponent(selectedSlug)}`)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setDetail)
      .catch(e => setError(`trader-event: ${e}`))
    // Load saved overrides for this event (roster subs + logit nudge)
    fetch(`/api/quoter/event-overrides?slug=${encodeURIComponent(selectedSlug)}`)
      .then(r => r.ok ? r.json() : { row: null })
      .then(j => {
        if (!j.row) return
        const o = j.row
        if (o.blue_roster || o.red_roster) {
          setSubs(s => ({ ...s, [selectedSlug]: {
            blue: (o.blue_roster ?? []) as string[],
            red:  (o.red_roster  ?? []) as string[],
          }}))
        }
        if (typeof o.logit_nudge === 'number') {
          setLogitNudge(s => ({ ...s, [selectedSlug]: o.logit_nudge }))
        }
      })
      .catch(() => { /* no-op */ })
  }, [selectedSlug])

  // Debounced save of overrides whenever subs or nudge change for the selected event
  useEffect(() => {
    if (!selectedSlug) return
    const t = setTimeout(() => {
      fetch('/api/quoter/event-overrides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_slug:  selectedSlug,
          blue_roster: subs[selectedSlug]?.blue ?? null,
          red_roster:  subs[selectedSlug]?.red  ?? null,
          logit_nudge: logitNudge[selectedSlug] ?? 0,
        }),
      }).catch(() => { /* no-op */ })
    }, 600)
    return () => clearTimeout(t)
  }, [selectedSlug, subs, logitNudge])

  const selectedEvent = useMemo(
    () => events.find(e => e.slug === selectedSlug) ?? null,
    [events, selectedSlug],
  )

  const teamKey1 = useMemo(
    () => params && selectedEvent ? findTeamInParams(params, selectedEvent.team1) : null,
    [params, selectedEvent],
  )
  const teamKey2 = useMemo(
    () => params && selectedEvent ? findTeamInParams(params, selectedEvent.team2) : null,
    [params, selectedEvent],
  )

  // Roster state per event
  const blueRoster = useMemo(() => {
    if (!params || !teamKey1 || !selectedSlug) return [] as string[]
    return subs[selectedSlug]?.blue ?? params.rosters[teamKey1] ?? []
  }, [params, teamKey1, selectedSlug, subs])
  const redRoster = useMemo(() => {
    if (!params || !teamKey2 || !selectedSlug) return [] as string[]
    return subs[selectedSlug]?.red ?? params.rosters[teamKey2] ?? []
  }, [params, teamKey2, selectedSlug, subs])

  const customElo1 = useMemo(() => {
    if (!params || !teamKey1 || blueRoster.length < 5) return null
    const fb = params.teams[teamKey1]?.elo ?? 1500
    return Math.round(blueRoster.map(p => params.player_elos[p] ?? fb).reduce((a, b) => a + b, 0) / 5 * 10) / 10
  }, [params, teamKey1, blueRoster])
  const customElo2 = useMemo(() => {
    if (!params || !teamKey2 || redRoster.length < 5) return null
    const fb = params.teams[teamKey2]?.elo ?? 1500
    return Math.round(redRoster.map(p => params.player_elos[p] ?? fb).reduce((a, b) => a + b, 0) / 5 * 10) / 10
  }, [params, teamKey2, redRoster])

  const nudge = selectedSlug ? (logitNudge[selectedSlug] ?? 0) : 0

  const probs = useMemo<ProbBundle | null>(() => {
    if (!params || !teamKey1 || !teamKey2 || !selectedEvent) return null
    const bestOf = selectedEvent.best_of ?? 5
    return computeProbs(params, teamKey1, teamKey2, false,
                         customElo1 ?? undefined, customElo2 ?? undefined,
                         nudge, bestOf)
  }, [params, teamKey1, teamKey2, selectedEvent, customElo1, customElo2, nudge])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-emerald-400">Pre-Live Trader</h1>
          <p className="text-xs text-gray-500 mt-1">Compare model fair value vs Polymarket mid for upcoming LoL series · tweak inputs · see where to bet</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            disabled={submitting}
            onClick={async () => {
              if (!confirm(
                'PANIC: cancel EVERY Polymarket order on your wallet and disable all quoter rows.\n\n' +
                'This kills BOTH:\n' +
                '  • all dashboard-enabled quoter orders\n' +
                '  • any orders you placed manually (Tinker, Polymarket UI, etc.)\n\n' +
                'Continue?'
              )) return
              setSubmitting(true)
              try {
                const r = await fetch('/api/quoter/panic', { method: 'POST' })
                const j = await r.json()
                if (j.ok) {
                  alert(`Cancelled. Disabled ${j.disabled} quoter row(s).`)
                } else {
                  alert(`Partial panic — quoter rows disabled (${j.disabled}). Relay error: ${j.cancel_error}`)
                }
                await reloadActive()
              } catch (e) {
                alert(`Panic failed: ${e}`)
              }
              setSubmitting(false)
            }}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-bold px-4 py-2 rounded text-sm shadow-lg shadow-red-900/50"
            title="Cancel ALL orders (quoter + manual) and disable all quoter rows"
          >
            🚨 PANIC: KILL ALL
          </button>
          <nav className="flex gap-5 text-sm">
            <Link href="/"       className="text-gray-400 hover:text-gray-200">Home</Link>
            <Link href="/trader" className="text-gray-400 hover:text-gray-200">Trader (Live)</Link>
            <Link href="/calculator" className="text-gray-400 hover:text-gray-200">Calculator</Link>
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {!params && <p className="text-gray-400 text-sm">Loading model params…</p>}

        {/* MAIN: active quotes across all events */}
        <div className="bg-gray-900 rounded-xl border-2 border-emerald-900/50 p-4">
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-lg font-bold text-emerald-300">
              Active Quotes
              <span className="text-sm text-gray-500 ml-3 font-normal">
                {activeRows.filter(r => r.enabled).length} enabled · {liveOrders.length} live on Polymarket
              </span>
            </h2>
            <div className="flex gap-2 text-xs">
              <button
                disabled={submitting || activeRows.filter(r => r.enabled).length === 0}
                onClick={async () => {
                  if (!confirm(`Disable all ${activeRows.filter(r => r.enabled).length} active quoter rows? (Won't kill resting orders — the quoter will cancel them on its next tick)`)) return
                  setSubmitting(true)
                  const rows = activeRows.filter(r => r.enabled).map(r => ({
                    event_slug: r.event_slug, market_type: r.market_type,
                    outcome_idx: r.outcome_idx as 0|1, enabled: false,
                  }))
                  await fetch('/api/quoter/toggle', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows }),
                  })
                  await reloadActive()
                  setSubmitting(false)
                }}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-30 text-gray-200 px-3 py-1.5 rounded"
              >Disable all</button>
              <button
                onClick={reloadActive}
                className="bg-gray-800 hover:bg-gray-700 text-gray-400 px-3 py-1.5 rounded"
              >↻ Refresh</button>
            </div>
          </div>

          {activeRows.filter(r => r.enabled).length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              No active quotes. Use the event picker below + toggle markets, or click <span className="text-emerald-400">⚡⚡ Quote ALL events</span> for a sweep.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-800">
                    <th className="text-left px-2 py-2">Event</th>
                    <th className="text-left px-2 py-2">Market</th>
                    <th className="text-left px-2 py-2">Buy outcome</th>
                    <th className="text-right px-2 py-2">Target fair</th>
                    <th className="text-right px-2 py-2">Size</th>
                    <th className="text-right px-2 py-2">Edge ≥</th>
                    <th className="text-center px-2 py-2">Live order</th>
                    <th className="text-center px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeRows.filter(r => r.enabled).map(r => {
                    // Match against live orders from the relay by token_id
                    const live = liveOrders.find(o =>
                      String((o as Record<string, unknown>).asset_id ?? (o as Record<string, unknown>).asset ?? '') === String(r.token_id ?? '')
                    ) as Record<string, unknown> | undefined
                    const k = activeKey(r.event_slug, r.market_type, r.outcome_idx)
                    return (
                      <tr key={k} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                        <td className="px-2 py-2">
                          <button onClick={() => setSlug(r.event_slug)}
                                  className="text-emerald-300 hover:text-emerald-200 hover:underline text-left">
                            {r.event_title ?? r.event_slug}
                          </button>
                        </td>
                        <td className="px-2 py-2 font-mono text-gray-400">{r.market_type}</td>
                        <td className="px-2 py-2">{r.outcome_name ?? `outcome ${r.outcome_idx}`}</td>
                        <td className="px-2 py-2 text-right font-mono text-blue-300">
                          {r.target_fair != null ? pct(r.target_fair) : '—'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">${r.max_size_usd}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-400">{r.edge_threshold_pp}pp</td>
                        <td className="px-2 py-2 text-center text-[11px]">
                          {live ? (
                            <span className="bg-emerald-900/60 text-emerald-300 px-2 py-0.5 rounded">
                              ${(Number(live.price ?? 0)).toFixed(3)} × {Number(live.size_remaining ?? live.original_size ?? 0).toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-gray-600">queued</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <button
                            disabled={submitting}
                            onClick={async () => {
                              setSubmitting(true)
                              await fetch('/api/quoter/toggle', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  event_slug: r.event_slug, market_type: r.market_type,
                                  outcome_idx: r.outcome_idx, enabled: false,
                                }),
                              })
                              await reloadActive()
                              setSubmitting(false)
                            }}
                            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-30"
                          >✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Drilldown header */}
        <details className="bg-gray-900 rounded-xl border border-gray-800 open:bg-gray-900" open>
          <summary className="cursor-pointer text-sm text-gray-300 font-medium px-4 py-3 hover:text-gray-100">
            🔍 Inspect / change an event — pick event, view stats, edit rosters, see per-market edges
          </summary>
          <div className="px-4 pb-4 pt-2 space-y-5">
        {/* (drilldown content nests below — closed at end of selectedEvent block) */}

        {/* Event picker + global sweep */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <label className="block text-xs text-gray-500 mb-2">Pre-game events (sorted by start time)</label>
          <select
            value={selectedSlug ?? ''}
            onChange={e => setSlug(e.target.value || null)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="">— pick a series —</option>
            {events.filter(e => e.has_pregame).map(e => (
              <option key={e.slug} value={e.slug}>
                {e.title} {e.game_start ? `· ${new Date(e.game_start).toLocaleString()}` : ''}
              </option>
            ))}
          </select>
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <p className="text-[11px] text-gray-600">{events.filter(e=>e.has_pregame).length} upcoming · {events.length - events.filter(e=>e.has_pregame).length} live or settled</p>
            <button
              disabled={submitting || events.filter(e=>e.has_pregame).length === 0}
              onClick={async () => {
                if (!params) return
                const upcoming = events.filter(e => e.has_pregame)
                if (!confirm(`Sweep ALL ${upcoming.length} upcoming events and enable every market with edge ≥ ${edgeThreshold}pp at $${maxSizeUsd} size?`)) return
                setSubmitting(true)
                try {
                  // Parallel: kick off all event computations at once. Each
                  // computeEligibleRowsForEvent already does its own fetches
                  // and try/catches; failures yield [] rather than throw.
                  const t0 = Date.now()
                  const results = await Promise.all(upcoming.map(ev => computeEligibleRowsForEvent(ev)))
                  const all = results.flat()
                  const elapsed = ((Date.now() - t0)/1000).toFixed(1)
                  if (all.length === 0) {
                    alert(`No eligible markets found across ${upcoming.length} events (took ${elapsed}s).`)
                    setSubmitting(false); return
                  }
                  // Bulk upsert in one call
                  const r = await fetch('/api/quoter/toggle', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      rows: all.map(row => ({ ...row, max_size_usd: maxSizeUsd, edge_threshold_pp: edgeThreshold })),
                    }),
                  })
                  if (!r.ok) {
                    alert(`Sweep failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`)
                    setSubmitting(false); return
                  }
                  const respBody = await r.json()
                  alert(`Enabled ${respBody.updated ?? all.length} quotes across ${new Set(all.map(x=>x.event_slug)).size} events. (computed in ${elapsed}s)`)
                  await reloadActive()
                } catch (e) {
                  alert(`Sweep failed: ${e}`)
                }
                setSubmitting(false)
              }}
              className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded"
            >
              ⚡⚡ Quote ALL events (≥{edgeThreshold}pp · ${maxSizeUsd}/quote)
            </button>
          </div>
        </div>

        {params && selectedEvent && (
          <>
            {/* Team panels */}
            <div className="grid md:grid-cols-2 gap-4">
              <TeamPanel
                params={params} teamName={selectedEvent.team1} teamKey={teamKey1}
                otherTeamName={selectedEvent.team2} customRoster={blueRoster}
                customElo={customElo1} side="left"
              />
              <TeamPanel
                params={params} teamName={selectedEvent.team2} teamKey={teamKey2}
                otherTeamName={selectedEvent.team1} customRoster={redRoster}
                customElo={customElo2} side="right"
              />
            </div>

            {/* Substitutions + logit nudge */}
            <details className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3 open:pb-5">
              <summary className="cursor-pointer text-sm text-gray-300 font-medium">Adjustments — subs &amp; logit nudge</summary>
              <div className="mt-4 space-y-4">
                <datalist id="player-list">
                  {params && Object.keys(params.player_elos).sort().map(p => <option key={p} value={p} />)}
                </datalist>
                <div className="grid grid-cols-[44px_1fr_1fr] gap-3 items-center">
                  <div />
                  <div className="text-xs font-medium text-blue-400 text-center">{selectedEvent.team1}</div>
                  <div className="text-xs font-medium text-red-400 text-center">{selectedEvent.team2}</div>
                  {(['top','jng','mid','bot','sup'] as const).map((pos, i) => (
                    <div key={pos} className="contents">
                      <span className="text-[10px] font-mono text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded text-center">{pos.toUpperCase()}</span>
                      <input
                        list="player-list"
                        value={blueRoster[i] ?? ''}
                        onChange={e => {
                          const next = [...blueRoster]; next[i] = e.target.value
                          setSubs(s => ({ ...s, [selectedSlug!]: { blue: next, red: redRoster } }))
                        }}
                        className={`bg-gray-800 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${blueRoster[i] !== (params.rosters[teamKey1!]?.[i] ?? '') ? 'border-blue-600' : 'border-gray-700'}`}
                      />
                      <input
                        list="player-list"
                        value={redRoster[i] ?? ''}
                        onChange={e => {
                          const next = [...redRoster]; next[i] = e.target.value
                          setSubs(s => ({ ...s, [selectedSlug!]: { blue: blueRoster, red: next } }))
                        }}
                        className={`bg-gray-800 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 ${redRoster[i] !== (params.rosters[teamKey2!]?.[i] ?? '') ? 'border-red-600' : 'border-gray-700'}`}
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <label className="text-xs text-gray-500">Logit nudge (positive favors {selectedEvent.team1}): <span className="text-purple-300 font-mono">{fmtSigned(nudge, 2)}</span></label>
                  <input
                    type="range" min={-0.5} max={0.5} step={0.05}
                    value={nudge}
                    onChange={e => setLogitNudge(s => ({ ...s, [selectedSlug!]: parseFloat(e.target.value) }))}
                    className="w-full accent-purple-500 mt-1"
                  />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
                    <span>−0.5 (fade {selectedEvent.team1})</span>
                    <span>0</span>
                    <span>+0.5 (boost {selectedEvent.team1})</span>
                  </div>
                </div>

                <div className="flex gap-3 text-xs">
                  <button
                    onClick={() => setSubs(s => ({ ...s, [selectedSlug!]: { blue: params.rosters[teamKey1!] ?? [], red: params.rosters[teamKey2!] ?? [] } }))}
                    className="text-gray-500 hover:text-gray-300"
                  >Reset rosters</button>
                  <button
                    onClick={() => setLogitNudge(s => ({ ...s, [selectedSlug!]: 0 }))}
                    className="text-gray-500 hover:text-gray-300"
                  >Reset nudge</button>
                </div>
              </div>
            </details>

            {/* Fair value */}
            {probs && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                <h2 className="text-sm font-semibold text-gray-300 mb-3">Model output (no blue-side advantage baked in)</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                  <div className="bg-gray-800/60 rounded p-3">
                    <div className="text-[10px] uppercase text-gray-500">P({selectedEvent.team1} wins game) </div>
                    <div className="text-2xl font-bold text-blue-300 mt-1">{pct(probs.g1)}</div>
                    <div className="text-[10px] text-gray-600 mt-0.5">single-game, side-agnostic</div>
                  </div>
                  <div className="bg-gray-800/60 rounded p-3">
                    <div className="text-[10px] uppercase text-gray-500">P({selectedEvent.team2} wins game)</div>
                    <div className="text-2xl font-bold text-red-300 mt-1">{pct(1 - probs.g1)}</div>
                  </div>
                  <div className="bg-gray-800/60 rounded p-3">
                    <div className="text-[10px] uppercase text-gray-500">P({selectedEvent.team1} wins series)</div>
                    <div className="text-2xl font-bold text-blue-400 mt-1">{pct(probs.series)}</div>
                    <div className="text-[10px] text-gray-600 mt-0.5">Bo{selectedEvent.best_of ?? '?'} · with draft swap</div>
                  </div>
                  <div className="bg-gray-800/60 rounded p-3">
                    <div className="text-[10px] uppercase text-gray-500">P({selectedEvent.team2} wins series)</div>
                    <div className="text-2xl font-bold text-red-400 mt-1">{pct(1 - probs.series)}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Markets */}
            {detail && probs && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
                  <h2 className="text-sm font-semibold text-gray-300">
                    Submarkets — model vs market
                    <span className="text-xs text-gray-500 ml-2">
                      {Object.values(activeQuotes).filter(q => q.enabled).length} active quote(s)
                    </span>
                  </h2>
                  <div className="flex gap-3 items-center text-xs text-gray-500">
                    <label>Size: <span className="text-emerald-300 font-mono">${maxSizeUsd}</span></label>
                    <input type="range" min={5} max={500} step={5} value={maxSizeUsd}
                           onChange={e => setMaxSizeUsd(parseInt(e.target.value))} className="accent-emerald-500" />
                    <label>Edge ≥ <span className="text-emerald-300 font-mono">{edgeThreshold}pp</span></label>
                    <input type="range" min={1} max={10} step={0.5} value={edgeThreshold}
                           onChange={e => setEdgeThreshold(parseFloat(e.target.value))} className="accent-emerald-500" />
                  </div>
                </div>

                {/* Bulk actions */}
                {detail && probs && (
                  <div className="flex gap-2 mb-3 flex-wrap text-xs">
                    <button
                      disabled={submitting}
                      onClick={async () => {
                        if (!selectedEvent) return
                        setSubmitting(true)
                        const rows = await computeEligibleRowsForEvent(selectedEvent)
                        if (rows.length === 0) { alert('No markets above threshold to enable.'); setSubmitting(false); return }
                        await fetch('/api/quoter/toggle', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            rows: rows.map(r => ({ ...r, max_size_usd: maxSizeUsd, edge_threshold_pp: edgeThreshold })),
                          }),
                        })
                        await reloadActive()
                        setSubmitting(false)
                      }}
                      className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-semibold px-3 py-1.5 rounded"
                    >
                      ⚡ Quote all eligible (this event, ≥{edgeThreshold}pp)
                    </button>
                    <button
                      disabled={submitting}
                      onClick={async () => {
                        const active = Object.entries(activeQuotes).filter(([_, v]) => v.enabled)
                        if (active.length === 0) return
                        setSubmitting(true)
                        const rows = active.map(([k]) => {
                          const [eSlug, mt, idx] = k.split('|')
                          return { event_slug: eSlug, market_type: mt, outcome_idx: parseInt(idx) as 0|1, enabled: false }
                        })
                        await fetch('/api/quoter/toggle', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ rows }),
                        })
                        await reloadActive()
                        setSubmitting(false)
                      }}
                      className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 px-3 py-1.5 rounded"
                    >
                      Cancel all quotes
                    </button>
                  </div>
                )}

                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wide border-b border-gray-800">
                      <th rowSpan={2} className="text-left px-2 py-2">Market</th>
                      <th colSpan={5} className="text-left px-2 py-1 border-l border-gray-800 bg-gray-800/30">Outcome 1</th>
                      <th colSpan={5} className="text-left px-2 py-1 border-l border-gray-800 bg-gray-800/30">Outcome 2</th>
                      <th rowSpan={2} className="text-center px-2 py-2 border-l border-gray-800">BUY / Quote</th>
                    </tr>
                    <tr className="text-[10px] text-gray-500 border-b border-gray-800">
                      <th className="text-left  px-2 py-1 border-l border-gray-800">Name</th>
                      <th className="text-right px-2 py-1">Fair</th>
                      <th className="text-right px-2 py-1">Mkt</th>
                      <th className="text-right px-2 py-1">Edge</th>
                      <th className="text-right px-2 py-1">Bid/Ask</th>
                      <th className="text-left  px-2 py-1 border-l border-gray-800">Name</th>
                      <th className="text-right px-2 py-1">Fair</th>
                      <th className="text-right px-2 py-1">Mkt</th>
                      <th className="text-right px-2 py-1">Edge</th>
                      <th className="text-right px-2 py-1">Bid/Ask</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.submarkets.map((sm, smi) => {
                      const label  = sm.market_type
                      const mid1   = sm.outcome_mids[0]
                      const mid2   = sm.outcome_mids[1]
                      const o1IsT1 = _norm(sm.outcomes[0]) === _norm(selectedEvent.team1)
                      const bo     = selectedEvent.best_of ?? 5

                      // Compute fair probability for outcome 0 (fair_o1) and the
                      // "favored" outcome's fair (fairFav). Differs by market type:
                      // - match_winner: probs.series for team1, 1-... for team2
                      // - game_N_winner: side-agnostic single-game prob
                      // - game_handicap: parse spread from question, compute
                      //   negative-binomial cover prob using per-game p.
                      let fair_o1: number | null = null

                      if (label === 'match_winner') {
                        fair_o1 = o1IsT1 ? probs.series : 1 - probs.series
                      } else if (label === 'game_handicap') {
                        const h = parseHandicap(sm.question)
                        if (h) {
                          // Which outcome is the favorite (negative spread)?
                          const favIdx = matchOutcome(sm.outcomes, h.favName)
                          if (favIdx !== null) {
                            // Map outcome favIdx → event-team perspective. If favIdx is the
                            // outcome that matches event.team1, the favorite's "perspective" is team1.
                            const favIsT1 = (favIdx === 0) === o1IsT1
                            const coverBy = Math.ceil(h.spread)
                            const favFair = coverProb(probs, bo, coverBy, favIsT1 ? 1 : 2)
                            fair_o1 = favIdx === 0 ? favFair : 1 - favFair
                          }
                        }
                      } else if (label.startsWith('game_')) {
                        const pT1 = probs.g1
                        fair_o1 = o1IsT1 ? pT1 : 1 - pT1
                      }

                      const fair_o2 = fair_o1 != null ? 1 - fair_o1 : null

                      // Which side has the edge (favored by model)?
                      let favIdx = 0; let edge_pp = 0; let fairFav = 0; let marketFav = 0
                      if (fair_o1 != null && fair_o2 != null) {
                        const edge1 = fair_o1 - mid1
                        const edge2 = fair_o2 - mid2
                        if (edge1 >= edge2) { favIdx = 0; edge_pp = edge1 * 100; fairFav = fair_o1; marketFav = mid1 }
                        else { favIdx = 1; edge_pp = edge2 * 100; fairFav = fair_o2; marketFav = mid2 }
                      }
                      const aboveThresh = Math.abs(edge_pp) >= edgeThreshold
                      const key = activeKey(selectedEvent.slug, sm.market_type, favIdx)
                      const enabled = activeQuotes[key]?.enabled ?? false

                      // Per-outcome edge (signed)
                      const edge1_pp = fair_o1 != null ? (fair_o1 - mid1) * 100 : null
                      const edge2_pp = fair_o2 != null ? (fair_o2 - mid2) * 100 : null

                      // For game_handicap: display the spread alongside the outcome name
                      let label1 = sm.outcomes[0]
                      let label2 = sm.outcomes[1]
                      if (label === 'game_handicap') {
                        const h = parseHandicap(sm.question)
                        if (h) {
                          const favIdxName = matchOutcome(sm.outcomes, h.favName)
                          if (favIdxName === 0) { label1 = `${sm.outcomes[0]} −${h.spread}`; label2 = `${sm.outcomes[1]} +${h.spread}` }
                          if (favIdxName === 1) { label1 = `${sm.outcomes[0]} +${h.spread}`; label2 = `${sm.outcomes[1]} −${h.spread}` }
                        }
                      }

                      const ba = (i: 0 | 1) => {
                        const b = sm.outcome_bids[i]; const a = sm.outcome_asks[i]
                        return (b != null && a != null) ? `${(b*100).toFixed(0)}/${(a*100).toFixed(0)}`
                             : b != null ? `${(b*100).toFixed(0)}/—`
                             : a != null ? `—/${(a*100).toFixed(0)}`
                             : '—'
                      }

                      return (
                        <tr key={smi} className="border-b border-gray-800/40">
                          <td className="px-2 py-2 font-mono text-gray-400">{label}</td>

                          {/* Outcome 1 */}
                          <td className={`px-2 py-2 border-l border-gray-800 ${favIdx === 0 && aboveThresh ? 'bg-emerald-900/15' : ''}`}>
                            <span className="text-blue-300">{label1}</span>
                          </td>
                          <td className="px-2 py-2 text-right font-mono">{fair_o1 != null ? pct(fair_o1) : '—'}</td>
                          <td className="px-2 py-2 text-right font-mono text-gray-400">{Number.isFinite(mid1) && mid1 > 0 ? pct(mid1) : '—'}</td>
                          <td className={`px-2 py-2 text-right font-mono ${edge1_pp != null ? clrEdge(edge1_pp) : ''}`}>
                            {edge1_pp != null ? `${edge1_pp >= 0 ? '+' : ''}${edge1_pp.toFixed(1)}pp` : '—'}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-gray-500">{ba(0)}</td>

                          {/* Outcome 2 */}
                          <td className={`px-2 py-2 border-l border-gray-800 ${favIdx === 1 && aboveThresh ? 'bg-emerald-900/15' : ''}`}>
                            <span className="text-red-300">{label2}</span>
                          </td>
                          <td className="px-2 py-2 text-right font-mono">{fair_o2 != null ? pct(fair_o2) : '—'}</td>
                          <td className="px-2 py-2 text-right font-mono text-gray-400">{Number.isFinite(mid2) && mid2 > 0 ? pct(mid2) : '—'}</td>
                          <td className={`px-2 py-2 text-right font-mono ${edge2_pp != null ? clrEdge(edge2_pp) : ''}`}>
                            {edge2_pp != null ? `${edge2_pp >= 0 ? '+' : ''}${edge2_pp.toFixed(1)}pp` : '—'}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-gray-500">{ba(1)}</td>

                          {/* BUY / Quote */}
                          <td className="px-2 py-2 text-center border-l border-gray-800">
                            {fair_o1 != null ? (
                              <div className="flex items-center justify-center gap-2">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${aboveThresh ? 'bg-emerald-700/40 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}>
                                  BUY {favIdx === 0 ? '◀' : '▶'}
                                </span>
                                <input
                                  type="checkbox" checked={enabled} disabled={submitting}
                                  onChange={e => toggleQuote({
                                    market_type: sm.market_type,
                                    outcome_idx: favIdx as 0 | 1,
                                    enabled: e.target.checked,
                                    outcome_name: sm.outcomes[favIdx],
                                    match_question: sm.question,
                                    target_fair: fairFav,
                                    token_id: sm.token_ids[favIdx] ?? undefined,
                                  })}
                                  className="accent-emerald-500"
                                  title={aboveThresh ? 'Quoter will post a passive BUY at best bid for this side' : `Below ${edgeThreshold}pp — toggle to override`}
                                />
                              </div>
                            ) : (
                              <span className="text-gray-700 text-[10px]">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <p className="text-[11px] text-gray-600 mt-3">
                  Note: per-game/handicap fair values use the side-agnostic single-game probability — they don't yet account for which team plays blue side
                  in that specific game, or for series-score conditional probabilities. Match Winner is the most reliable comparison right now.
                </p>
                <p className="text-[11px] text-gray-600 mt-1">
                  Toggles are local-only. Wiring them to the live quoter (so it actually posts orders when you flip a checkbox) is the next step — let me know when ready.
                </p>
              </div>
            )}
          </>
        )}

        {!selectedEvent && events.length > 0 && (
          <p className="text-gray-500 text-sm">Pick a series above to see fair values + market edges.</p>
        )}
          </div>
        </details>
      </div>
    </div>
  )
}
