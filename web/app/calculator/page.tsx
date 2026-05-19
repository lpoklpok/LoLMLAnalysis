'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

// ---------- types ----------

interface TeamStats {
  league:       string
  elo:          number | null
  rwr:          number | null
  gd15:         number | null
  outperf:      number | null
  po_adj:       number
  coaching_adj: number
}

interface ModelParams {
  generated: string
  features:  string[]
  fill:      Record<string, number>
  scaler:    { mean: number[]; scale: number[] }
  coef:      number[]
  alpha_g2:  number
  beta_da:   number
  teams:     Record<string, TeamStats>
  h2h:       Record<string, number>
}

interface GameProbs {
  g1:        number
  g2_t1won:  number
  g2_t2won:  number
  g2_avg:    number
  g3plus:    number
}

// ---------- math helpers ----------

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

function getH2H(params: ModelParams, t1: string, t2: string): number {
  const key1 = `${t1}|||${t2}`
  const key2 = `${t2}|||${t1}`
  if (params.h2h[key1] !== undefined) return params.h2h[key1]
  if (params.h2h[key2] !== undefined) return 1 - params.h2h[key2]
  return params.fill['h2h_wr'] ?? 0.5
}

function computeGameProbs(
  params: ModelParams,
  t1: string,
  t2: string,
  playoffs: boolean,
): GameProbs | null {
  const s1 = params.teams[t1]
  const s2 = params.teams[t2]
  if (!s1 || !s2) return null

  const fill = params.fill
  const mean  = params.scaler.mean
  const scale = params.scaler.scale
  const coef  = params.coef

  const raw: Record<string, number> = {
    elo_diff:     (s1.elo     ?? 0) - (s2.elo     ?? 0),
    rwr_diff:     s1.rwr !== null && s2.rwr !== null
                    ? s1.rwr - s2.rwr
                    : fill['rwr_diff'],
    h2h_wr:       getH2H(params, t1, t2),
    playoffs:     playoffs ? 1 : 0,
    gd15_diff:    s1.gd15 !== null && s2.gd15 !== null
                    ? s1.gd15 - s2.gd15
                    : fill['gd15_diff'],
    outperf_diff: s1.outperf !== null && s2.outperf !== null
                    ? s1.outperf - s2.outperf
                    : fill['outperf_diff'],
  }

  const feats = params.features
  // scaled dot product (no intercept — side-neutral)
  let z_base = 0
  for (let i = 0; i < feats.length; i++) {
    const v = (raw[feats[i]] - mean[i]) / scale[i]
    z_base += v * coef[i]
  }

  const po_net       = playoffs ? (s1.po_adj - s2.po_adj) : 0
  const coaching_net = s1.coaching_adj - s2.coaching_adj
  const z_adj        = z_base + po_net + coaching_net

  const g1       = sigmoid(z_adj)
  const alpha    = params.alpha_g2
  const beta     = params.beta_da
  // draft_advantage = -1 when t1 won prev game (t1 disadvantaged), +1 when t1 lost
  const g2_t1won = sigmoid(alpha * z_adj + beta * (-1))  // t1 won G1 → t2 gets draft
  const g2_t2won = sigmoid(alpha * z_adj + beta * (+1))  // t2 won G1 → t1 gets draft
  const g2_avg   = g1 * g2_t1won + (1 - g1) * g2_t2won
  const g3plus   = g1

  return { g1, g2_t1won, g2_t2won, g2_avg, g3plus }
}

// Enumerate all paths for a best-of series
// Returns P(t1 wins series) and path details
function seriesWinProb(gp: GameProbs, bestOf: number): number {
  const needed = Math.ceil(bestOf / 2)

  // DP over (t1_wins, t2_wins) states
  // State: [t1w][t2w] = probability of reaching this state
  // p(game i | state) depends on game number and who won prev game
  // We track: (t1_wins, t2_wins, prev_winner: 't1'|'t2') → prob

  // For simplicity, iterate over all complete paths via recursion
  function prob(t1w: number, t2w: number, prevWinner: 't1' | 't2' | null): number {
    if (t1w === needed) return 1
    if (t2w === needed) return 0

    const gameNum = t1w + t2w + 1
    let p: number

    if (gameNum === 1) {
      p = gp.g1
    } else if (gameNum === 2) {
      p = prevWinner === 't1' ? gp.g2_t1won : gp.g2_t2won
    } else {
      p = gp.g3plus
    }

    return p * prob(t1w + 1, t2w, 't1') + (1 - p) * prob(t1w, t2w + 1, 't2')
  }

  return prob(0, 0, null)
}

