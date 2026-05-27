'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

// ===== Types =====
interface TeamStats {
  league:        string | null
  elo:           number | null
  rwr:           number | null
  gd15:          number | null
  outperf:       number | null
  po_adj:        number | null
  coaching_adj:  number | null
}

interface ModelParams {
  features:      string[]
  fill:          Record<string, number>
  scaler:        { mean: number[]; scale: number[] }
  coef:          number[]
  intercept:     number
  alpha_g2:      number
  beta_da:       number
  teams:         Record<string, TeamStats>
  rosters:       Record<string, string[]>
  h2h:           Record<string, number>
  player_h2h:    Record<string, { n: number; wins: number }>
  player_elos:   Record<string, number>
}

interface TeamSnapshot { date: string; elo: number; rwr: number | null; gd15: number | null; roster: string[] }
interface TeamStateHistory {
  generated:   string
  window_days: number
  teams:       Record<string, TeamSnapshot[]>
}

// ===== Math helpers =====
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))
const logit   = (p: number): number => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p))

function getH2H(params: ModelParams, t1: string, t2: string): number {
  if (params.h2h[`${t1}|||${t2}`] !== undefined) return params.h2h[`${t1}|||${t2}`]
  if (params.h2h[`${t2}|||${t1}`] !== undefined) return 1 - params.h2h[`${t2}|||${t1}`]
  return params.fill.h2h_wr ?? 0.5
}

// Build raw feature vector for (t1 perspective, vs t2)
function rawFeatures(
  params: ModelParams,
  t1: string, t2: string,
  s1: { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null },
  s2: { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null },
  playoffs: boolean,
): Record<string, number> {
  const f = params.fill
  return {
    elo_diff:     (s1.elo != null && s2.elo != null) ? s1.elo - s2.elo : f.elo_diff,
    rwr_diff:     (s1.rwr != null && s2.rwr != null) ? s1.rwr - s2.rwr : f.rwr_diff,
    h2h_wr:       getH2H(params, t1, t2),
    playoffs:     playoffs ? 1 : 0,
    gd15_diff:    (s1.gd15 != null && s2.gd15 != null) ? s1.gd15 - s2.gd15 : f.gd15_diff,
    outperf_diff: (s1.outperf != null && s2.outperf != null) ? s1.outperf - s2.outperf : f.outperf_diff,
  }
}

function zFromFeats(params: ModelParams, feats: Record<string, number>, withIntercept: boolean): number {
  let z = withIntercept ? params.intercept : 0
  for (let i = 0; i < params.features.length; i++) {
    const fname = params.features[i]
    const v = feats[fname]
    z += ((v - params.scaler.mean[i]) / params.scaler.scale[i]) * params.coef[i]
  }
  return z
}

// ===== Page =====
type SideMode = 'symmetric' | 'blue_t1' | 'blue_t2'

