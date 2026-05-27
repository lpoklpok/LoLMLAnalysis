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
 * P(team wins best-of-{bestOf} series by at least `spread+0.5` games), given
 * a constant per-game probability `p` for that team. Closed-form negative
 * binomial: series ends when first team reaches k = ceil(bo/2) wins, so a
 * cover-by-N occurs when team1 wins AND team2's wins ≤ k - N.
 */
function coverProb(p: number, bestOf: number, coverBy: number): number {
  const k = Math.ceil(bestOf / 2)
  const maxOppWins = k - coverBy
  if (maxOppWins < 0) return 0  // can't cover (e.g. -3.5 in Bo3)
  if (maxOppWins >= k) return 1 // 0 spread = just P(win series)
  let total = 0
  function nCr(n: number, r: number): number {
    if (r < 0 || r > n) return 0
    let c = 1
    for (let i = 0; i < r; i++) c = c * (n - i) / (i + 1)
    return c
  }
  for (let j = 0; j <= maxOppWins; j++) {
    total += nCr(k - 1 + j, j) * Math.pow(p, k) * Math.pow(1 - p, j)
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

  // Per-market local toggles + sizes (not yet wired to quoter — see notes)
  const [marketEnabled, setMarketEnabled] = useState<Record<string, boolean>>({}) // key = `${slug}|${market_type}|${outcome_idx}`
  const [maxSizeUsd, setMaxSizeUsd]       = useState(25)
  const [edgeThreshold, setEdgeThreshold] = useState(3)

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
  }, [selectedSlug])

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
        <nav className="flex gap-5 text-sm">
          <Link href="/"       className="text-gray-400 hover:text-gray-200">Home</Link>
          <Link href="/trader" className="text-gray-400 hover:text-gray-200">Trader (Live)</Link>
          <Link href="/calculator" className="text-gray-400 hover:text-gray-200">Calculator</Link>
        </nav>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {!params && <p className="text-gray-400 text-sm">Loading model params…</p>}

        {/* Event picker */}
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
          <p className="text-[11px] text-gray-600 mt-2">{events.filter(e=>e.has_pregame).length} upcoming · {events.length - events.filter(e=>e.has_pregame).length} live or settled</p>
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
                  <h2 className="text-sm font-semibold text-gray-300">Submarkets — model vs market</h2>
                  <div className="flex gap-3 items-center text-xs text-gray-500">
                    <label>Default size: <span className="text-emerald-300 font-mono">${maxSizeUsd}</span></label>
                    <input type="range" min={5} max={500} step={5} value={maxSizeUsd}
                           onChange={e => setMaxSizeUsd(parseInt(e.target.value))} className="accent-emerald-500" />
                    <label>Edge ≥ <span className="text-emerald-300 font-mono">{edgeThreshold}pp</span></label>
                    <input type="range" min={1} max={10} step={0.5} value={edgeThreshold}
                           onChange={e => setEdgeThreshold(parseFloat(e.target.value))} className="accent-emerald-500" />
                  </div>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-800">
                      <th className="text-left  px-2 py-2">Market</th>
                      <th className="text-left  px-2 py-2">Favored outcome</th>
                      <th className="text-right px-2 py-2">Fair (model)</th>
                      <th className="text-right px-2 py-2">Market mid</th>
                      <th className="text-right px-2 py-2">Edge</th>
                      <th className="text-right px-2 py-2">Bid/Ask</th>
                      <th className="text-center px-2 py-2">Quote?</th>
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
                          // Favorite per the question
                          const favIdx = matchOutcome(sm.outcomes, h.favName)
                          if (favIdx !== null) {
                            const favIsT1 = (favIdx === 0) === o1IsT1
                            const pFav    = favIsT1 ? probs.g1 : 1 - probs.g1
                            const coverBy = Math.ceil(h.spread)   // 1.5 → cover by 2, 2.5 → cover by 3
                            const favFair = coverProb(pFav, bo, coverBy)
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
                      const key = `${selectedEvent.slug}|${sm.market_type}|${favIdx}`
                      const enabled = marketEnabled[key] ?? aboveThresh

                      return (
                        <tr key={smi} className="border-b border-gray-800/40">
                          <td className="px-2 py-2 font-mono text-xs text-gray-400">{label}</td>
                          <td className="px-2 py-2">
                            {fair_o1 != null ? (
                              <span className={favIdx === 0 ? 'text-blue-300' : 'text-red-300'}>{sm.outcomes[favIdx]}</span>
                            ) : <span className="text-gray-600">—</span>}
                          </td>
                          <td className="px-2 py-2 text-right font-mono">{fair_o1 != null ? pct(fairFav) : '—'}</td>
                          <td className="px-2 py-2 text-right font-mono">{Number.isFinite(marketFav) && marketFav > 0 ? pct(marketFav) : '—'}</td>
                          <td className={`px-2 py-2 text-right font-mono ${clrEdge(edge_pp)}`}>
                            {fair_o1 != null ? `${edge_pp >= 0 ? '+' : ''}${edge_pp.toFixed(1)}pp` : '—'}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-xs text-gray-500">
                            {sm.outcome_bids[favIdx] != null ? `${(sm.outcome_bids[favIdx]!*100).toFixed(0)}` : '—'}
                            /
                            {sm.outcome_asks[favIdx] != null ? `${(sm.outcome_asks[favIdx]!*100).toFixed(0)}` : '—'}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox" checked={enabled} disabled={!aboveThresh}
                              onChange={e => setMarketEnabled(s => ({ ...s, [key]: e.target.checked }))}
                              className="accent-emerald-500"
                              title={aboveThresh ? 'Quoter would post here when wired up' : `Edge below ${edgeThreshold}pp threshold`}
                            />
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
    </div>
  )
}
