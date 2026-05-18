'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Link from 'next/link'

// ---------- types ----------

interface ModelFeature {
  name: string
  label: string
  coef: number
  se: number
  r2: number
}

interface ModelInfo {
  features: ModelFeature[]
  mcfadden_r2: number
  n_train: number
  n_eval: number
  updated_at: string
}

interface RoleH2H {
  pos: string
  blue: string
  red: string
  n: number
  blue_wins: number
}

interface Prediction {
  blue_team: string
  red_team: string
  league: string
  blue_elo: number
  red_elo: number
  elo_diff: number
  pred_blue_win: number
  pred_se: number | null
  best_of: number
  model_name: string | null
  date: string
  feat_rwr_diff: number | null
  feat_h2h_wr: number | null
  feat_gd15_diff: number | null
  feat_outperf_diff: number | null
  role_h2h: RoleH2H[] | null
  poly_prob: number | null
  poly_volume: number | null
}

// ---------- helpers ----------

function seriesProb(p: number, bestOf: number): number {
  if (bestOf === 1) return p
  if (bestOf === 3) return p * p * (3 - 2 * p)
  if (bestOf === 5) return p * p * p * (10 - 15 * p + 6 * p * p)
  return p
}

function fmt(n: number, decimals = 0) {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals)
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false,
  }) + ' UTC'
}

// ---------- sub-components ----------

function ProbBar({ blueP, label }: { blueP: number; label: string }) {
  const b = Math.round(blueP * 100)
  return (
    <div>
      <div className="flex text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <span className="ml-auto">{b}% · {100 - b}%</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden bg-gray-700 flex">
        <div className="h-full bg-blue-500" style={{ width: `${b}%` }} />
        <div className="h-full bg-red-500"  style={{ width: `${100 - b}%` }} />
      </div>
    </div>
  )
}

function FeatureVal({
  label, value, format, neutralAt,
}: {
  label: string
  value: number | null
  format: (v: number) => string
  neutralAt?: number
}) {
  const missing = value === null || value === undefined
  const neutral = neutralAt !== undefined ? neutralAt : 0
  const positive = !missing && value! > neutral
  const negative = !missing && value! < neutral
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-gray-500 truncate">{label}</span>
      <span className={`font-mono text-xs shrink-0 ${
        missing   ? 'text-gray-600' :
        positive  ? 'text-green-400' :
        negative  ? 'text-red-400' : 'text-gray-400'
      }`}>
        {missing ? '—' : format(value!)}
      </span>
    </div>
  )
}

const POS_LABEL: Record<string, string> = {
  top: 'TOP', jng: 'JNG', mid: 'MID', bot: 'BOT', sup: 'SUP',
}