export default function PredictPage() {
  const [params,  setParams]  = useState<ModelParams | null>(null)
  const [history, setHistory] = useState<TeamStateHistory | null>(null)
  const [err,     setErr]     = useState<string | null>(null)

  const [team1, setTeam1] = useState<string>('Gen.G')
  const [team2, setTeam2] = useState<string>('Hanwha Life Esports')
  const [bestOf,    setBestOf]    = useState<1 | 3 | 5>(3)
  const [sideMode,  setSideMode]  = useState<SideMode>('symmetric')
  const [playoffs,  setPlayoffs]  = useState(false)
  const [g2Shrink,  setG2Shrink]  = useState(true)
  const [poAdj,     setPoAdj]     = useState(true)
  const [coachAdj,  setCoachAdj]  = useState(true)
  // Date toggle: ISO date string ('' = use latest/current model_params snapshot)
  const [asOfDate, setAsOfDate]   = useState<string>('')

  // Roster overrides (per-team, position-indexed array of 5 player names)
  const [rosters, setRosters] = useState<Record<string, string[]>>({})

  // Result injection: per-game blue_won + gd15_diff (blue minus red, in raw gold value)
  // Indexed by 1..5 (game number)
  const [gameResults, setGameResults] = useState<Record<number, { blue_won: boolean | null; gd15_diff: number | null }>>({})

  // Load
  useEffect(() => {
    Promise.all([
      fetch('/model_params.json').then(r => r.json()),
      fetch('/team_state_history.json').then(r => r.json()),
    ]).then(([p, h]) => { setParams(p); setHistory(h) })
    .catch(e => setErr(String(e)))
  }, [])

  // ----- Team list (sorted) -----
  const teamOptions = useMemo<string[]>(() => {
    if (!params) return []
    return Object.keys(params.teams).sort()
  }, [params])

  // ----- "As-of date" team state lookup -----
  // Returns the snapshot whose date is >= asOfDate (i.e., team's next game's BEFORE state).
  // If no snapshot >= D, falls back to the most recent ≤ D.
  function stateAt(team: string, isoDate: string): TeamSnapshot | null {
    const snaps = history?.teams[team] ?? []
    if (snaps.length === 0) return null
    if (!isoDate) return snaps[snaps.length - 1]
    const after = snaps.find(s => s.date >= isoDate)
    if (after) return after
    return snaps[snaps.length - 1]
  }

  // ----- Resolve team state for prediction -----
  // If asOfDate is set: use snapshot (elo/rwr/gd15 from history) + current model_params for outperf
  //                      (outperf rebuild is more involved; gd15 is now in history)
  // Else: use current model_params team stats.
  function teamState(team: string) {
    const cur = params?.teams[team]
    if (asOfDate) {
      const snap = stateAt(team, asOfDate)
      if (snap) return {
        elo:     snap.elo,
        rwr:     snap.rwr,
        gd15:    snap.gd15 ?? cur?.gd15 ?? null,
        outperf: cur?.outperf ?? null,
      }
    }
    return {
      elo:     cur?.elo     ?? null,
      rwr:     cur?.rwr     ?? null,
      gd15:    cur?.gd15    ?? null,
      outperf: cur?.outperf ?? null,
    }
  }

  // ----- Rosters: pick current team rosters (from model_params) unless overridden -----
  function effectiveRoster(team: string): string[] {
    if (rosters[team]) return rosters[team]
    if (asOfDate) {
      const snap = stateAt(team, asOfDate)
      if (snap?.roster?.length === 5) return snap.roster
    }
    return params?.rosters[team] ?? []
  }

  // ----- Team ELO from roster (sum of player_elos) -----
  function rosterElo(roster: string[]): number | null {
    if (!params || roster.length !== 5) return null
    const vals = roster.map(p => params.player_elos[p]).filter((v): v is number => v != null)
    if (vals.length !== 5) return null
    return vals.reduce((a, b) => a + b, 0)
  }

  // ----- Per-game prediction -----
  // Returns P(team1 wins game N), with G2 adjustments applied if game===2.
  // resultsBeforeN: list of {blue_won, gd15} for games 1..N-1 (used for rwr/gd15/elo updates)
  // sideFor(N): which team is blue in game N
  function predictGame(
    n: number,
    sideForN: 'blue_t1' | 'blue_t2' | 'sym',
    resultsBefore: Array<{ blue_won: boolean | null; gd15_diff: number | null; side: 'blue_t1' | 'blue_t2' | 'sym' }>,
  ): number {
    if (!params) return 0.5

    // Apply roster overrides → recompute team elo via sum of player elos if customized.
    // Otherwise use historical / snapshot elo (which already reflects the right rosters).
    const r1 = effectiveRoster(team1)
    const r2 = effectiveRoster(team2)
    const baseS1 = teamState(team1)
    const baseS2 = teamState(team2)
    const e1Override = rosters[team1] ? rosterElo(r1) : null
    const e2Override = rosters[team2] ? rosterElo(r2) : null
    let s1 = { ...baseS1, elo: e1Override ?? baseS1.elo }
    let s2 = { ...baseS2, elo: e2Override ?? baseS2.elo }

    // Apply prior-game adjustments (rwr/gd15/draft_advantage will be computed later).
    // ELO update from prior games: standard logistic K-factor.
    const K_FACTOR = 24
    let draft_advantage = 0
    let prev_blue_won: boolean | null = null
    for (let i = 0; i < resultsBefore.length; i++) {
      const r = resultsBefore[i]
      if (r.blue_won == null) continue
      // Map prev game's "blue won" to team1/team2 win
      const side = r.side
      let t1_won_prev: boolean
      if      (side === 'blue_t1') t1_won_prev = r.blue_won
      else if (side === 'blue_t2') t1_won_prev = !r.blue_won
      else                         t1_won_prev = r.blue_won  // symmetric — assume team1 was nominally blue
      // ELO update
      const expected1 = 1 / (1 + Math.pow(10, ((s2.elo ?? 1500) - (s1.elo ?? 1500)) / 400))
      const score1    = t1_won_prev ? 1 : 0
      const delta     = K_FACTOR * (score1 - expected1)
      s1 = { ...s1, elo: (s1.elo ?? 1500) + delta }
      s2 = { ...s2, elo: (s2.elo ?? 1500) - delta }
      prev_blue_won = r.blue_won
    }

    // Set draft advantage based on previous game's blue winner (for game 2+)
    if (resultsBefore.length > 0 && prev_blue_won != null) {
      // +1 if blue lost prev (blue has draft choice this game), -1 otherwise
      draft_advantage = prev_blue_won ? -1 : 1
    }

    // Build features in t1-perspective
    const feats = rawFeatures(params, team1, team2, s1, s2, playoffs)
    let zT1 = zFromFeats(params, feats, true) // include intercept (we'll strip it for symmetric)

    // Side handling
    if (sideForN === 'sym') {
      // Symmetric: average forward + reverse, no intercept
      const feats_rev = rawFeatures(params, team2, team1, s2, s1, playoffs)
      const zFwd = zFromFeats(params, feats, false)
      const zRev = zFromFeats(params, feats_rev, false)
      zT1 = (zFwd - zRev) / 2
    } else if (sideForN === 'blue_t2') {
      // team2 is blue. The model is trained with t1=blue interpretation.
      // For t2 as blue, we compute as if (team2, team1) order then flip the prob.
      const feats_rev = rawFeatures(params, team2, team1, s2, s1, playoffs)
      const zT2 = zFromFeats(params, feats_rev, true)
      zT1 = -zT2  // P(t1 wins) = 1 - P(t2 wins)
    }
    // else 'blue_t1': use zT1 directly (computed above)

    // Playoff team-PO adjustment + coaching adjustment
    if (playoffs && poAdj) {
      const po1 = params.teams[team1]?.po_adj ?? 0
      const po2 = params.teams[team2]?.po_adj ?? 0
      zT1 += (po1 - po2)
    }
    if (coachAdj) {
      const co1 = params.teams[team1]?.coaching_adj ?? 0
      const co2 = params.teams[team2]?.coaching_adj ?? 0
      zT1 += (co1 - co2)
    }

    // G2 shrink + draft swap (for n==2)
    if (n === 2 && g2Shrink) {
      // Map draft_advantage from "blue perspective" to "t1 perspective"
      // Same logic: BETA_DA term is +1 if blue lost prev game (blue has draft choice).
      // From t1's perspective: if t1 was blue in game1 and t1 lost, blue lost → +1 (t1 has draft).
      // We use the side mapping for game 1.
      let t1_draft_signed = 0
      if (resultsBefore.length >= 1 && prev_blue_won != null) {
        const side1 = resultsBefore[0].side
        const blue_was_t1_in_g1 = side1 === 'blue_t1' || (side1 === 'sym' && true) // sym = treat t1 as blue
        const t1_won_g1 = blue_was_t1_in_g1 ? prev_blue_won : !prev_blue_won
        t1_draft_signed = t1_won_g1 ? -1 : 1  // t1 has draft choice if they lost
      }
      zT1 = params.alpha_g2 * zT1 + params.beta_da * t1_draft_signed
    }

    return sigmoid(zT1)
  }

  // Determine the side for each game given user's chosen side mode.
  // - symmetric: every game uses 'sym' (no side info)
  // - blue_t1: G1 = blue_t1; G2 = blue swaps if G1 had a result (G1 loser plays blue in G2)
  // - blue_t2: G1 = blue_t2; same swap rule
  function sideFor(n: number, g1SideRoot: 'blue_t1' | 'blue_t2' | 'sym',
                    g1Result: boolean | null): 'blue_t1' | 'blue_t2' | 'sym' {
    if (g1SideRoot === 'sym') return 'sym'
    if (n === 1) return g1SideRoot
    if (n === 2) {
      // If G1 result entered: G1 loser plays blue in G2
      if (g1Result == null) return g1SideRoot  // unknown → assume same side persists (rare)
      if (g1SideRoot === 'blue_t1') {
        // t1 was blue. If t1 won G1 (g1Result=true), t2 (loser) plays blue in G2.
        return g1Result ? 'blue_t2' : 'blue_t1'
      } else {
        // t2 was blue. If t2 won G1 (g1Result=false, since blue lost when g1Result=true means t1 won — wait
        // g1Result = "did blue win?". So blue_t2 + g1Result=true means t2 won.
        return g1Result ? 'blue_t1' : 'blue_t2'
      }
    }
    // G3+: side info muddier; assume back to whatever G2 side was
    return n % 2 === 1 ? g1SideRoot : (g1SideRoot === 'blue_t1' ? 'blue_t2' : 'blue_t1')
  }

  // ----- Compute predictions for all games + series -----
  const predictions = useMemo(() => {
    if (!params) return null
    const g1SideRoot: 'blue_t1' | 'blue_t2' | 'sym' =
      sideMode === 'symmetric' ? 'sym' :
      sideMode === 'blue_t1'   ? 'blue_t1' :
                                 'blue_t2'

    const needed = Math.ceil(bestOf / 2)
    const games: Array<{
      n: number; side: 'blue_t1' | 'blue_t2' | 'sym'
      p_t1: number; entered: boolean
    }> = []

    // For each game N, build resultsBefore using actual entered results
    let t1_wins = 0, t2_wins = 0
    for (let n = 1; n <= bestOf; n++) {
      const resultsBefore: Array<{ blue_won: boolean | null; gd15_diff: number | null; side: 'blue_t1' | 'blue_t2' | 'sym' }> = []
      let prevG1Result: boolean | null = null
      for (let k = 1; k < n; k++) {
        const gr = gameResults[k]
        const side_k = sideFor(k, g1SideRoot, prevG1Result)
        resultsBefore.push({
          blue_won:  gr?.blue_won  ?? null,
          gd15_diff: gr?.gd15_diff ?? null,
          side:      side_k,
        })
        if (k === 1) prevG1Result = gr?.blue_won ?? null
      }
      const sideN = sideFor(n, g1SideRoot, prevG1Result)
      const p_t1 = predictGame(n, sideN, resultsBefore)
      const gr_n = gameResults[n]
      const entered = gr_n?.blue_won != null
      games.push({ n, side: sideN, p_t1, entered })

      // Tally wins if entered
      if (entered) {
        const t1_won = sideN === 'blue_t1' ? gr_n.blue_won! : sideN === 'blue_t2' ? !gr_n.blue_won! : gr_n.blue_won!
        if (t1_won) t1_wins++; else t2_wins++
      }

      if (t1_wins >= needed || t2_wins >= needed) {
        // Series clinched — remaining games are moot, stop predicting
        // (still show their predictions but they're hypothetical)
      }
    }

    // Series probability via tree walk (using each game's per-game prediction
    // for unentered games, and the entered result for entered games)
    function seriesProb(): number {
      // Build per-game P(t1 wins) using the predictions (treating entered games
      // as resolved)
      function walk(t1w: number, t2w: number, idx: number): number {
        if (t1w >= needed) return 1
        if (t2w >= needed) return 0
        if (idx >= bestOf) return 0.5  // shouldn't reach
        const g = games[idx]
        const gr = gameResults[idx + 1]
        if (gr?.blue_won != null) {
          const t1_won = g.side === 'blue_t1' ? gr.blue_won : g.side === 'blue_t2' ? !gr.blue_won : gr.blue_won
          return t1_won ? walk(t1w + 1, t2w, idx + 1) : walk(t1w, t2w + 1, idx + 1)
        }
        return g.p_t1 * walk(t1w + 1, t2w, idx + 1) + (1 - g.p_t1) * walk(t1w, t2w + 1, idx + 1)
      }
      return walk(0, 0, 0)
    }
    const p_series_t1 = bestOf === 1 ? games[0].p_t1 : seriesProb()

    return { games, p_series_t1, t1_wins, t2_wins, needed }
  }, [params, history, team1, team2, bestOf, sideMode, playoffs, g2Shrink, poAdj, coachAdj, asOfDate, gameResults, rosters])

  if (err) return <div className="p-8 text-red-400">{err}</div>
  if (!params || !history) return <div className="p-8 text-zinc-400">Loading…</div>

  // Last 7 days (and "today") date options
  const dateOptions = (() => {
    const out: { value: string; label: string }[] = [{ value: '', label: 'Latest (now)' }]
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 86400_000)
      const iso = d.toISOString().slice(0, 10) + 'T00:00:00Z'
      const label = i === 0 ? `Today (${d.toISOString().slice(0,10)})` : d.toISOString().slice(0,10)
      out.push({ value: iso, label })
    }
    return out
  })()

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-8">
      <header className="max-w-6xl mx-auto mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Predict (manual)</h1>
          <p className="text-sm text-zinc-400 mt-1">Replay or forecast any matchup with full control over inputs.</p>
        </div>
        <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-100">← back</Link>
      </header>

      <div className="max-w-6xl mx-auto space-y-4">
        {/* Controls row */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Field label="Team 1">
            <select value={team1} onChange={e => setTeam1(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1">
              {teamOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Team 2">
            <select value={team2} onChange={e => setTeam2(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1">
              {teamOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="As-of date">
            <select value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1">
              {dateOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Best of">
            <select value={bestOf} onChange={e => setBestOf(parseInt(e.target.value) as 1|3|5)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1">
              <option value={1}>Bo1</option>
              <option value={3}>Bo3</option>
              <option value={5}>Bo5</option>
            </select>
          </Field>

          <Field label="Side mode">
            <select value={sideMode} onChange={e => setSideMode(e.target.value as SideMode)} className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1">
              <option value="symmetric">Symmetric (no side bias)</option>
              <option value="blue_t1">{team1} is blue in G1</option>
              <option value="blue_t2">{team2} is blue in G1</option>
            </select>
          </Field>
          <Toggle label="Playoffs"     checked={playoffs} onChange={setPlayoffs} />
          <Toggle label="G2 shrink + draft swap" checked={g2Shrink} onChange={setG2Shrink} />
          <Toggle label="Team PO adj (playoffs only)" checked={poAdj} onChange={setPoAdj} />
        </div>

        {/* Roster editor */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RosterPanel
            color="blue" team={team1} roster={effectiveRoster(team1)}
            playerOptions={Object.keys(params.player_elos).sort()}
            playerElos={params.player_elos}
            onChange={r => setRosters({ ...rosters, [team1]: r })}
            cleared={() => { const c = { ...rosters }; delete c[team1]; setRosters(c) }}
            isOverride={!!rosters[team1]}
          />
          <RosterPanel
            color="red" team={team2} roster={effectiveRoster(team2)}
            playerOptions={Object.keys(params.player_elos).sort()}
            playerElos={params.player_elos}
            onChange={r => setRosters({ ...rosters, [team2]: r })}
            cleared={() => { const c = { ...rosters }; delete c[team2]; setRosters(c) }}
            isOverride={!!rosters[team2]}
          />
        </div>

        {/* Per-game predictions + result injection */}
        {predictions && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <h2 className="text-lg font-semibold mb-3">Predictions</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-left">
                  <th className="py-2">Game</th>
                  <th className="py-2">Side</th>
                  <th className="py-2">P({team1})</th>
                  <th className="py-2">P({team2})</th>
                  <th className="py-2 w-32">Actual result</th>
                  <th className="py-2 w-32">GD15 (blue−red)</th>
                </tr>
              </thead>
              <tbody>
                {predictions.games.map(g => (
                  <tr key={g.n} className="border-t border-zinc-800">
                    <td className="py-2 font-mono">G{g.n}</td>
                    <td className="py-2 text-zinc-400">
                      {g.side === 'sym' ? '—' :
                       g.side === 'blue_t1' ? <><span className="text-blue-400">{team1}</span> · {team2}</> :
                                              <><span className="text-blue-400">{team2}</span> · {team1}</>}
                    </td>
                    <td className="py-2 font-mono text-emerald-400">{(g.p_t1 * 100).toFixed(1)}%</td>
                    <td className="py-2 font-mono text-rose-400">{((1 - g.p_t1) * 100).toFixed(1)}%</td>
                    <td className="py-2">
                      <select
                        value={gameResults[g.n]?.blue_won == null ? '' :
                               gameResults[g.n]?.blue_won ? 'blue' : 'red'}
                        onChange={e => {
                          const v = e.target.value
                          setGameResults({
                            ...gameResults,
                            [g.n]: {
                              ...(gameResults[g.n] ?? { gd15_diff: null }),
                              blue_won: v === '' ? null : v === 'blue',
                            } as { blue_won: boolean | null; gd15_diff: number | null },
                          })
                        }}
                        className="bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-xs"
                      >
                        <option value="">—</option>
                        <option value="blue">Blue won</option>
                        <option value="red">Red won</option>
                      </select>
                    </td>
                    <td className="py-2">
                      <input type="number" step={100}
                        value={gameResults[g.n]?.gd15_diff ?? ''}
                        onChange={e => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value)
                          setGameResults({
                            ...gameResults,
                            [g.n]: {
                              ...(gameResults[g.n] ?? { blue_won: null }),
                              gd15_diff: v,
                            } as { blue_won: boolean | null; gd15_diff: number | null },
                          })
                        }}
                        className="w-24 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-xs font-mono text-right"
                        placeholder="—" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {bestOf > 1 && (
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Series ({predictions.t1_wins}–{predictions.t2_wins})</div>
                <div className="text-3xl font-mono">
                  <span className="text-emerald-400">{(predictions.p_series_t1 * 100).toFixed(1)}%</span>
                  <span className="text-zinc-500 mx-3">·</span>
                  <span className="text-rose-400">{((1 - predictions.p_series_t1) * 100).toFixed(1)}%</span>
                </div>
                <div className="text-xs text-zinc-500 mt-1">{team1} · {team2}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ===== Subcomponents =====
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{label}</div>
      {children}
    </label>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-emerald-500" />
      <span className="text-sm text-zinc-300">{label}</span>
    </label>
  )
}

function RosterPanel({
  color, team, roster, playerOptions, playerElos, onChange, cleared, isOverride,
}: {
  color: 'blue' | 'red'
  team: string
  roster: string[]
  playerOptions: string[]
  playerElos: Record<string, number>
  onChange: (r: string[]) => void
  cleared: () => void
  isOverride: boolean
}) {
  const POS = ['Top', 'Jng', 'Mid', 'Bot', 'Sup']
  const colorCls = color === 'blue' ? 'text-blue-400' : 'text-rose-400'
  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className={`text-sm font-semibold ${colorCls}`}>{team}</h3>
        {isOverride && <button onClick={cleared} className="text-[10px] text-zinc-500 hover:text-zinc-300">Reset roster</button>}
      </div>
      <div className="space-y-1.5">
        {POS.map((pos, i) => {
          const p = roster[i] ?? ''
          const elo = p ? playerElos[p] : null
          return (
            <div key={pos} className="grid grid-cols-[40px_1fr_60px] gap-2 items-center text-xs">
              <span className="text-zinc-500">{pos}</span>
              <select value={p}
                onChange={e => { const r = [...roster]; r[i] = e.target.value; onChange(r) }}
                className="bg-zinc-950 border border-zinc-800 rounded px-1 py-0.5">
                <option value="">—</option>
                {playerOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <span className="font-mono text-zinc-400 text-right">{elo != null ? elo.toFixed(0) : '—'}</span>
            </div>
          )
        })}
      </div>
      <div className="text-[10px] text-zinc-600 mt-2">Total ELO: {roster.reduce((sum, p) => sum + (playerElos[p] ?? 0), 0).toFixed(0)}</div>
    </div>
  )
}