// Get breakdown of each possible game probability in the series
function buildGameBreakdown(gp: GameProbs, bestOf: number): { game: number; prob: number; label: string }[] {
  const needed = Math.ceil(bestOf / 2)

  // For each game slot g=1..bestOf, compute the marginal probability that
  // (a) the series reaches game g, and (b) t1 wins game g
  // We compute E[t1 wins game g] marginalised over all paths

  // Track (t1w, t2w, prevWinner) → prob of reaching this state
  type State = { t1w: number; t2w: number; prev: 't1' | 't2' | null }

  // game breakdown: [marginal p(t1 wins game g | game g is played)]
  const breakdown: { game: number; prob: number; label: string }[] = []

  // BFS/DP
  let states = new Map<string, number>()
  const stateKey = (s: State) => `${s.t1w},${s.t2w},${s.prev}`
  states.set(stateKey({ t1w: 0, t2w: 0, prev: null }), 1.0)

  for (let g = 1; g <= bestOf; g++) {
    let pReach = 0
    let pT1WinsGame = 0

    const nextStates = new Map<string, number>()

    for (const [key, stateProb] of states) {
      const parts = key.split(',')
      const t1w = parseInt(parts[0])
      const t2w = parseInt(parts[1])
      const prev = parts[2] === 'null' ? null : parts[2] as 't1' | 't2'

      if (t1w === needed || t2w === needed) continue // series already over

      pReach += stateProb

      let p: number
      if (g === 1) {
        p = gp.g1
      } else if (g === 2) {
        p = prev === 't1' ? gp.g2_t1won : gp.g2_t2won
      } else {
        p = gp.g3plus
      }

      pT1WinsGame += stateProb * p

      // Advance states
      const k1 = stateKey({ t1w: t1w + 1, t2w, prev: 't1' })
      nextStates.set(k1, (nextStates.get(k1) ?? 0) + stateProb * p)
      const k2 = stateKey({ t1w, t2w: t2w + 1, prev: 't2' })
      nextStates.set(k2, (nextStates.get(k2) ?? 0) + stateProb * (1 - p))
    }

    if (pReach > 0.001) {
      breakdown.push({
        game: g,
        prob: pT1WinsGame / pReach, // conditional on game being played
        label: `Game ${g}`,
      })
    }

    states = nextStates
  }

  return breakdown
}

// Probability of each exact series score (e.g. 3-0, 3-1, 3-2 for BO5)
function seriesScoreProbs(gp: GameProbs, bestOf: number): { score: string; prob: number }[] {
  const needed = Math.ceil(bestOf / 2)

  function enumerate(t1w: number, t2w: number, prev: 't1' | 't2' | null, cumProb: number): { score: string; prob: number }[] {
    if (t1w === needed) return [{ score: `${t1w}-${t2w}`, prob: cumProb }]
    if (t2w === needed) return [{ score: `${t2w}-${t1w} (T2)`, prob: cumProb }]

    const g = t1w + t2w + 1
    let p: number
    if (g === 1) p = gp.g1
    else if (g === 2) p = prev === 't1' ? gp.g2_t1won : gp.g2_t2won
    else p = gp.g3plus

    return [
      ...enumerate(t1w + 1, t2w, 't1', cumProb * p),
      ...enumerate(t1w, t2w + 1, 't2', cumProb * (1 - p)),
    ]
  }

  // Aggregate same scores
  const paths = enumerate(0, 0, null, 1)
  const byScore: Record<string, number> = {}
  for (const { score, prob } of paths) {
    byScore[score] = (byScore[score] ?? 0) + prob
  }
  return Object.entries(byScore)
    .map(([score, prob]) => ({ score, prob }))
    .sort((a, b) => b.prob - a.prob)
}