function RoleH2HTable({ rows }: { rows: RoleH2H[] }) {
  return (
    <div className="border-t border-gray-800 pt-3">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Player H2H</p>
      <div className="space-y-1">
        {rows.map(({ pos, blue, red, n, blue_wins }) => {
          const enough  = n >= 5
          const bluePct = enough ? Math.round((blue_wins / n) * 100) : null
          const favor   = bluePct != null && bluePct !== 50
            ? (bluePct > 50 ? 'text-blue-400' : 'text-red-400')
            : 'text-gray-400'
          return (
            <div key={pos} className="grid grid-cols-[36px_1fr_auto] gap-x-2 items-center text-xs">
              <span className="font-mono text-gray-600">{POS_LABEL[pos]}</span>
              <span className="truncate text-gray-400">
                <span className="text-gray-200">{blue}</span>
                <span className="text-gray-600 mx-1">vs</span>
                <span className="text-gray-200">{red}</span>
              </span>
              {enough ? (
                <span className={`font-mono shrink-0 ${favor}`}>
                  {blue_wins}–{n - blue_wins}
                  <span className="text-gray-600 ml-1">({bluePct}%)</span>
                </span>
              ) : (
                <span className="font-mono text-gray-700 shrink-0">
                  {n > 0 ? `${blue_wins}–${n - blue_wins}` : '—'}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MatchCard({ game }: { game: Prediction }) {
  const p       = game.pred_blue_win
  const sp      = seriesProb(p, game.best_of)
  const blueWin = p >= 0.5
  const sePct   = game.pred_se != null ? Math.round(game.pred_se * 100) : null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors flex flex-col gap-3">

      {/* Time + BO badge */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{formatTime(game.date)}</span>
        <span className="text-xs font-mono text-yellow-400 bg-yellow-400/10 border border-yellow-400/20 px-2 py-0.5 rounded">
          BO{game.best_of}
        </span>
      </div>

      {/* Teams */}
      <div className="flex items-start gap-2">
        <div className="flex-1 text-right">
          <p className={`font-semibold text-sm ${blueWin ? 'text-white' : 'text-gray-400'}`}>
            {game.blue_team}
          </p>
          <p className="text-xs text-blue-500 mt-0.5">Blue · {Math.round(game.blue_elo)}</p>
        </div>
        <span className="text-gray-600 text-xs mt-1 shrink-0">vs</span>
        <div className="flex-1">
          <p className={`font-semibold text-sm ${!blueWin ? 'text-white' : 'text-gray-400'}`}>
            {game.red_team}
          </p>
          <p className="text-xs text-red-500 mt-0.5">Red · {Math.round(game.red_elo)}</p>
        </div>
      </div>

      {/* Probability bars */}
      <div className="space-y-2">
        <ProbBar blueP={p}  label="Per game" />
        {game.best_of > 1 && (
          <ProbBar blueP={sp} label={`Series (BO${game.best_of})`} />
        )}
      </div>

      {/* Polymarket comparison */}
      {game.poly_prob != null && (
        <div className="border-t border-gray-800 pt-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Polymarket</span>
            <span className="text-xs text-gray-600">${(game.poly_volume ?? 0).toLocaleString(undefined, {maximumFractionDigits: 0})} vol</span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500">Market</span>
              <span className="font-mono font-semibold text-white">{Math.round(game.poly_prob * 100)}%</span>
            </div>
            <span className="text-gray-700">·</span>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500">Model (series)</span>
              <span className="font-mono font-semibold text-white">{Math.round(sp * 100)}%</span>
            </div>
            <span className="text-gray-700">·</span>
            {(() => {
              const delta = Math.round((sp - game.poly_prob) * 100)
              const color = Math.abs(delta) >= 5
                ? (delta > 0 ? 'text-blue-400' : 'text-red-400')
                : 'text-gray-500'
              return (
                <span className={`font-mono font-semibold ${color}`}>
                  {delta > 0 ? '+' : ''}{delta}pp
                </span>
              )
            })()}
          </div>
        </div>
      )}

      {/* Feature values */}
      <div className="border-t border-gray-800 pt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <FeatureVal
          label="ELO Diff"
          value={game.elo_diff}
          format={v => fmt(v, 0)}
        />
        <FeatureVal
          label="Win Rate Diff"
          value={game.feat_rwr_diff}
          format={v => fmt(v * 100, 1) + '%'}
        />
        <FeatureVal
          label="H2H (Team 1)"
          value={game.feat_h2h_wr}
          format={v => (v * 100).toFixed(0) + '%'}
          neutralAt={0.5}
        />
        <FeatureVal
          label="GD@15 Diff"
          value={game.feat_gd15_diff}
          format={v => fmt(v, 0)}
        />
        <FeatureVal
          label="Mkt Outperf"
          value={game.feat_outperf_diff}
          format={v => fmt(v * 100, 1) + '%'}
        />
      </div>

      {/* Model + SE footer */}
      <div className="flex items-center justify-between border-t border-gray-800 pt-3">
        <span className="text-xs text-gray-600">{game.model_name ?? 'Logistic Regression'}</span>
        {sePct != null && (
          <span className="text-xs text-gray-500">±{sePct}% SE</span>
        )}
      </div>

      {/* Per-role player head-to-head */}
      {game.role_h2h && game.role_h2h.length > 0 && (
        <RoleH2HTable rows={game.role_h2h} />
      )}
    </div>
  )
}

function EquationPanel({ info }: { info: ModelInfo }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 mb-8">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
        <h2 className="text-sm font-semibold text-gray-200">Logistic Regression</h2>
        <span className="text-xs text-gray-500">
          McFadden R² = {info.mcfadden_r2.toFixed(3)} (2026 hold-out, n={info.n_eval?.toLocaleString()}) · trained on {info.n_train.toLocaleString()} games (2024–2025)
        </span>
      </div>

      <p className="text-xs font-mono text-gray-400 mb-4">
        log-odds(Team 1 wins) = β₁·x₁ + β₂·x₂ + …
        <span className="text-gray-600 ml-2">[intercept excluded — side-neutral]</span>
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left pb-2 pr-4 font-medium">Feature</th>
              <th className="text-right pb-2 pr-4 font-medium">Coef (std)</th>
              <th className="text-right pb-2 pr-4 font-medium">±SE</th>
              <th className="text-right pb-2 font-medium">R²</th>
            </tr>
          </thead>
          <tbody>
            {info.features.map(f => (
              <tr key={f.name} className="border-b border-gray-800/40">
                <td className="py-1.5 pr-4 text-gray-300">{f.label}</td>
                <td className={`py-1.5 pr-4 text-right font-mono ${
                  f.coef > 0 ? 'text-green-400' : f.coef < 0 ? 'text-red-400' : 'text-gray-400'
                }`}>
                  {f.coef >= 0 ? '+' : ''}{f.coef.toFixed(3)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono text-gray-500">
                  {f.se.toFixed(3)}
                </td>
                <td className="py-1.5 text-right font-mono text-gray-400">
                  {f.r2.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-600 mt-3">
        Coefficients on standardised scale (1 unit = 1 SD of feature). SE from Fisher information matrix. R² = squared Pearson correlation with outcome.
      </p>
    </div>
  )
}

// ---------- page ----------

const LEAGUE_STYLE: Record<string, string> = {
  LCK: 'text-blue-400 border-blue-700',
  LEC: 'text-purple-400 border-purple-700',
}

export default function PredictionsPage() {
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [modelInfo,   setModelInfo]   = useState<ModelInfo | null>(null)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [predsRes, infoRes] = await Promise.all([
        supabase.from('upcoming_predictions').select('*').order('date', { ascending: true }),
        supabase.from('model_info').select('*').eq('id', 1).single(),
      ])
      setPredictions(predsRes.data ?? [])
      if (infoRes.data) setModelInfo(infoRes.data as ModelInfo)
      setLoading(false)
    }
    load()
  }, [])

  const leagues = ['LCK', 'LEC']

  const byLeagueDate = leagues.reduce<Record<string, Record<string, Prediction[]>>>(
    (acc, lg) => {
      acc[lg] = predictions
        .filter(p => p.league === lg)
        .reduce<Record<string, Prediction[]>>((inner, p) => {
          const key = formatDate(p.date)
          ;(inner[key] ??= []).push(p)
          return inner
        }, {})
      return acc
    }, {}
  )

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">LCK · LEC · LCS · LPL · 2024–2026</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"        className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
        <Link href="/players" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Player Lookup</Link>
        <Link href="/model"   className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        <span className="text-sm text-green-400 font-medium">Predictions</span>
      </div>

      <div className="px-6 py-3 bg-gray-900/50 border-b border-gray-800 text-xs text-gray-500">
        Side-neutral predictions — blue-side advantage (~+2%) removed from intercept so probabilities reflect team quality only, not unknown side assignments.
        Team 1 (left) = first team listed by lolesports.
      </div>

      <main className="px-6 py-6 max-w-5xl mx-auto">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : (
          <>
            {modelInfo && <EquationPanel info={modelInfo} />}

            <div className="space-y-10">
              {leagues.map(lg => {
                const dateMap = byLeagueDate[lg]
                if (!dateMap || Object.keys(dateMap).length === 0) return null
                return (
                  <section key={lg}>
                    <h2 className={`text-lg font-bold mb-4 pb-2 border-b ${LEAGUE_STYLE[lg]}`}>{lg}</h2>
                    <div className="space-y-6">
                      {Object.entries(dateMap).map(([date, games]) => (
                        <div key={date}>
                          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{date}</h3>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {games.map((g, i) => <MatchCard key={i} game={g} />)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )
              })}

              {predictions.length === 0 && (
                <p className="text-gray-500 text-sm">No upcoming predictions available.</p>
              )}
            </div>
          </>
        )}

        <p className="mt-10 text-xs text-gray-600">
          Series probability assumes i.i.d. games at the same per-game rate. Updated daily.
        </p>
      </main>
    </div>
  )
}
