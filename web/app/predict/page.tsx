'use client'

import React, { useEffect, useMemo, useState } from 'react'
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

interface PickStats {
  total: number
  side?: { blue: { n: number; pct: number }; red: { n: number; pct: number } }
  pick?: { first: { n: number; pct: number }; second: { n: number; pct: number } }
}
interface TeamPickTendencies {
  after_loss:     PickStats
  as_g1_favorite: PickStats
}
interface PickTendenciesFile {
  generated: string
  window:    string
  teams:     Record<string, TeamPickTendencies>
}

interface TeamSnapshot { date: string; elo: number; rwr: number | null; gd15: number | null; roster: string[] }
interface TeamStateHistory {
  generated:              string
  window_days:            number
  gd15_roll?:             number
  teams:                  Record<string, TeamSnapshot[]>
  // [[date_iso, gd15], ...] per player — filter by chosen date, then rolling mean of last 5
  player_gd15_dated?:     Record<string, Array<[string, number]>>
  // { "<sorted min|||max team pair>": [[date_iso, h2h_wr_min_perspective], ...] }
  // — uses BEFORE-game stored h2h_wr from production game_features.
  team_pair_h2h_dated?:   Record<string, Array<[string, number]>>
  // { "<sorted min|||max>": N } — total historical game count (for Bayesian h2h updates)
  team_pair_n_games?:     Record<string, number>
  // { team: [[date_iso, 0_or_1], ...] } — last 15 win/loss per team for rwr cascade
  team_wins_dated?:       Record<string, Array<[string, number]>>
}

// Team gd15 from per-player rolling tails — matches feature_engineering.py:515-519
// + date-aware filtering: only includes entries STRICTLY BEFORE asOfDate.
function teamGd15FromRoster(
  roster: string[],
  tails: Record<string, Array<[string, number]>> | undefined,
  asOfDate: string,
  n = 5,
): number | null {
  if (!tails || roster.length === 0) return null
  const cutoff = asOfDate || ''  // empty string = no cutoff (use everything)
  const laneMeans: number[] = []
  for (const p of roster) {
    const h = tails[p]
    if (!h) continue
    const filtered = cutoff
      ? h.filter(([d]) => d < cutoff).map(([, v]) => v)
      : h.map(([, v]) => v)
    if (filtered.length >= 2) {
      const slice = filtered.slice(-n)
      laneMeans.push(slice.reduce((a, b) => a + b, 0) / slice.length)
    }
  }
  if (laneMeans.length === 0) return null
  return laneMeans.reduce((a, b) => a + b, 0) / laneMeans.length
}

// ===== Math helpers =====
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))
const logit   = (p: number): number => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p))

// Half-Kelly bet sizing for a binary market.
// pModel  = your estimate that team1 wins
// pMarket = market's price for team1 (= probability you must pay per $1 payout)
// Returns the side with positive edge (or null if no edge), plus fraction-of-bankroll and PnL outcomes.
interface KellyResult {
  side:        't1' | 't2'   // which side to bet
  edge_pp:     number        // edge in percentage points
  fraction:    number        // half-Kelly fraction of bankroll (0..1)
  price:       number        // price you're paying on the chosen side
  payoff_win:  number        // net $ if your side wins (= stake × (1-price)/price)
  loss_lose:   number        // net $ if you lose (= -stake)
  stake:       number        // $ at risk
}
function halfKelly(pModel: number, pMarket_t1: number, bankroll: number): KellyResult | null {
  // Edge per side
  const edge_t1 = pModel - pMarket_t1
  const edge_t2 = (1 - pModel) - (1 - pMarket_t1)  // = -edge_t1
  const useT1   = edge_t1 > 0
  const side: 't1' | 't2' = useT1 ? 't1' : 't2'
  const edge    = useT1 ? edge_t1 : edge_t2
  const price   = useT1 ? pMarket_t1 : (1 - pMarket_t1)
  if (edge <= 0 || price <= 0 || price >= 1) return null
  // Kelly: f* = edge / (1 - price); half-Kelly = / 2
  const fraction = (edge / (1 - price)) / 2
  const stake    = fraction * bankroll
  // Payoff = stake × (1 / price) − stake = stake × (1 − price)/price
  const payoff_win = stake * (1 - price) / price
  const loss_lose  = -stake
  return { side, edge_pp: edge * 100, fraction, price, payoff_win, loss_lose, stake }
}

function getH2H(params: ModelParams, t1: string, t2: string): number {
  if (params.h2h[`${t1}|||${t2}`] !== undefined) return params.h2h[`${t1}|||${t2}`]
  if (params.h2h[`${t2}|||${t1}`] !== undefined) return 1 - params.h2h[`${t2}|||${t1}`]
  return params.fill.h2h_wr ?? 0.5
}

// Per-player H2H WR vs opposing-lane player. Mirrors feature_engineering._player_h2h_wr:
// key = alphabetically-sorted player pair + position, value.wins = wins for p0.
function getPlayerH2H(
  params: ModelParams, ownPlayer: string, oppPlayer: string, pos: string,
): { wr: number; n: number } | null {
  if (!ownPlayer || !oppPlayer) return null
  const [p0, p1] = ownPlayer <= oppPlayer ? [ownPlayer, oppPlayer] : [oppPlayer, ownPlayer]
  const entry = params.player_h2h[`${p0}|||${p1}|||${pos}`]
  if (!entry || entry.n === 0) return null
  const winsForOwn = p0 === ownPlayer ? entry.wins : entry.n - entry.wins
  return { wr: winsForOwn / entry.n, n: entry.n }
}

// Date-aware h2h lookup: returns the stored BEFORE-game h2h_wr for the matchup
// closest to the user's chosen as-of date. Matches production game_features exactly.
// Returns null if no per-pair history exists (caller falls back to getH2H).
function getH2HAtDate(
  history: TeamStateHistory | null,
  t1: string, t2: string, asOfDate: string,
): number | null {
  if (!history?.team_pair_h2h_dated) return null
  const [minT, maxT] = t1 <= t2 ? [t1, t2] : [t2, t1]
  const entries = history.team_pair_h2h_dated[`${minT}|||${maxT}`]
  if (!entries?.length) return null
  // Use BEFORE-game value of the first game on/after asOfDate (= state AT asOfDate).
  // If no game on/after, use the last available (most recent BEFORE-state).
  let chosen = entries[entries.length - 1]
  if (asOfDate) {
    const after = entries.find(([d]) => d >= asOfDate)
    if (after) chosen = after
  }
  // Stored from MIN team's perspective; convert if t1 is the MAX team
  return t1 === minT ? chosen[1] : 1 - chosen[1]
}

