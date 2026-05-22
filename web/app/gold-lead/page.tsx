'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

interface ContinuousCoefs {
  fit_date:    string
  season:      number
  features:    string[]
  intercept:   number
  coef:        Record<string, number>
  usage:       string
}

interface DiscreteCoefs {
  fit_date: string
  season:   number
  checkpoints: Record<string, {
    intercept:        number
    pre_logit:        number
    gold_per_1k:      number
    gold_x_underdog:  number
    n_train:          number
  }>
}

// ---------- math ----------

function clip(p: number, eps = 1e-3): number { return Math.min(1 - eps, Math.max(eps, p)) }
function logit(p: number): number { const c = clip(p); return Math.log(c / (1 - c)) }
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)) }

function predictContinuous(
  coefs: ContinuousCoefs,
  preProb: number,
  goldLead: number,
  minutes: number,
): number {
  const pl = logit(preProb)
  const g  = goldLead / 1000
  const feats: Record<string, number> = {
    pre_logit:           pl,
    gold_k:              g,
    minutes:             minutes,
    gold_x_minutes:      g * minutes,
    pre_x_minutes:       pl * minutes,
    gold_x_underdog:     g * (1 - preProb),
    gold_x_underdog_x_t: g * (1 - preProb) * minutes,
    gold_sq:             g * g,
  }
  let z = coefs.intercept
  for (const k of coefs.features) z += coefs.coef[k] * (feats[k] ?? 0)
  return sigmoid(z)
}

function effectiveCoefAt(coefs: ContinuousCoefs, t: number): {
  pre_logit:        number
  gold_k:           number
  gold_x_underdog:  number
  intercept:        number
} {
  const c = coefs.coef
  return {
    intercept:       coefs.intercept + c.minutes * t,
    pre_logit:       c.pre_logit + c.pre_x_minutes * t,
    gold_k:          c.gold_k + c.gold_x_minutes * t,
    gold_x_underdog: c.gold_x_underdog + c.gold_x_underdog_x_t * t,
  }
}

// ---------- precomputed performance ----------
// From the 5-fold GroupKFold fit on 2026 (logged in chat — saving as constants
// for display; rerun src/fit_live_wr.py to regenerate if data changes).

const PERF = {
  rows:    13848,
  games:   4619,
  blueRate: 0.527,
  preGame:  { ll: 0.6098, brier: 0.2111 },
  train:    { ll: 0.4718, brier: 0.1565 },
  test:     { ll: 0.4731, brier: 0.1569 },
  perCheckpoint: [
    { t: 10, ll_pre: 0.6095, ll_train: 0.5246, ll_test: 0.5257, brier_continuous: 0.1771, brier_discrete: 0.1770 },
    { t: 15, ll_pre: 0.6095, ll_train: 0.4779, ll_test: 0.4792, brier_continuous: 0.1588, brier_discrete: 0.1585 },
    { t: 20, ll_pre: 0.6103, ll_train: 0.4127, ll_test: 0.4144, brier_continuous: 0.1348, brier_discrete: 0.1346 },
  ],
}

// ---------- UI bits ----------

function pct(p: number, d = 1): string { return `${(p * 100).toFixed(d)}%` }
function fmt(x: number, d = 4): string { return (x >= 0 ? '+' : '') + x.toFixed(d) }