// ---------- Kelly helpers ----------

interface KellyResult {
  side:         string   // 'team1' | 'team2' | 'no edge'
  edge:         number
  odds:         number   // decimal odds for bet side
  raw_kelly:    number
  half_kelly:   number
  quarter_kelly: number
  bet_half:     number   // dollar amount at half Kelly
  bet_quarter:  number
}

function computeKelly(modelP: number, marketQ: number, bankroll: number): KellyResult {
  const edge1 = modelP - marketQ          // edge betting team 1
  const edge2 = (1 - modelP) - (1 - marketQ)  // edge betting team 2

  let side: string, edge: number, mp: number
  if (edge1 >= edge2 && edge1 > 0) {
    side = 'team1'; edge = edge1; mp = marketQ
  } else if (edge2 > 0) {
    side = 'team2'; edge = edge2; mp = 1 - marketQ
  } else {
    return { side: 'no edge', edge: Math.max(edge1, edge2), odds: 0,
             raw_kelly: 0, half_kelly: 0, quarter_kelly: 0, bet_half: 0, bet_quarter: 0 }
  }

  const odds       = (1 - mp) / mp
  const raw_kelly  = edge / (1 - mp)
  const half_kelly  = Math.min(raw_kelly * 0.5,  0.20)
  const quarter_kelly = Math.min(raw_kelly * 0.25, 0.20)

  return {
    side, edge, odds, raw_kelly,
    half_kelly, quarter_kelly,
    bet_half:    half_kelly    * bankroll,
    bet_quarter: quarter_kelly * bankroll,
  }
}

// ---------- component ----------

const FORMAT_OPTIONS = ['BO1', 'BO3', 'BO5'] as const
type Format = typeof FORMAT_OPTIONS[number]

function pct(p: number, dec = 1): string {
  return `${(p * 100).toFixed(dec)}%`
}

function ProbBar({ p, label }: { p: number; label: string }) {
  const pct1 = (p * 100).toFixed(1)
  const pct2 = ((1 - p) * 100).toFixed(1)
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <span className="text-gray-500 text-xs">win probability</span>
      </div>
      <div className="flex rounded overflow-hidden h-7 text-sm font-semibold">
        <div
          className="flex items-center justify-end pr-2 transition-all duration-500"
          style={{ width: `${p * 100}%`, background: p >= 0.5 ? '#3b82f6' : '#6b7280', minWidth: p > 0.05 ? '2.5rem' : 0 }}
        >
          <span className="text-white text-xs">{pct1}%</span>
        </div>
        <div
          className="flex items-center justify-start pl-2 transition-all duration-500"
          style={{ width: `${(1-p)*100}%`, background: (1-p) >= 0.5 ? '#ef4444' : '#6b7280', minWidth: (1-p) > 0.05 ? '2.5rem' : 0 }}
        >
          <span className="text-white text-xs">{pct2}%</span>
        </div>
      </div>
    </div>
  )
}