// Build raw feature vector for (t1 perspective, vs t2)
function rawFeatures(
  params: ModelParams,
  t1: string, t2: string,
  s1: { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null },
  s2: { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null },
  playoffs: boolean,
  history: TeamStateHistory | null,
  asOfDate: string,
): Record<string, number> {
  const f = params.fill
  const datedH2H = getH2HAtDate(history, t1, t2, asOfDate)
  return {
    elo_diff:     (s1.elo != null && s2.elo != null) ? s1.elo - s2.elo : f.elo_diff,
    rwr_diff:     (s1.rwr != null && s2.rwr != null) ? s1.rwr - s2.rwr : f.rwr_diff,
    h2h_wr:       datedH2H ?? getH2H(params, t1, t2),
    playoffs:     playoffs ? 1 : 0,
    gd15_diff:    (s1.gd15 != null && s2.gd15 != null) ? s1.gd15 - s2.gd15 : f.gd15_diff,
    outperf_diff: (s1.outperf != null && s2.outperf != null) ? s1.outperf - s2.outperf : f.outperf_diff,
  }
}

function zFromFeats(params: ModelParams, feats: Record<string, number>, withIntercept: boolean): number {
  // Defensive ?? 0 — until next daily pipeline writes intercept, fall back to no intercept.
  // Marginal effect: ~2pp difference in sided predictions until intercept is back.
  let z = withIntercept ? (params.intercept ?? 0) : 0
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
  const [params,  setParams]   = useState<ModelParams | null>(null)
  const [history, setHistory]  = useState<TeamStateHistory | null>(null)
  const [picks,   setPicks]    = useState<PickTendenciesFile | null>(null)
  const [err,     setErr]      = useState<string | null>(null)

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

  // Per-team manual ELO adjustment (added to whatever the snapshot/computed elo is).
  // Lets the user say "I think Gen.G is +30 vs what ELO says" and see the impact.
  const [eloAdjustments, setEloAdjustments] = useState<Record<string, number>>({})

  // Result injection: per-game blue_won + gd15_diff (blue minus red, in raw gold value)
  // + market_t1: user-entered market price (probability) for team1 winning that game.
  // Indexed by 1..5 (game number)
  const [gameResults, setGameResults] = useState<Record<number, {
    blue_won: boolean | null
    gd15_diff: number | null
    market_t1: number | null
  }>>({})

  // Global bankroll for Kelly $ sizing
  const [bankroll, setBankroll] = useState<number>(1000)
  // Series-level market price (for match-winner market)
  const [seriesMarketT1, setSeriesMarketT1] = useState<number | null>(null)

  // Per-game side override. If unset for a game, falls back to sideFor() default.
  // 'sym' / 'blue_t1' / 'blue_t2'  (same alphabet as the internal side type)
  const [gameSideOverrides, setGameSideOverrides] = useState<Record<number, 'sym' | 'blue_t1' | 'blue_t2'>>({})

  // Per-game UI: which rows have their formula breakdown expanded
  const [expandedGames, setExpandedGames] = useState<Record<number, boolean>>({})

  // Load
  useEffect(() => {
    Promise.all([
      fetch('/model_params.json').then(r => r.json()),
      fetch('/team_state_history.json').then(r => r.json()),
      fetch('/pick_tendencies.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([p, h, pk]) => { setParams(p); setHistory(h); setPicks(pk) })
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

  // Walk backwards through a team's snapshots starting at asOfDate's selected snap,
  // returning the most recent non-null value for a given key. Used as a fallback
  // when today's snap has gd15=null (e.g. games.csv doesn't have today's games yet).
  function lastNonNull<K extends 'gd15' | 'rwr' | 'elo'>(team: string, isoDate: string, key: K): number | null {
    const snaps = history?.teams[team] ?? []
    if (snaps.length === 0) return null
    // Find the snapshot we'd normally use, then walk backward
    const targetIdx = !isoDate
      ? snaps.length - 1
      : snaps.findIndex(s => s.date >= isoDate)
    const start = targetIdx >= 0 ? targetIdx : snaps.length - 1
    for (let i = start; i >= 0; i--) {
      const v = snaps[i][key]
      if (v != null) return v as number
    }
    return null
  }

  // ----- Resolve team state for prediction -----
  // If asOfDate is set: use snapshot (elo/rwr/gd15 from history) + current model_params for outperf
  //                      (outperf rebuild is more involved; gd15 is now in history)
  // Else: use current model_params team stats.
  function teamState(team: string) {
    const cur = params?.teams[team]
    const roster = effectiveRoster(team)
    // Recompute team gd15 from this team's actual roster + per-player gd15 tails.
    // Matches feature_engineering._rolling_gd15 + np.nanmean, with date-aware
    // filtering so picking "5-27 midnight" excludes 5-27's games from the rolling.
    const computed_gd15 = teamGd15FromRoster(roster, history?.player_gd15_dated, asOfDate, history?.gd15_roll ?? 5)

    if (asOfDate) {
      const snap = stateAt(team, asOfDate)
      if (snap) return {
        elo:     snap.elo,
        rwr:     snap.rwr ?? lastNonNull(team, asOfDate, 'rwr'),
        gd15:    computed_gd15 ?? snap.gd15 ?? lastNonNull(team, asOfDate, 'gd15'),
        outperf: cur?.outperf ?? null,
      }
    }
    const snap = stateAt(team, '')
    return {
      elo:     snap?.elo  ?? cur?.elo  ?? null,
      rwr:     snap?.rwr  ?? cur?.rwr  ?? null,
      gd15:    computed_gd15 ?? snap?.gd15 ?? lastNonNull(team, '', 'gd15') ?? cur?.gd15 ?? null,
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

  // ----- Team ELO from roster (mean of player_elos, matches feature_engineering._team_elo) -----
  function rosterElo(roster: string[]): number | null {
    if (!params || roster.length !== 5) return null
    const vals = roster.map(p => params.player_elos[p]).filter((v): v is number => v != null)
    if (vals.length !== 5) return null
    return vals.reduce((a, b) => a + b, 0) / 5
  }

  // ----- Per-game prediction with full breakdown -----
  interface Breakdown {
    p_t1:             number
    z_final:          number
    side:             'blue_t1' | 'blue_t2' | 'sym'
    // Non-model contextual flags (affect G2 shrinkage path)
    game_in_series:   number          // 1, 2, 3, ...
    draft_advantage:  number          // +1 if t1 had draft choice this game (lost prev), −1 if t2, 0 for G1
    // Inputs going into the model
    s1:               { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null }
    s2:               { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null }
    rawFeats:         Record<string, number>
    // Per-feature contributions to z (in t1 perspective, intercept-free; signs match side)
    contributions:    Array<{ name: string; raw: number; scaled: number; contribution: number }>
    // Optional adjustments
    intercept_used:   number          // 0 if symmetric, else the LR intercept
    po_adj_net:       number          // applied if playoffs && poAdj
    coaching_adj_net: number          // applied if coachAdj
    g2_alpha_shrink:  number | null   // alpha_g2 multiplier applied (if g2 shrink active)
    g2_beta_term:     number | null   // beta_da × draft_advantage (if g2 shrink active)
    // Intermediate z values
    z_before_adj:     number          // z from features (+ intercept if sided), before po/coach/g2
    z_after_adj:      number          // + po/coach adjustments
  }

  function predictGame(
    n: number,
    sideForN: 'blue_t1' | 'blue_t2' | 'sym',
    resultsBefore: Array<{ blue_won: boolean | null; gd15_diff: number | null; side: 'blue_t1' | 'blue_t2' | 'sym' }>,
  ): Breakdown {
    const empty: Breakdown = {
      p_t1: 0.5, z_final: 0, side: sideForN,
      game_in_series: n, draft_advantage: 0,
      s1: { elo: null, rwr: null, gd15: null, outperf: null },
      s2: { elo: null, rwr: null, gd15: null, outperf: null },
      rawFeats: {}, contributions: [],
      intercept_used: 0, po_adj_net: 0, coaching_adj_net: 0,
      g2_alpha_shrink: null, g2_beta_term: null,
      z_before_adj: 0, z_after_adj: 0,
    }
    if (!params) return empty

    // Apply roster overrides → recompute team elo via sum of player elos if customized.
    const r1 = effectiveRoster(team1)
    const r2 = effectiveRoster(team2)
    const baseS1 = teamState(team1)
    const baseS2 = teamState(team2)
    const e1Override = rosters[team1] ? rosterElo(r1) : null
    const e2Override = rosters[team2] ? rosterElo(r2) : null
    // Apply manual per-team ELO adjustments (additive)
    const adj1 = eloAdjustments[team1] ?? 0
    const adj2 = eloAdjustments[team2] ?? 0
    let s1 = { ...baseS1, elo: (e1Override ?? baseS1.elo ?? 0) + adj1 }
    let s2 = { ...baseS2, elo: (e2Override ?? baseS2.elo ?? 0) + adj2 }

    // Cascade prior game results into ALL features (elo, rwr, gd15, h2h).
    // Each prior game updates the working state for the current game's prediction.
    const K_FACTOR = 24
    const ROLL_RWR = 10
    const ROLL_GD15 = history?.gd15_roll ?? 5
    let prev_blue_won: boolean | null = null

    // Filter past entries by asOfDate (only games BEFORE the chosen "as-of" date)
    const filterDated = <T,>(arr: Array<[string, T]> | undefined): T[] =>
      (arr ?? []).filter(([d]) => !asOfDate || d < asOfDate).map(([, v]) => v)
    const t1_wins_past = filterDated<number>(history?.team_wins_dated?.[team1])
    const t2_wins_past = filterDated<number>(history?.team_wins_dated?.[team2])
    const t1_wins_synth: number[] = []
    const t2_wins_synth: number[] = []

    const player_gd15_synth: Record<string, number[]> = {}
    const addPlayerGd15 = (p: string, v: number) => {
      if (!player_gd15_synth[p]) player_gd15_synth[p] = []
      player_gd15_synth[p].push(v)
    }

    // Bayesian-shrunk h2h: start from current snapshot value + total game count
    const [minT, maxT] = team1 <= team2 ? [team1, team2] : [team2, team1]
    const pairKey = `${minT}|||${maxT}`
    const h2h_n_base = history?.team_pair_n_games?.[pairKey] ?? 0
    // Back-out wins from current h2h: h2h = (wins + 2.5) / (n + 5)  → wins = h2h*(n+5) - 2.5
    const h2h_min_perspective_base = (() => {
      const entries = history?.team_pair_h2h_dated?.[pairKey] ?? []
      if (entries.length === 0) return 0.5
      // Use BEFORE-state of first game on/after asOfDate, fall back to most recent
      if (asOfDate) {
        const after = entries.find(([d]) => d >= asOfDate)
        if (after) return after[1]
      }
      return entries[entries.length - 1][1]
    })()
    // wins from MIN team's perspective in historical record
    let h2h_min_wins = h2h_min_perspective_base * (h2h_n_base + 5) - 2.5
    let h2h_n = h2h_n_base
    // Filter to count past games only (date-aware)
    if (asOfDate) {
      const filtered_entries = (history?.team_pair_h2h_dated?.[pairKey] ?? []).filter(([d]) => d < asOfDate)
      h2h_n = filtered_entries.length > 0 ? Math.max(h2h_n_base - ((history?.team_pair_h2h_dated?.[pairKey] ?? []).length - filtered_entries.length), 0) : h2h_n_base
    }

    for (let i = 0; i < resultsBefore.length; i++) {
      const r = resultsBefore[i]
      if (r.blue_won == null) continue
      const side = r.side
      let t1_won_prev: boolean
      if      (side === 'blue_t1') t1_won_prev = r.blue_won
      else if (side === 'blue_t2') t1_won_prev = !r.blue_won
      else                         t1_won_prev = r.blue_won

      // 1) ELO update
      const expected1 = 1 / (1 + Math.pow(10, ((s2.elo ?? 1500) - (s1.elo ?? 1500)) / 400))
      const delta     = K_FACTOR * ((t1_won_prev ? 1 : 0) - expected1)
      s1 = { ...s1, elo: (s1.elo ?? 1500) + delta }
      s2 = { ...s2, elo: (s2.elo ?? 1500) - delta }

      // 2) rwr update: append 1/0 to each team's win history
      t1_wins_synth.push(t1_won_prev ? 1 : 0)
      t2_wins_synth.push(t1_won_prev ? 0 : 1)

      // 3) gd15 update: distribute team's gd15_diff to each roster player's history
      // (uniform across lanes — approximation; real per-position gd15 differs by lane
      //  but model only sees team mean so this is sufficient)
      if (r.gd15_diff != null) {
        const t1_gd15 = side === 'blue_t1' ? r.gd15_diff :
                        side === 'blue_t2' ? -r.gd15_diff :
                        r.gd15_diff  // sym: assume t1 was blue
        for (const p of r1) addPlayerGd15(p, t1_gd15)
        for (const p of r2) addPlayerGd15(p, -t1_gd15)
      }

      // 4) h2h update (Bayesian-shrunk)
      // From MIN team's perspective: did min team win?
      const min_won = team1 === minT ? t1_won_prev : !t1_won_prev
      h2h_min_wins += min_won ? 1 : 0
      h2h_n += 1

      prev_blue_won = r.blue_won
    }

    // Compute augmented rwr (rolling-10 over past + synthetic results)
    const rwrFromHist = (past: number[], synth: number[]): number | null => {
      const all = [...past, ...synth]
      if (all.length < 3) return null
      const window = all.slice(-ROLL_RWR)
      return window.reduce((a, b) => a + b, 0) / window.length
    }
    const s1_rwr_aug = rwrFromHist(t1_wins_past, t1_wins_synth) ?? s1.rwr
    const s2_rwr_aug = rwrFromHist(t2_wins_past, t2_wins_synth) ?? s2.rwr
    s1 = { ...s1, rwr: s1_rwr_aug }
    s2 = { ...s2, rwr: s2_rwr_aug }

    // Compute augmented team gd15 (rolling-5 per player, including synthetic entries)
    const teamGd15Aug = (roster: string[], asOf: string): number | null => {
      const laneMeans: number[] = []
      for (const p of roster) {
        const past = filterDated<number>(history?.player_gd15_dated?.[p])
        const synth = player_gd15_synth[p] ?? []
        const all = [...past, ...synth]
        if (all.length >= 2) {
          const slice = all.slice(-ROLL_GD15)
          laneMeans.push(slice.reduce((a, b) => a + b, 0) / slice.length)
        }
      }
      if (laneMeans.length === 0) return null
      return laneMeans.reduce((a, b) => a + b, 0) / laneMeans.length
    }
    s1 = { ...s1, gd15: teamGd15Aug(r1, asOfDate) ?? s1.gd15 }
    s2 = { ...s2, gd15: teamGd15Aug(r2, asOfDate) ?? s2.gd15 }

    // Augmented h2h: convert min-perspective wins back to (t1, t2) frame
    const h2h_min = (h2h_min_wins + 2.5) / (h2h_n + 5)
    const h2h_t1  = team1 === minT ? h2h_min : 1 - h2h_min

    // Build features using AUGMENTED state. Override h2h with our cascade value
    // (rawFeatures' built-in date lookup would return only the pre-G1 h2h,
    //  missing updates from injected results).
    const rawFeatsT1: Record<string, number> = rawFeatures(params, team1, team2, s1, s2, playoffs, history, asOfDate)
    const rawFeatsT2: Record<string, number> = rawFeatures(params, team2, team1, s2, s1, playoffs, history, asOfDate)
    const feats: Record<string, number>     = { ...rawFeatsT1, h2h_wr: h2h_t1 }
    const feats_rev: Record<string, number> = { ...rawFeatsT2, h2h_wr: 1 - h2h_t1 }

    // Per-feature contributions (t1 perspective; sided returns + intercept; sym uses symmetric formula)
    const contributions: Array<{ name: string; raw: number; scaled: number; contribution: number }> = []
    let zT1: number
    let intercept_used: number

    if (sideForN === 'sym') {
      // Symmetric: zFwd_no_intercept - zRev_no_intercept averaged
      intercept_used = 0
      let zFwd = 0, zRev = 0
      for (let i = 0; i < params.features.length; i++) {
        const f       = params.features[i]
        const v       = feats[f]
        const vr      = feats_rev[f]
        const scaled  = (v  - params.scaler.mean[i]) / params.scaler.scale[i]
        const scaledR = (vr - params.scaler.mean[i]) / params.scaler.scale[i]
        const contrib = ((scaled - scaledR) / 2) * params.coef[i]
        zFwd += scaled  * params.coef[i]
        zRev += scaledR * params.coef[i]
        contributions.push({ name: f, raw: v, scaled, contribution: contrib })
      }
      zT1 = (zFwd - zRev) / 2
    } else {
      // Sided: include intercept; flip sign if team2 is blue
      const useRev = sideForN === 'blue_t2'
      const usedFeats = useRev ? feats_rev : feats
      intercept_used = params.intercept ?? 0
      let z = 0
      for (let i = 0; i < params.features.length; i++) {
        const f       = params.features[i]
        const v       = usedFeats[f]
        const scaled  = (v - params.scaler.mean[i]) / params.scaler.scale[i]
        const contrib = scaled * params.coef[i]
        z += contrib
        // Report in t1 perspective (flip sign if t2 was blue)
        const t1_contrib = useRev ? -contrib : contrib
        contributions.push({ name: f, raw: useRev ? feats[f] : v, scaled, contribution: t1_contrib })
      }
      const zWithIntercept = z + intercept_used
      zT1 = useRev ? -zWithIntercept : zWithIntercept
    }

    const z_before_adj = zT1

    // Playoff team-PO adjustment + coaching adjustment
    const po1 = params.teams[team1]?.po_adj ?? 0
    const po2 = params.teams[team2]?.po_adj ?? 0
    const po_adj_net = (playoffs && poAdj) ? (po1 - po2) : 0
    zT1 += po_adj_net

    const co1 = params.teams[team1]?.coaching_adj ?? 0
    const co2 = params.teams[team2]?.coaching_adj ?? 0
    const coaching_adj_net = coachAdj ? (co1 - co2) : 0
    zT1 += coaching_adj_net

    const z_after_adj = zT1

    // Derive draft_advantage for the CURRENT game (n) from prior results.
    // +1 = t1 had draft choice (= lost previous game), −1 = t2 had it, 0 = G1.
    let draft_advantage = 0
    if (n >= 2 && resultsBefore.length >= 1 && prev_blue_won != null) {
      const side_prev = resultsBefore[resultsBefore.length - 1].side
      const blue_was_t1_prev = side_prev === 'blue_t1' || side_prev === 'sym'
      const t1_won_prev = blue_was_t1_prev ? prev_blue_won : !prev_blue_won
      draft_advantage = t1_won_prev ? -1 : 1
    }

    // G2 shrink + draft swap
    let g2_alpha_shrink: number | null = null
    let g2_beta_term:    number | null = null
    if (n === 2 && g2Shrink) {
      g2_alpha_shrink = params.alpha_g2
      g2_beta_term    = params.beta_da * draft_advantage
      zT1 = params.alpha_g2 * zT1 + g2_beta_term
    }

    return {
      p_t1:             sigmoid(zT1),
      z_final:          zT1,
      side:             sideForN,
      game_in_series:   n,
      draft_advantage,
      s1, s2,
      rawFeats:         feats,
      contributions,
      intercept_used,
      po_adj_net,
      coaching_adj_net,
      g2_alpha_shrink,
      g2_beta_term,
      z_before_adj,
      z_after_adj,
    }
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
      sideDefault: 'blue_t1' | 'blue_t2' | 'sym'
      sideOverridden: boolean
      entered: boolean
      breakdown: ReturnType<typeof predictGame>
    }> = []

    let t1_wins = 0, t2_wins = 0
    for (let n = 1; n <= bestOf; n++) {
      const resultsBefore: Array<{ blue_won: boolean | null; gd15_diff: number | null; side: 'blue_t1' | 'blue_t2' | 'sym' }> = []
      let prevG1Result: boolean | null = null
      for (let k = 1; k < n; k++) {
        const gr = gameResults[k]
        // Use the actual side that game k WAS predicted with (override if set, else default)
        const default_k = sideFor(k, g1SideRoot, prevG1Result)
        const side_k    = gameSideOverrides[k] ?? default_k
        resultsBefore.push({
          blue_won:  gr?.blue_won  ?? null,
          gd15_diff: gr?.gd15_diff ?? null,
          side:      side_k,
        })
        if (k === 1) prevG1Result = gr?.blue_won ?? null
      }
      const sideDefault = sideFor(n, g1SideRoot, prevG1Result)
      const sideN       = gameSideOverrides[n] ?? sideDefault
      const breakdown   = predictGame(n, sideN, resultsBefore)
      const gr_n        = gameResults[n]
      const entered     = gr_n?.blue_won != null
      games.push({
        n, side: sideN, sideDefault,
        sideOverridden: !!gameSideOverrides[n],
        entered, breakdown,
      })

      if (entered) {
        const t1_won = sideN === 'blue_t1' ? gr_n.blue_won! : sideN === 'blue_t2' ? !gr_n.blue_won! : gr_n.blue_won!
        if (t1_won) t1_wins++; else t2_wins++
      }
    }

    // Series probability via tree walk
    function seriesProb(): number {
      function walk(t1w: number, t2w: number, idx: number): number {
        if (t1w >= needed) return 1
        if (t2w >= needed) return 0
        if (idx >= bestOf) return 0.5
        const g = games[idx]
        const gr = gameResults[idx + 1]
        if (gr?.blue_won != null) {
          const t1_won = g.side === 'blue_t1' ? gr.blue_won : g.side === 'blue_t2' ? !gr.blue_won : gr.blue_won
          return t1_won ? walk(t1w + 1, t2w, idx + 1) : walk(t1w, t2w + 1, idx + 1)
        }
        return g.breakdown.p_t1 * walk(t1w + 1, t2w, idx + 1) + (1 - g.breakdown.p_t1) * walk(t1w, t2w + 1, idx + 1)
      }
      return walk(0, 0, 0)
    }
    const p_series_t1 = bestOf === 1 ? games[0].breakdown.p_t1 : seriesProb()

    return { games, p_series_t1, t1_wins, t2_wins, needed }
  }, [params, history, team1, team2, bestOf, sideMode, playoffs, g2Shrink, poAdj, coachAdj, asOfDate, gameResults, rosters, gameSideOverrides, eloAdjustments])

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
        {(() => {
          const s1 = teamState(team1)
          const s2 = teamState(team2)
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <RosterPanel
                color="blue" team={team1}
                roster={effectiveRoster(team1)} oppRoster={effectiveRoster(team2)}
                playerOptions={Object.keys(params.player_elos).sort()}
                playerElos={params.player_elos}
                params={params}
                defaultRoster={(asOfDate ? (stateAt(team1, asOfDate)?.roster ?? params.rosters[team1]) : params.rosters[team1]) ?? []}
                teamRwr={s1.rwr} teamGd15={s1.gd15}
                eloAdj={eloAdjustments[team1] ?? 0}
                onEloAdjChange={v => setEloAdjustments({ ...eloAdjustments, [team1]: v })}
                onChange={r => setRosters({ ...rosters, [team1]: r })}
                cleared={() => { const c = { ...rosters }; delete c[team1]; setRosters(c) }}
                isOverride={!!rosters[team1]}
              />
              <RosterPanel
                color="red" team={team2}
                roster={effectiveRoster(team2)} oppRoster={effectiveRoster(team1)}
                playerOptions={Object.keys(params.player_elos).sort()}
                playerElos={params.player_elos}
                params={params}
                defaultRoster={(asOfDate ? (stateAt(team2, asOfDate)?.roster ?? params.rosters[team2]) : params.rosters[team2]) ?? []}
                teamRwr={s2.rwr} teamGd15={s2.gd15}
                eloAdj={eloAdjustments[team2] ?? 0}
                onEloAdjChange={v => setEloAdjustments({ ...eloAdjustments, [team2]: v })}
                onChange={r => setRosters({ ...rosters, [team2]: r })}
                cleared={() => { const c = { ...rosters }; delete c[team2]; setRosters(c) }}
                isOverride={!!rosters[team2]}
              />
            </div>
          )
        })()}

        {/* Bankroll input */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 flex items-center gap-4 text-sm">
          <label>
            <span className="text-[11px] uppercase tracking-wide text-zinc-500 mr-2">Bankroll $</span>
            <input type="number" step={100} min={0}
              value={bankroll}
              onChange={e => setBankroll(parseFloat(e.target.value) || 0)}
              className="w-24 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-right" />
          </label>
          <span className="text-[11px] text-zinc-500">Half-Kelly sizing. Enter per-game market price for {team1} winning; the other side is implied as 1−p.</span>
        </div>

        {/* Per-game predictions + result injection */}
        {predictions && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 overflow-x-auto">
            <h2 className="text-lg font-semibold mb-3">Predictions</h2>
            <div className="text-[11px] text-zinc-500 mb-2">Click a game row to see the full formula breakdown.</div>
            <table className="w-full text-sm min-w-[1100px]">
              <thead>
                <tr className="text-zinc-500 text-left">
                  <th className="py-2">Game</th>
                  <th className="py-2">Side</th>
                  <th className="py-2">P({team1})</th>
                  <th className="py-2">P({team2})</th>
                  <th className="py-2 w-24" title="Market price for {team1} winning this game (0–1). The other side is implied 1−p.">Market p({team1})</th>
                  <th className="py-2 w-40" title="Half-Kelly: bet side + fraction of bankroll. Negative edge → no bet.">½-Kelly bet</th>
                  <th className="py-2 w-40" title="Net $ outcome if {team1} wins / if {team2} wins, based on the recommended Kelly bet.">PnL ({team1} / {team2})</th>
                  <th className="py-2 w-28">Actual result</th>
                  <th className="py-2 w-24" title="Per-lane average gold diff at 15 min (blue − red). For total-team diff, divide by 5.">Per-lane GD15</th>
                </tr>
              </thead>
              <tbody>
                {predictions.games.map(g => {
                  const market = gameResults[g.n]?.market_t1 ?? null
                  const kelly  = (market != null) ? halfKelly(g.breakdown.p_t1, market, bankroll) : null
                  return (
                  <React.Fragment key={`g${g.n}`}>
                  <tr className="border-t border-zinc-800">
                    <td className="py-2 font-mono">
                      <button onClick={() => setExpandedGames({ ...expandedGames, [g.n]: !expandedGames[g.n] })}
                        className="text-zinc-300 hover:text-zinc-100">
                        {expandedGames[g.n] ? '▼' : '▶'} G{g.n}
                      </button>
                    </td>
                    <td className="py-2">
                      <select
                        value={gameSideOverrides[g.n] ?? g.sideDefault}
                        onChange={e => {
                          const v = e.target.value as 'sym' | 'blue_t1' | 'blue_t2'
                          if (v === g.sideDefault) {
                            const c = { ...gameSideOverrides }
                            delete c[g.n]
                            setGameSideOverrides(c)
                          } else {
                            setGameSideOverrides({ ...gameSideOverrides, [g.n]: v })
                          }
                        }}
                        className="bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-xs"
                      >
                        <option value="sym">Symmetric (no side)</option>
                        <option value="blue_t1">{team1} is blue</option>
                        <option value="blue_t2">{team2} is blue</option>
                      </select>
                      {g.sideOverridden && <span className="text-[9px] text-amber-400 ml-1">override</span>}
                    </td>
                    <td className="py-2 font-mono text-emerald-400">{(g.breakdown.p_t1 * 100).toFixed(1)}%</td>
                    <td className="py-2 font-mono text-rose-400">{((1 - g.breakdown.p_t1) * 100).toFixed(1)}%</td>
                    <td className="py-2">
                      <input type="number" step={0.01} min={0} max={1}
                        value={market ?? ''}
                        onChange={e => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value)
                          setGameResults({
                            ...gameResults,
                            [g.n]: {
                              ...(gameResults[g.n] ?? { blue_won: null, gd15_diff: null, market_t1: null }),
                              market_t1: v,
                            },
                          })
                        }}
                        className="w-20 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-xs font-mono text-right"
                        placeholder="0.55" />
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {kelly == null
                        ? <span className="text-zinc-600">—</span>
                        : <>
                            <span className={kelly.side === 't1' ? 'text-blue-400' : 'text-rose-400'}>
                              {kelly.side === 't1' ? team1 : team2}
                            </span>{' '}
                            <span className="text-zinc-300">{(kelly.fraction * 100).toFixed(2)}%</span>{' '}
                            <span className="text-zinc-500">(${kelly.stake.toFixed(0)})</span>
                            <div className="text-[10px] text-zinc-500">edge {kelly.edge_pp >= 0 ? '+' : ''}{kelly.edge_pp.toFixed(2)}pp @ ${kelly.price.toFixed(3)}</div>
                          </>}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {kelly == null
                        ? <span className="text-zinc-600">—</span>
                        : <>
                            <span className={kelly.side === 't1' ? 'text-emerald-400' : 'text-rose-400'}>
                              {kelly.side === 't1' ? `+$${kelly.payoff_win.toFixed(2)}` : `-$${(-kelly.loss_lose).toFixed(2)}`}
                            </span>
                            {' / '}
                            <span className={kelly.side === 't2' ? 'text-emerald-400' : 'text-rose-400'}>
                              {kelly.side === 't2' ? `+$${kelly.payoff_win.toFixed(2)}` : `-$${(-kelly.loss_lose).toFixed(2)}`}
                            </span>
                          </>}
                    </td>
                    <td className="py-2">
                      <select
                        value={gameResults[g.n]?.blue_won == null ? '' :
                               gameResults[g.n]?.blue_won ? 'blue' : 'red'}
                        onChange={e => {
                          const v = e.target.value
                          setGameResults({
                            ...gameResults,
                            [g.n]: {
                              ...(gameResults[g.n] ?? { gd15_diff: null, market_t1: null }),
                              blue_won: v === '' ? null : v === 'blue',
                            } as { blue_won: boolean | null; gd15_diff: number | null; market_t1: number | null },
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
                              ...(gameResults[g.n] ?? { blue_won: null, market_t1: null }),
                              gd15_diff: v,
                            } as { blue_won: boolean | null; gd15_diff: number | null; market_t1: number | null },
                          })
                        }}
                        className="w-20 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-xs font-mono text-right"
                        placeholder="—" />
                    </td>
                  </tr>
                  {expandedGames[g.n] && (
                    <tr className="border-t border-zinc-800/50 bg-zinc-950/50">
                      <td colSpan={9} className="px-4 py-3">
                        <BreakdownPanel n={g.n} team1={team1} team2={team2} breakdown={g.breakdown} params={params} />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                )})}
              </tbody>
            </table>

            {bestOf > 1 && (() => {
              const sk = (seriesMarketT1 != null)
                ? halfKelly(predictions.p_series_t1, seriesMarketT1, bankroll)
                : null
              return (
                <div className="mt-4 pt-4 border-t border-zinc-800 space-y-3">
                  <div className="flex items-baseline gap-6 flex-wrap">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Series ({predictions.t1_wins}–{predictions.t2_wins})</div>
                      <div className="text-3xl font-mono">
                        <span className="text-emerald-400">{(predictions.p_series_t1 * 100).toFixed(1)}%</span>
                        <span className="text-zinc-500 mx-3">·</span>
                        <span className="text-rose-400">{((1 - predictions.p_series_t1) * 100).toFixed(1)}%</span>
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">{team1} · {team2}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Market p({team1}) — series</div>
                      <input type="number" step={0.01} min={0} max={1}
                        value={seriesMarketT1 ?? ''}
                        onChange={e => setSeriesMarketT1(e.target.value === '' ? null : parseFloat(e.target.value))}
                        className="w-24 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm font-mono text-right"
                        placeholder="0.55" />
                    </div>
                    {sk && (
                      <div className="text-xs font-mono">
                        <div className="text-[11px] uppercase tracking-wide text-zinc-500">½-Kelly bet</div>
                        <div className="mt-1">
                          <span className={sk.side === 't1' ? 'text-blue-400' : 'text-rose-400'}>
                            {sk.side === 't1' ? team1 : team2}
                          </span>{' '}
                          <span className="text-zinc-200">{(sk.fraction * 100).toFixed(2)}%</span>{' '}
                          <span className="text-zinc-500">(${sk.stake.toFixed(0)})</span>
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          edge {sk.edge_pp >= 0 ? '+' : ''}{sk.edge_pp.toFixed(2)}pp @ ${sk.price.toFixed(3)}
                        </div>
                        <div className="mt-1">
                          <span className={sk.side === 't1' ? 'text-emerald-400' : 'text-rose-400'}>
                            {sk.side === 't1' ? `+$${sk.payoff_win.toFixed(2)}` : `-$${(-sk.loss_lose).toFixed(2)}`}
                          </span>
                          {' / '}
                          <span className={sk.side === 't2' ? 'text-emerald-400' : 'text-rose-400'}>
                            {sk.side === 't2' ? `+$${sk.payoff_win.toFixed(2)}` : `-$${(-sk.loss_lose).toFixed(2)}`}
                          </span>
                          <span className="text-[10px] text-zinc-500 ml-1">({team1} wins / {team2} wins)</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        )}

        {/* Pick tendencies table (2026 only) */}
        {picks && (picks.teams[team1] || picks.teams[team2]) && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <h2 className="text-lg font-semibold mb-1">Pick tendencies <span className="text-xs text-zinc-500 font-normal">(2026 only)</span></h2>
            <div className="text-[11px] text-zinc-500 mb-3">
              Behavior when this team has draft choice (after losing a previous game in series) and when they enter G1 as the ELO favorite.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TendencyCard team={team1} stats={picks.teams[team1]} color="blue" />
              <TendencyCard team={team2} stats={picks.teams[team2]} color="red" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TendencyCard({ team, stats, color }: {
  team: string
  stats?: TeamPickTendencies
  color: 'blue' | 'red'
}) {
  const colorCls = color === 'blue' ? 'text-blue-400' : 'text-rose-400'
  if (!stats) {
    return (
      <div className="bg-zinc-950 border border-zinc-800 rounded p-3">
        <h3 className={`text-sm font-semibold ${colorCls}`}>{team}</h3>
        <div className="text-xs text-zinc-500 mt-2">No 2026 data</div>
      </div>
    )
  }
  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded p-3 text-xs">
      <h3 className={`text-sm font-semibold ${colorCls} mb-2`}>{team}</h3>
      <TendencyBlock title="After a loss (had draft choice)" stats={stats.after_loss} />
      <TendencyBlock title="As G1 favorite (ELO advantage)"  stats={stats.as_g1_favorite} />
    </div>
  )
}

function TendencyBlock({ title, stats }: { title: string; stats: PickStats }) {
  if (stats.total === 0) {
    return (
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{title}</div>
        <div className="text-zinc-600">no data</div>
      </div>
    )
  }
  const pct = (p: number, n: number) => `${(p * 100).toFixed(0)}% (${n})`
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{title} <span className="text-zinc-600">n={stats.total}</span></div>
      <div className="grid grid-cols-[64px_1fr_1fr] gap-2 font-mono">
        <span className="text-zinc-500">side</span>
        <span><span className="text-blue-400">blue</span> {pct(stats.side!.blue.pct, stats.side!.blue.n)}</span>
        <span><span className="text-rose-400">red</span>  {pct(stats.side!.red.pct,  stats.side!.red.n)}</span>
        <span className="text-zinc-500">pick</span>
        <span><span className="text-zinc-300">1st</span> {pct(stats.pick!.first.pct, stats.pick!.first.n)}</span>
        <span><span className="text-zinc-300">2nd</span> {pct(stats.pick!.second.pct, stats.pick!.second.n)}</span>
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

function BreakdownPanel({ n, team1, team2, breakdown, params }: {
  n:         number
  team1:     string
  team2:     string
  breakdown: {
    p_t1: number; z_final: number; side: 'blue_t1' | 'blue_t2' | 'sym'
    game_in_series: number; draft_advantage: number
    s1: { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null }
    s2: { elo: number | null; rwr: number | null; gd15: number | null; outperf: number | null }
    rawFeats: Record<string, number>
    contributions: Array<{ name: string; raw: number; scaled: number; contribution: number }>
    intercept_used: number; po_adj_net: number; coaching_adj_net: number
    g2_alpha_shrink: number | null; g2_beta_term: number | null
    z_before_adj: number; z_after_adj: number
  }
  params: ModelParams
}) {
  const fmt  = (v: number, d = 4) => v.toFixed(d)
  const sign = (v: number, d = 4) => (v >= 0 ? '+' : '') + v.toFixed(d)
  const sideLabel =
    breakdown.side === 'sym'     ? '(symmetric — no side)' :
    breakdown.side === 'blue_t1' ? `(${team1} blue · ${team2} red)` :
                                   `(${team2} blue · ${team1} red)`
  return (
    <div className="text-xs space-y-3">
      <div>
        <div className="text-zinc-500 uppercase tracking-wide mb-1">Context flags</div>
        <div className="font-mono text-zinc-300 flex gap-4">
          <span><span className="text-zinc-500">game_in_series:</span> {breakdown.game_in_series}</span>
          <span><span className="text-zinc-500">draft_advantage:</span>{' '}
            <span className={breakdown.draft_advantage > 0 ? 'text-emerald-400' : breakdown.draft_advantage < 0 ? 'text-rose-400' : ''}>
              {breakdown.draft_advantage > 0 ? '+1' : breakdown.draft_advantage < 0 ? '-1' : '0'}
            </span>
            <span className="text-zinc-600">
              {' '}({breakdown.draft_advantage === 0 ? 'G1 / unknown' : breakdown.draft_advantage > 0 ? `${team1} lost prev — picks blue` : `${team2} lost prev — picks blue`})
            </span>
          </span>
        </div>
      </div>

      <div>
        <div className="text-zinc-500 uppercase tracking-wide mb-1">G{n} inputs {sideLabel}</div>
        <div className="grid grid-cols-2 gap-x-4">
          <div className="border-l-2 border-blue-900/60 pl-2">
            <div className="text-blue-400 font-semibold">{team1}</div>
            <div className="font-mono text-zinc-300">
              elo {breakdown.s1.elo?.toFixed(0) ?? '—'} ·
              rwr {breakdown.s1.rwr?.toFixed(2) ?? '—'} ·
              gd15 {breakdown.s1.gd15?.toFixed(0) ?? '—'} ·
              outperf {breakdown.s1.outperf?.toFixed(3) ?? '—'}
            </div>
          </div>
          <div className="border-l-2 border-rose-900/60 pl-2">
            <div className="text-rose-400 font-semibold">{team2}</div>
            <div className="font-mono text-zinc-300">
              elo {breakdown.s2.elo?.toFixed(0) ?? '—'} ·
              rwr {breakdown.s2.rwr?.toFixed(2) ?? '—'} ·
              gd15 {breakdown.s2.gd15?.toFixed(0) ?? '—'} ·
              outperf {breakdown.s2.outperf?.toFixed(3) ?? '—'}
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="text-zinc-500 uppercase tracking-wide mb-1">Per-feature contribution to z ({team1} perspective)</div>
        <table className="font-mono text-zinc-300">
          <thead>
            <tr className="text-[10px] text-zinc-500">
              <th className="text-left pr-3">feature</th>
              <th className="text-right pr-3">raw diff</th>
              <th className="text-right pr-3">scaled</th>
              <th className="text-right pr-3">× coef</th>
              <th className="text-right pr-3">contribution</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.contributions.map((c, i) => (
              <tr key={c.name}>
                <td className="pr-3 text-zinc-400">{c.name}</td>
                <td className="text-right pr-3">{sign(c.raw, 3)}</td>
                <td className="text-right pr-3">{sign(c.scaled, 3)}</td>
                <td className="text-right pr-3 text-zinc-500">{sign(params.coef[i], 3)}</td>
                <td className={`text-right pr-3 ${c.contribution >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{sign(c.contribution, 4)}</td>
              </tr>
            ))}
            {breakdown.intercept_used !== 0 && (
              <tr className="border-t border-zinc-800/60">
                <td className="pr-3 text-zinc-400">intercept</td>
                <td className="text-right pr-3">—</td>
                <td className="text-right pr-3">—</td>
                <td className="text-right pr-3">—</td>
                <td className={`text-right pr-3 ${breakdown.intercept_used >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{sign(breakdown.intercept_used, 4)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-zinc-800/60 pt-2 font-mono space-y-0.5">
        <div className="flex justify-between">
          <span className="text-zinc-400">z from features {breakdown.intercept_used !== 0 ? '+ intercept' : '(symmetric, no intercept)'}:</span>
          <span className="text-zinc-200">{sign(breakdown.z_before_adj)}</span>
        </div>
        {breakdown.po_adj_net !== 0 && (
          <div className="flex justify-between">
            <span className="text-zinc-400">+ playoff team adj ({team1} − {team2}):</span>
            <span className={breakdown.po_adj_net >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{sign(breakdown.po_adj_net)}</span>
          </div>
        )}
        {breakdown.coaching_adj_net !== 0 && (
          <div className="flex justify-between">
            <span className="text-zinc-400">+ coaching adj ({team1} − {team2}):</span>
            <span className={breakdown.coaching_adj_net >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{sign(breakdown.coaching_adj_net)}</span>
          </div>
        )}
        {(breakdown.po_adj_net !== 0 || breakdown.coaching_adj_net !== 0) && (
          <div className="flex justify-between">
            <span className="text-zinc-400">z after team adjustments:</span>
            <span className="text-zinc-200">{sign(breakdown.z_after_adj)}</span>
          </div>
        )}
        {breakdown.g2_alpha_shrink != null && (
          <div className="text-zinc-500 italic text-[11px]">
            G2 shrink: z_G2 = {fmt(breakdown.g2_alpha_shrink, 3)} × z + {sign(breakdown.g2_beta_term ?? 0, 4)} (β·draft_adv)
          </div>
        )}
        <div className="flex justify-between border-t border-zinc-800/60 pt-1 mt-1">
          <span className="text-zinc-400">Final z:</span>
          <span className="text-zinc-100">{sign(breakdown.z_final)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">sigmoid(z) = P({team1}):</span>
          <span className="text-emerald-400">{(breakdown.p_t1 * 100).toFixed(2)}%</span>
        </div>
      </div>
    </div>
  )
}

function RosterPanel({
  color, team, roster, oppRoster, playerOptions, playerElos, params,
  defaultRoster, teamRwr, teamGd15, eloAdj, onEloAdjChange, onChange, cleared, isOverride,
}: {
  color:          'blue' | 'red'
  team:           string
  roster:         string[]
  oppRoster:      string[]
  playerOptions:  string[]
  playerElos:     Record<string, number>
  params:         ModelParams
  defaultRoster:  string[]                              // baseline (no overrides applied) — to flag subs
  teamRwr:        number | null                         // rolling-10 win rate (matches model feature)
  teamGd15:       number | null                         // rolling-5 per-lane avg (matches model feature)
  eloAdj:         number                                // manual ELO adjustment (added to base)
  onEloAdjChange: (v: number) => void
  onChange:       (r: string[]) => void
  cleared:        () => void
  isOverride:     boolean
}) {
  const POS = ['Top', 'Jng', 'Mid', 'Bot', 'Sup']
  const POS_LOWER = ['top', 'jng', 'mid', 'bot', 'sup'] as const
  const colorCls = color === 'blue' ? 'text-blue-400' : 'text-rose-400'
  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className={`text-sm font-semibold ${colorCls}`}>{team}</h3>
        {isOverride && <button onClick={cleared} className="text-[10px] text-zinc-500 hover:text-zinc-300">Reset roster</button>}
      </div>
      <div className="flex gap-4 mb-2 text-[11px]" title="Team-level features going into the prediction. Rwr = rolling win rate over last 10 games. GD15 = mean of 5 players' rolling-5 per-lane gold diff at 15 min.">
        <div>
          <span className="text-zinc-500 uppercase tracking-wide">WR (last 10):</span>{' '}
          <span className="font-mono text-zinc-200">{teamRwr != null ? `${(teamRwr * 100).toFixed(0)}%` : '—'}</span>
        </div>
        <div>
          <span className="text-zinc-500 uppercase tracking-wide">GD15:</span>{' '}
          <span className={`font-mono ${teamGd15 == null ? 'text-zinc-200' : teamGd15 > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {teamGd15 != null ? `${teamGd15 >= 0 ? '+' : ''}${teamGd15.toFixed(0)}` : '—'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3 text-[11px]" title="Manual ad-hoc ELO adjustment for this team. Added to the snapshot/roster ELO. Use to express 'I think this team is X ELO points stronger than the model says'.">
        <span className="text-zinc-500 uppercase tracking-wide">ELO adj:</span>
        <input type="range" min={-200} max={200} step={10}
          value={eloAdj}
          onChange={e => onEloAdjChange(parseInt(e.target.value))}
          className="flex-1 accent-emerald-500" />
        <input type="number" step={5}
          value={eloAdj}
          onChange={e => onEloAdjChange(parseInt(e.target.value) || 0)}
          className="w-16 bg-zinc-950 border border-zinc-800 rounded px-1 py-0.5 font-mono text-right" />
        {eloAdj !== 0 && (
          <button onClick={() => onEloAdjChange(0)} className="text-zinc-500 hover:text-zinc-300">↺</button>
        )}
      </div>
      <div className="space-y-1.5">
        {POS.map((pos, i) => {
          const p     = roster[i] ?? ''
          const oppP  = oppRoster[i] ?? ''
          const elo   = p ? playerElos[p] : null
          const h2h   = getPlayerH2H(params, p, oppP, POS_LOWER[i])
          const isSub = p !== '' && defaultRoster[i] !== '' && p !== defaultRoster[i]
          const h2hCls = h2h == null      ? 'text-zinc-600'
                       : h2h.n < 5        ? 'text-zinc-500 italic'
                       : h2h.wr >= 0.55   ? 'text-emerald-400'
                       : h2h.wr <= 0.45   ? 'text-rose-400'
                       :                    'text-zinc-300'
          return (
            <div key={pos} className="grid grid-cols-[40px_1fr_auto_60px] gap-2 items-center text-xs">
              <span className="text-zinc-500">{pos}</span>
              <div className="relative">
                <select value={p}
                  onChange={e => { const r = [...roster]; r[i] = e.target.value; onChange(r) }}
                  className={`w-full bg-zinc-950 border border-zinc-800 rounded px-1 py-0.5 ${isSub ? 'text-purple-300' : ''}`}>
                  <option value="">—</option>
                  {playerOptions.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {isSub && <span className="absolute -top-2 -right-2 text-[8px] text-purple-400 bg-zinc-900 px-1 rounded">SUB</span>}
              </div>
              <span className={`font-mono text-[10px] ${h2hCls}`}
                    title={h2h ? `H2H vs ${oppP}: ${(h2h.wr*100).toFixed(0)}% over ${h2h.n} games` : `No H2H data vs ${oppP || '—'}`}>
                {h2h ? `${(h2h.wr * 100).toFixed(0)}% (${h2h.n})` : '—'}
              </span>
              <span className="font-mono text-zinc-400 text-right">{elo != null ? elo.toFixed(0) : '—'}</span>
            </div>
          )
        })}
      </div>
      <div className="text-[10px] text-zinc-600 mt-2 flex justify-between">
        <span>Team ELO (mean): {(roster.length > 0 ? roster.reduce((sum, p) => sum + (playerElos[p] ?? 0), 0) / roster.length : 0).toFixed(0)}</span>
        <span className="text-zinc-700">role / player / H2H vs opp / ELO</span>
      </div>
    </div>
  )
}