function StatCard({ label, value, sub, valueColor = 'text-white' }: {
  label: string; value: string; sub?: string; valueColor?: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-bold ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function Panel({ title, description, children }: {
  title: string; description?: string; children: React.ReactNode
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">{title}</h2>
      {description && <p className="text-xs text-gray-500 mb-5">{description}</p>}
      {children}
    </div>
  )
}

function ProbBar({ p }: { p: number }) {
  const a = (p * 100).toFixed(1)
  const b = ((1 - p) * 100).toFixed(1)
  return (
    <div className="flex rounded overflow-hidden h-7 text-sm font-semibold">
      <div
        className="flex items-center justify-end pr-2 transition-all duration-500"
        style={{ width: `${p * 100}%`, background: p >= 0.5 ? '#3b82f6' : '#6b7280', minWidth: p > 0.05 ? '2.5rem' : 0 }}
      >
        <span className="text-white text-xs">{a}%</span>
      </div>
      <div
        className="flex items-center justify-start pl-2 transition-all duration-500"
        style={{ width: `${(1 - p) * 100}%`, background: (1 - p) >= 0.5 ? '#ef4444' : '#6b7280', minWidth: (1 - p) > 0.05 ? '2.5rem' : 0 }}
      >
        <span className="text-white text-xs">{b}%</span>
      </div>
    </div>
  )
}

// Color a probability cell on a blue-gray-red scale.
function probBg(p: number): string {
  if (p >= 0.85) return 'bg-blue-700/70'
  if (p >= 0.70) return 'bg-blue-600/50'
  if (p >= 0.58) return 'bg-blue-500/30'
  if (p >= 0.42) return 'bg-gray-700/40'
  if (p >= 0.30) return 'bg-red-500/30'
  if (p >= 0.15) return 'bg-red-600/50'
  return 'bg-red-700/70'
}

// ---------- page ----------

export default function GoldLeadPage() {
  const [continuous, setContinuous] = useState<ContinuousCoefs | null>(null)
  const [discrete,   setDiscrete]   = useState<DiscreteCoefs | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Calculator state
  const [preProb,  setPreProb]  = useState(60)    // % (team-1 pre-game)
  const [goldLead, setGoldLead] = useState(2000)  // gold (signed)
  const [minutes,  setMinutes]  = useState(15)

  useEffect(() => {
    Promise.all([
      fetch('/live_wr_continuous.json').then(r => r.json()),
      fetch('/live_wr_coeffs.json').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([c, d]) => { setContinuous(c); setDiscrete(d) })
      .catch(() => setErr('Failed to load live-WR coefficients'))
  }, [])

  const live = useMemo(() => {
    if (!continuous) return null
    return predictContinuous(continuous, preProb / 100, goldLead, minutes)
  }, [continuous, preProb, goldLead, minutes])

  // Sample-prediction heatmap: rows = minute, cols = gold lead.
  const sampleGrid = useMemo(() => {
    if (!continuous) return null
    const golds = [-5000, -3000, -1500, 0, 1500, 3000, 5000]
    const mins  = [10, 12, 14, 16, 18, 20, 22, 25, 30]
    return {
      golds,
      mins,
      cells: mins.map(t => golds.map(g => predictContinuous(continuous, preProb / 100, g, t))),
    }
  }, [continuous, preProb])

  // Effective coefficients at each minute (showing how pre-game info decays).
  const effRows = useMemo(() => {
    if (!continuous) return []
    return [10, 12, 15, 18, 20, 25].map(t => ({ t, ...effectiveCoefAt(continuous, t) }))
  }, [continuous])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-amber-400">Gold Lead — Live Win-Rate Model</h1>
          <p className="text-sm text-gray-400 mt-1">
            Continuous-time logistic regression scoring any minute of an in-progress game
            {continuous && <span className="text-gray-600 ml-2">· fit {continuous.fit_date}, season {continuous.season}</span>}
          </p>
        </div>
        <nav className="flex gap-5 text-sm">
          <Link href="/"            className="text-gray-400 hover:text-gray-200 transition-colors">Home</Link>
          <Link href="/model"       className="text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
          <Link href="/findings"    className="text-gray-400 hover:text-gray-200 transition-colors">Findings</Link>
          <Link href="/calculator"  className="text-gray-400 hover:text-gray-200 transition-colors">Calculator</Link>
        </nav>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {err && <p className="text-red-400">{err}</p>}
        {!continuous && !err && <p className="text-gray-400">Loading coefficients…</p>}

        {continuous && (
          <>
            {/* Headline stats */}
            <div>
              <h2 className="text-lg font-bold text-white mb-1">Performance (5-fold GroupKFold by gameid)</h2>
              <p className="text-sm text-gray-400 mb-5">
                Trained on {PERF.rows.toLocaleString()} rows ({PERF.games.toLocaleString()} unique games × 3 checkpoints).
                Each game's three rows always co-fold so the model never sees its own outcome at 10m to predict 15m.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Pre-game baseline" value={PERF.preGame.ll.toFixed(4)} sub={`Brier ${PERF.preGame.brier.toFixed(4)}`} valueColor="text-gray-300" />
                <StatCard label="Continuous (train)"  value={PERF.train.ll.toFixed(4)} sub={`Brier ${PERF.train.brier.toFixed(4)}`} valueColor="text-amber-300" />
                <StatCard label="Continuous (test/OOF)" value={PERF.test.ll.toFixed(4)} sub={`Brier ${PERF.test.brier.toFixed(4)}`} valueColor="text-amber-400" />
                <StatCard label="Gold lift over pre-game" value={`−${(PERF.preGame.ll - PERF.test.ll).toFixed(4)}`} sub={`${((PERF.preGame.ll - PERF.test.ll) / PERF.preGame.ll * 100).toFixed(1)}% log-loss reduction`} valueColor="text-green-400" />
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Train↔test gap is +{(PERF.test.ll - PERF.train.ll).toFixed(4)} log loss (~{((PERF.test.ll - PERF.train.ll) / PERF.train.ll * 100).toFixed(1)}%) — essentially zero overfit with 8 features on 13.8k rows.
              </p>
            </div>

            {/* Per-checkpoint comparison */}
            <Panel
              title="Per-checkpoint log loss"
              description="At the three observed minutes, the continuous model is within ±0.0003 Brier of three independent discrete models. Trade-off: one shared model that also works at 11m, 13m, 17m, etc."
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 border-b border-gray-800">
                      <th className="text-left  px-2 py-2">Minute</th>
                      <th className="text-right px-2 py-2">Pre-game LL</th>
                      <th className="text-right px-2 py-2">Continuous (train) LL</th>
                      <th className="text-right px-2 py-2">Continuous (test) LL</th>
                      <th className="text-right px-2 py-2">Continuous Brier</th>
                      <th className="text-right px-2 py-2">Discrete-model Brier</th>
                      <th className="text-right px-2 py-2">Δ Brier</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-200">
                    {PERF.perCheckpoint.map(r => (
                      <tr key={r.t} className="border-b border-gray-800/70">
                        <td className="px-2 py-2 font-medium">{r.t} min</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-400">{r.ll_pre.toFixed(4)}</td>
                        <td className="px-2 py-2 text-right font-mono">{r.ll_train.toFixed(4)}</td>
                        <td className="px-2 py-2 text-right font-mono text-amber-300">{r.ll_test.toFixed(4)}</td>
                        <td className="px-2 py-2 text-right font-mono">{r.brier_continuous.toFixed(4)}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-400">{r.brier_discrete.toFixed(4)}</td>
                        <td className="px-2 py-2 text-right font-mono">
                          <span className={Math.abs(r.brier_continuous - r.brier_discrete) < 0.0005 ? 'text-gray-500' : 'text-yellow-400'}>
                            {fmt(r.brier_continuous - r.brier_discrete)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* Interactive calculator */}
            <Panel
              title="Try it: live win-rate calculator"
              description="Move the sliders to see how pre-game probability + gold lead + minute combine into a live win-rate estimate."
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Pre-game probability (team 1)</label>
                  <input type="range" min={20} max={80} step={1} value={preProb}
                         onChange={e => setPreProb(parseInt(e.target.value))} className="w-full accent-amber-500" />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>20%</span><span className="text-amber-300 font-medium">{preProb}%</span><span>80%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Gold lead (team 1)</label>
                  <input type="range" min={-8000} max={8000} step={250} value={goldLead}
                         onChange={e => setGoldLead(parseInt(e.target.value))} className="w-full accent-amber-500" />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>−8k</span>
                    <span className={`font-medium ${goldLead > 0 ? 'text-blue-400' : goldLead < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                      {goldLead > 0 ? '+' : ''}{goldLead.toLocaleString()}
                    </span>
                    <span>+8k</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Minute of game</label>
                  <input type="range" min={10} max={35} step={1} value={minutes}
                         onChange={e => setMinutes(parseInt(e.target.value))} className="w-full accent-amber-500" />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>10</span><span className="text-amber-300 font-medium">{minutes} min</span><span>35</span>
                  </div>
                </div>
              </div>

              {live !== null && (
                <div className="mt-6 flex items-center gap-4">
                  <div className="text-center min-w-[90px]">
                    <div className="text-4xl font-bold text-blue-400">{pct(live)}</div>
                    <div className="text-xs text-gray-500 mt-1">Team 1</div>
                  </div>
                  <div className="flex-1">
                    <ProbBar p={live} />
                  </div>
                  <div className="text-center min-w-[90px]">
                    <div className="text-4xl font-bold text-red-400">{pct(1 - live)}</div>
                    <div className="text-xs text-gray-500 mt-1">Team 2</div>
                  </div>
                </div>
              )}

              <div className="mt-4 text-xs text-gray-500 leading-relaxed">
                Pre-game logit was <span className="text-gray-300 font-mono">{logit(preProb / 100).toFixed(3)}</span>;
                its effective coefficient at this minute is <span className="text-gray-300 font-mono">{effectiveCoefAt(continuous, minutes).pre_logit.toFixed(3)}</span>
                {' '}(vs <span className="text-gray-400">{continuous.coef.pre_logit.toFixed(3)}</span> at t=0).
                Gold/1k coefficient at this minute: <span className="text-gray-300 font-mono">{effectiveCoefAt(continuous, minutes).gold_k.toFixed(3)}</span>.
              </div>
            </Panel>

            {/* Sample-prediction heatmap */}
            {sampleGrid && (
              <Panel
                title={`Sample predictions across (gold lead × minute)`}
                description={`Holding pre-game probability fixed at ${preProb}%. Drag the pre-game slider above to repaint this grid.`}
              >
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse">
                    <thead>
                      <tr>
                        <th className="text-right pr-3 py-1 text-gray-500 font-normal">min ↓ / gold →</th>
                        {sampleGrid.golds.map(g => (
                          <th key={g} className="px-3 py-1 text-gray-400 font-mono font-normal text-center w-16">
                            {g > 0 ? '+' : ''}{(g / 1000).toFixed(1)}k
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sampleGrid.mins.map((t, i) => (
                        <tr key={t}>
                          <td className="text-right pr-3 py-1 text-gray-400 font-mono">{t}m</td>
                          {sampleGrid.cells[i].map((p, j) => (
                            <td key={j} className={`text-center font-mono ${probBg(p)} text-white border border-gray-950`}
                                style={{ minWidth: '4rem', padding: '0.4rem 0.25rem' }}>
                              {(p * 100).toFixed(0)}%
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  Notice: gold becomes more decisive over time at the extremes, but pre-game probability dominates the middle of the grid early (column g=0 stays near {preProb}% at t=10, drifts toward 50% by t=30 as pre-game info decays).
                </p>
              </Panel>
            )}

            {/* Coefficients */}
            <Panel
              title="Continuous-model coefficients"
              description="Full 8-feature logit. Multiply each feature by its coefficient, sum with the intercept, and apply sigmoid."
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 border-b border-gray-800">
                      <th className="text-left  px-2 py-2">Feature</th>
                      <th className="text-right px-2 py-2">Coefficient</th>
                      <th className="text-left  px-2 py-2 pl-6">What it captures</th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-200 font-mono">
                    <tr className="border-b border-gray-800/70">
                      <td className="px-2 py-2">intercept</td>
                      <td className="px-2 py-2 text-right">{fmt(continuous.intercept)}</td>
                      <td className="px-2 py-2 pl-6 font-sans text-xs text-gray-400">small symmetry-correction near 50/50</td>
                    </tr>
                    {[
                      ['pre_logit',           'pre-game model logit (base signal)'],
                      ['gold_k',              'blue gold lead in thousands'],
                      ['minutes',             'in-game time (tiny standalone drift)'],
                      ['gold_x_minutes',      "gold's impact slowly compresses as games lock in"],
                      ['pre_x_minutes',       'pre-game information decays over time (key term)'],
                      ['gold_x_underdog',     'gold matters more when an underdog is ahead'],
                      ['gold_x_underdog_x_t', 'underdog amplification decays over time'],
                      ['gold_sq',             'faint convexity in very large gold leads'],
                    ].map(([f, desc]) => (
                      <tr key={f} className="border-b border-gray-800/70">
                        <td className="px-2 py-2">{f}</td>
                        <td className="px-2 py-2 text-right">{fmt(continuous.coef[f])}</td>
                        <td className="px-2 py-2 pl-6 font-sans text-xs text-gray-400">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* Effective per-minute coefficients */}
            <Panel
              title="Effective coefficients by minute"
              description="The continuous model boils down to a per-minute affine model. These rows show what the equivalent {intercept, pre_logit, gold/1k, underdog-amp} logistic looks like at each in-game time — useful for sanity-checking vs the three independent checkpoint models."
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 border-b border-gray-800">
                      <th className="text-left  px-2 py-2">Minute</th>
                      <th className="text-right px-2 py-2">intercept</th>
                      <th className="text-right px-2 py-2">pre_logit</th>
                      <th className="text-right px-2 py-2">gold/1k</th>
                      <th className="text-right px-2 py-2">gold × underdog</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-gray-200">
                    {effRows.map(r => (
                      <tr key={r.t} className="border-b border-gray-800/70">
                        <td className="px-2 py-2 font-sans">{r.t} min</td>
                        <td className="px-2 py-2 text-right">{fmt(r.intercept)}</td>
                        <td className="px-2 py-2 text-right">{fmt(r.pre_logit)}</td>
                        <td className="px-2 py-2 text-right">{fmt(r.gold_k)}</td>
                        <td className="px-2 py-2 text-right">{fmt(r.gold_x_underdog)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {discrete && (
                <div className="mt-4 text-xs text-gray-500 leading-relaxed">
                  Discrete-checkpoint references for sanity-check
                  {' '}(<span className="text-gray-400">live_wr_coeffs.json</span>):
                  {' '}t=10 → pre_logit {discrete.checkpoints['10']?.pre_logit.toFixed(3)}, gold/1k {discrete.checkpoints['10']?.gold_per_1k.toFixed(3)};{' '}
                  t=15 → pre_logit {discrete.checkpoints['15']?.pre_logit.toFixed(3)}, gold/1k {discrete.checkpoints['15']?.gold_per_1k.toFixed(3)};{' '}
                  t=20 → pre_logit {discrete.checkpoints['20']?.pre_logit.toFixed(3)}, gold/1k {discrete.checkpoints['20']?.gold_per_1k.toFixed(3)}.
                </div>
              )}
            </Panel>

            {/* Usage / when to apply */}
            <Panel
              title="How to use this in practice"
              description="The trader cockpit + alert workers can both plug into this to score in-progress games."
            >
              <ul className="text-sm text-gray-300 space-y-2 list-disc pl-5">
                <li>
                  <span className="text-amber-300 font-medium">Pre-game baseline:</span> use the existing series-calculator model
                  to get <code className="bg-gray-800 px-1 rounded text-xs">pre_prob</code> for team 1 in game 1 (or game N with draft adjustments).
                </li>
                <li>
                  <span className="text-amber-300 font-medium">In-game stream:</span> poll <code className="bg-gray-800 px-1 rounded text-xs">feed.lolesports.com/livestats/v1/window/{'{'}game_id{'}'}</code>{' '}
                  (10s frame resolution) for current blue gold and clock time. Plug into this model — get a live WR every tick.
                </li>
                <li>
                  <span className="text-amber-300 font-medium">Validity:</span> good from minute 10 onward. Below 10 the model
                  extrapolates a regime it wasn&apos;t trained on (OE doesn&apos;t log gold @5m).
                </li>
                <li>
                  <span className="text-amber-300 font-medium">When the edge is biggest:</span> the gap between model and market is
                  largest at minutes 10–15 — markets stay anchored to pre-game odds while the model knows real game state.
                  By minute 20 with a 3k+ lead, books usually already reflect the lead and the edge shrinks.
                </li>
                <li>
                  <span className="text-amber-300 font-medium">Where to find more lift:</span> XP diff, kill/dragon/tower state,
                  60-second rolling gold rate, and &quot;time since last objective&quot; aren&apos;t in this model yet — adding
                  them is probably another 5–10% log-loss reduction.
                </li>
              </ul>
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}