export default function CalculatorPage() {
  const [params, setParams]     = useState<ModelParams | null>(null)
  const [team1, setTeam1]       = useState('')
  const [team2, setTeam2]       = useState('')
  const [format, setFormat]     = useState<Format>('BO3')
  const [playoffs, setPlayoffs] = useState(false)
  const [marketPct, setMarketPct] = useState('')   // market % for team1, e.g. "42.5"
  const [bankroll, setBankroll] = useState('10000')
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    fetch('/model_params.json')
      .then(r => r.json())
      .then((d: ModelParams) => {
        setParams(d)
        const teamNames = Object.keys(d.teams).sort()
        if (teamNames.length >= 2) {
          setTeam1(teamNames[0])
          setTeam2(teamNames[1])
        }
      })
      .catch(() => setError('Failed to load model parameters'))
  }, [])

  const teamNames = useMemo(
    () => params ? Object.keys(params.teams).sort() : [],
    [params]
  )

  const bestOf = format === 'BO1' ? 1 : format === 'BO3' ? 3 : 5

  const gameProbs = useMemo<GameProbs | null>(() => {
    if (!params || !team1 || !team2 || team1 === team2) return null
    return computeGameProbs(params, team1, team2, playoffs)
  }, [params, team1, team2, playoffs])

  const seriesProb = useMemo<number | null>(() => {
    if (!gameProbs) return null
    return seriesWinProb(gameProbs, bestOf)
  }, [gameProbs, bestOf])

  const gameBreakdown = useMemo(() => {
    if (!gameProbs) return []
    return buildGameBreakdown(gameProbs, bestOf)
  }, [gameProbs, bestOf])

  const scoreProbs = useMemo(() => {
    if (!gameProbs || bestOf === 1) return []
    return seriesScoreProbs(gameProbs, bestOf)
  }, [gameProbs, bestOf])

  const t1stats = params && team1 ? params.teams[team1] : null
  const t2stats = params && team2 ? params.teams[team2] : null

  const kellyResult = useMemo<KellyResult | null>(() => {
    if (seriesProb === null) return null
    const mq = parseFloat(marketPct) / 100
    if (isNaN(mq) || mq <= 0 || mq >= 1) return null
    const br = parseFloat(bankroll) || 10000
    return computeKelly(seriesProb, mq, br)
  }, [seriesProb, marketPct, bankroll])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-blue-400">Series Calculator</h1>
          <p className="text-sm text-gray-400 mt-1">Win probability & series outcome breakdown</p>
        </div>
        <nav className="flex gap-6 text-sm">
          <Link href="/"            className="text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
          <Link href="/predictions" className="text-gray-400 hover:text-gray-200 transition-colors">Predictions</Link>
          <Link href="/backtest"    className="text-gray-400 hover:text-gray-200 transition-colors">Backtest</Link>
          <Link href="/games"       className="text-gray-400 hover:text-gray-200 transition-colors">Game Explorer</Link>
          <Link href="/model"       className="text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        </nav>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {error && <p className="text-red-400">{error}</p>}
        {!params && !error && <p className="text-gray-400">Loading model…</p>}

        {params && (
          <>
            {/* Input panel */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-5">Match Setup</h2>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                {/* Team 1 */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Team 1</label>
                  <select
                    value={team1}
                    onChange={e => setTeam1(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {teamNames.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {t1stats && (
                    <p className="text-xs text-gray-500 mt-1">
                      {t1stats.league} · ELO {t1stats.elo?.toFixed(0) ?? '—'} · RWR {t1stats.rwr !== null ? pct(t1stats.rwr, 0) : '—'}
                    </p>
                  )}
                </div>

                {/* VS divider */}
                <div className="text-center text-gray-500 font-bold text-2xl hidden md:block pb-5">vs</div>

                {/* Team 2 */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Team 2</label>
                  <select
                    value={team2}
                    onChange={e => setTeam2(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {teamNames.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {t2stats && (
                    <p className="text-xs text-gray-500 mt-1">
                      {t2stats.league} · ELO {t2stats.elo?.toFixed(0) ?? '—'} · RWR {t2stats.rwr !== null ? pct(t2stats.rwr, 0) : '—'}
                    </p>
                  )}
                </div>
              </div>

              {/* Format + Playoffs */}
              <div className="mt-5 flex gap-6 flex-wrap items-center">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Format</label>
                  <div className="flex gap-2">
                    {FORMAT_OPTIONS.map(f => (
                      <button
                        key={f}
                        onClick={() => setFormat(f)}
                        className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          format === f
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-4">
                  <button
                    onClick={() => setPlayoffs(p => !p)}
                    className={`w-10 h-5 rounded-full transition-colors ${playoffs ? 'bg-blue-600' : 'bg-gray-700'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white mx-0.5 transition-transform ${playoffs ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                  <span className="text-sm text-gray-300">Playoffs</span>
                  {playoffs && (
                    <span className="text-xs text-gray-500">(applies playoff adjustments)</span>
                  )}
                </div>
              </div>

              {/* Kelly inputs */}
              <div className="mt-5 pt-5 border-t border-gray-800 flex gap-6 flex-wrap items-end">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">
                    Market % for {team1 || 'Team 1'} (series)
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="1" max="99" step="0.1"
                      placeholder="e.g. 42.5"
                      value={marketPct}
                      onChange={e => setMarketPct(e.target.value)}
                      className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-yellow-500"
                    />
                    <span className="text-gray-500 text-sm">%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Bankroll ($)</label>
                  <input
                    type="number"
                    min="1" step="100"
                    value={bankroll}
                    onChange={e => setBankroll(e.target.value)}
                    className="w-36 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-yellow-500"
                  />
                </div>
              </div>
            </div>

            {/* Results */}
            {gameProbs && seriesProb !== null && team1 !== team2 && (
              <>
                {/* Series win probability */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                  <h2 className="text-lg font-semibold text-gray-100 mb-2">
                    {format} Series Win Probability
                  </h2>
                  <p className="text-xs text-gray-500 mb-5">
                    Derived from all possible game paths · G2 applies {(params.alpha_g2 * 100).toFixed(0)}% shrinkage + draft-choice adjustment
                  </p>

                  <div className="flex items-center gap-4 mb-4">
                    <div className="text-center">
                      <div className="text-4xl font-bold text-blue-400">{pct(seriesProb, 1)}</div>
                      <div className="text-sm text-gray-400 mt-1">{team1}</div>
                    </div>
                    <div className="flex-1">
                      <ProbBar p={seriesProb} label="" />
                    </div>
                    <div className="text-center">
                      <div className="text-4xl font-bold text-red-400">{pct(1 - seriesProb, 1)}</div>
                      <div className="text-sm text-gray-400 mt-1">{team2}</div>
                    </div>
                  </div>
                </div>

                {/* Kelly recommendation */}
                {kellyResult && (
                  <div className={`rounded-xl border p-6 ${
                    kellyResult.side === 'no edge'
                      ? 'bg-gray-900 border-gray-700'
                      : 'bg-gray-900 border-yellow-700/50'
                  }`}>
                    <h2 className="text-lg font-semibold text-gray-100 mb-1">Kelly Criterion</h2>
                    <p className="text-xs text-gray-500 mb-5">
                      Model {pct(seriesProb!, 1)} vs market {pct(parseFloat(marketPct)/100, 1)} · half-Kelly capped at 20%
                    </p>

                    {kellyResult.side === 'no edge' ? (
                      <p className="text-gray-400 text-sm">
                        No edge — model favours the same side as the market or is very close.
                        Edge: {(kellyResult.edge * 100).toFixed(2)}%
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mb-5">
                          <span className="text-xs text-gray-400">Bet side:</span>
                          <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                            kellyResult.side === 'team1' ? 'bg-blue-900/50 text-blue-300' : 'bg-red-900/50 text-red-300'
                          }`}>
                            {kellyResult.side === 'team1' ? team1 : team2}
                          </span>
                          <span className="text-xs text-gray-500">
                            {pct(kellyResult.edge, 2)} edge · {kellyResult.odds.toFixed(3)}x decimal odds
                          </span>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {[
                            { label: 'Raw Kelly', frac: kellyResult.raw_kelly, amt: kellyResult.raw_kelly * (parseFloat(bankroll) || 10000) },
                            { label: 'Half Kelly', frac: kellyResult.half_kelly, amt: kellyResult.bet_half },
                            { label: 'Quarter Kelly', frac: kellyResult.quarter_kelly, amt: kellyResult.bet_quarter },
                            { label: 'Decimal Odds', frac: null, amt: null },
                          ].map(({ label, frac, amt }) =>
                            frac !== null ? (
                              <div key={label} className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">{label}</div>
                                <div className="text-yellow-300 font-bold text-lg">{pct(frac, 1)}</div>
                                <div className="text-gray-300 text-sm">${amt!.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                              </div>
                            ) : (
                              <div key={label} className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Decimal Odds</div>
                                <div className="text-white font-bold text-lg">{kellyResult.odds.toFixed(3)}x</div>
                                <div className="text-gray-400 text-xs">profit per $ staked</div>
                              </div>
                            )
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Per-game probabilities */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                  <h2 className="text-lg font-semibold text-gray-100 mb-1">
                    Per-Game Win Probability ({team1})
                  </h2>
                  <p className="text-xs text-gray-500 mb-5">
                    Conditional on that game being played · G2 probability averaged over both G1 outcomes
                  </p>

                  <div className="space-y-4">
                    {gameBreakdown.map(({ game, prob, label }) => (
                      <ProbBar key={game} p={prob} label={label} />
                    ))}
                  </div>

                  {bestOf >= 3 && (
                    <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-2 gap-3 text-sm">
                      <div className="bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-1">G2 if {team1} won G1</div>
                        <div className="text-white font-semibold">{pct(gameProbs.g2_t1won)}</div>
                        <div className="text-xs text-gray-500">Draft choice → {team2}</div>
                      </div>
                      <div className="bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-1">G2 if {team2} won G1</div>
                        <div className="text-white font-semibold">{pct(gameProbs.g2_t2won)}</div>
                        <div className="text-xs text-gray-500">Draft choice → {team1}</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Score distribution */}
                {bestOf > 1 && scoreProbs.length > 0 && (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                    <h2 className="text-lg font-semibold text-gray-100 mb-5">
                      Series Score Distribution
                    </h2>
                    <div className="space-y-2">
                      {scoreProbs.map(({ score, prob }) => {
                        const isT1 = !score.includes('(T2)')
                        const displayScore = score.replace(' (T2)', '')
                        return (
                          <div key={score} className="flex items-center gap-3">
                            <div className={`w-24 text-sm font-medium text-right ${isT1 ? 'text-blue-400' : 'text-red-400'}`}>
                              {isT1 ? team1 : team2}
                            </div>
                            <div className={`w-12 text-center text-xs font-mono px-2 py-0.5 rounded ${isT1 ? 'bg-blue-900/40 text-blue-300' : 'bg-red-900/40 text-red-300'}`}>
                              {displayScore}
                            </div>
                            <div className="flex-1 bg-gray-800 rounded h-5 overflow-hidden">
                              <div
                                className={`h-full rounded transition-all duration-500 ${isT1 ? 'bg-blue-600' : 'bg-red-600'}`}
                                style={{ width: `${prob * 100}%` }}
                              />
                            </div>
                            <div className="w-12 text-right text-sm text-gray-300 font-medium">
                              {pct(prob, 1)}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Feature breakdown */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                  <h2 className="text-lg font-semibold text-gray-100 mb-4">Feature Inputs</h2>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                    {[
                      { label: 'ELO diff', value: ((t1stats?.elo ?? 0) - (t2stats?.elo ?? 0)).toFixed(1) },
                      { label: 'RWR diff', value: (t1stats?.rwr !== null && t2stats?.rwr !== null)
                        ? ((t1stats!.rwr! - t2stats!.rwr!) * 100).toFixed(1) + '%'
                        : 'N/A (0)' },
                      { label: 'H2H WR (T1)', value: pct(getH2H(params, team1, team2), 1) },
                      { label: 'GD@15 diff', value: (t1stats?.gd15 !== null && t2stats?.gd15 !== null)
                        ? ((t1stats!.gd15! - t2stats!.gd15!)).toFixed(1) + 'g'
                        : 'N/A (0)' },
                      { label: 'Outperf diff', value: (t1stats?.outperf !== null && t2stats?.outperf !== null)
                        ? ((t1stats!.outperf! - t2stats!.outperf!)).toFixed(3)
                        : 'N/A (0)' },
                      { label: 'Playoff adj', value: playoffs
                        ? `${((t1stats?.po_adj ?? 0) - (t2stats?.po_adj ?? 0) > 0 ? '+' : '')}${((t1stats?.po_adj ?? 0) - (t2stats?.po_adj ?? 0)).toFixed(3)}`
                        : '—' },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-gray-800 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-0.5">{label}</div>
                        <div className="text-white font-medium">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {team1 === team2 && (
              <p className="text-yellow-400 text-sm">Select two different teams.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
