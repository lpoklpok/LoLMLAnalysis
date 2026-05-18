'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import RollingLogLossChart from './RollingLogLossChart'

type MarketGame = {
  date: string
  league: string
  playoffs: number
  blue_win: number
  q_blue_win: number
}

type Prediction = {
  date: string
  league: string
  playoffs: number
  blue_win: number
  q_blue_win: number | null
  pred_elo: number
  pred_full: number | null
}

function logLoss(y: number, p: number): number {
  const c = Math.max(1e-7, Math.min(1 - 1e-7, p))
  return -(y * Math.log(c) + (1 - y) * Math.log(1 - c))
}

function avgLogLoss(rows: { blue_win: number; p: number }[]): number {
  return rows.reduce((s, r) => s + logLoss(r.blue_win, r.p), 0) / rows.length
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-3xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-bold text-white mb-1">{title}</h2>
      <p className="text-sm text-gray-400 max-w-2xl leading-relaxed">{description}</p>
    </div>
  )
}

export default function ModelPage() {
  const [marketGames, setMarketGames] = useState<MarketGame[]>([])
  const [predictions, setPredictions] = useState<Prediction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      supabase.rpc('get_market_game_data').limit(10000),
      supabase.rpc('get_predictions').limit(10000),
    ]).then(([market, preds]) => {
      setMarketGames((market.data as MarketGame[]) ?? [])
      setPredictions((preds.data as Prediction[]) ?? [])
      setLoading(false)
    })
  }, [])

  // --- Market baseline stats ---
  const marketLL = marketGames.length > 0
    ? avgLogLoss(marketGames.map(g => ({ blue_win: g.blue_win, p: g.q_blue_win })))
    : null

  const byLeague = ['LCK', 'LEC', 'LPL'].map(l => {
    const lg = marketGames.filter(g => g.league === l)
    const favWins = lg.filter(g => (g.q_blue_win > 0.5) === (g.blue_win === 1)).length
    return {
      league: l,
      games: lg.length,
      ll: lg.length > 0 ? avgLogLoss(lg.map(g => ({ blue_win: g.blue_win, p: g.q_blue_win }))) : null,
      favWinRate: lg.length > 0 ? favWins / lg.length : null,
    }
  })

  // --- ELO model stats (on games that have market odds for fair comparison) ---
  const predsWithOdds = predictions.filter(p => p.q_blue_win != null)
  const eloLL = predsWithOdds.length > 0
    ? avgLogLoss(predsWithOdds.map(p => ({ blue_win: p.blue_win, p: p.pred_elo })))
    : null

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-10">

        <div className="mb-8">
          <a href="/" className="text-sm text-gray-500 hover:text-gray-300">← Dashboard</a>
          <h1 className="text-2xl font-bold text-white mt-2 mb-2">Model Analysis</h1>
          <p className="text-gray-400 max-w-2xl text-sm leading-relaxed">
            The goal is to build a pre-game model that beats market odds on LCK, LEC, and LPL games.
            The market represents sharp consensus from professional bettors — its log loss is our benchmark.
          </p>
        </div>

        {/* ── Section 1: Market Baseline ── */}
        <div className="mb-10">
          <SectionHeader
            title="Section 1 — Market Baseline"
            description="Before building a model, we establish what we're trying to beat. The market log loss is computed from vig-free closing odds across all LCK/LEC/LPL games with available odds data (2024–2026)."
          />

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              {[0,1,2].map(i => <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse h-24" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <StatCard label="Games with Odds" value={marketGames.length.toLocaleString()} sub="LCK / LEC / LPL — 2024 to 2026" />
              <StatCard label="Coin Flip Log Loss" value="0.6931" sub="Baseline — always predict 50%" />
              <StatCard label="Market Log Loss" value={marketLL != null ? marketLL.toFixed(4) : '—'} sub="Vig-free closing odds" />
            </div>
          )}

          {/* Favorite win rate by league */}
          {!loading && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-6">
              <div className="px-5 py-3 border-b border-gray-800">
                <h3 className="text-sm font-semibold text-gray-300">Favorite Win Rate by League</h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">League</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Games</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Favorite Win Rate</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Market Log Loss</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">vs Coin Flip</th>
                  </tr>
                </thead>
                <tbody>
                  {byLeague.map(({ league, games, ll, favWinRate }) => (
                    <tr key={league} className="border-b border-gray-800 last:border-0">
                      <td className="px-5 py-3 font-medium text-white">{league}</td>
                      <td className="px-5 py-3 text-right text-gray-300">{games.toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-300">
                        {favWinRate != null ? `${(favWinRate * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-300">{ll != null ? ll.toFixed(4) : '—'}</td>
                      <td className={`px-5 py-3 text-right font-medium ${ll != null && ll < 0.6931 ? 'text-green-400' : 'text-gray-400'}`}>
                        {ll != null ? (ll - 0.6931).toFixed(4) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Rolling log loss chart */}
          {!loading && marketGames.length > 0 && (
            <RollingLogLossChart games={marketGames} />
          )}
        </div>

        {/* ── Section 2: ELO Model ── */}
        <div className="mb-10">
          <SectionHeader
            title="Section 2 — ELO System"
            description="Every player starts at a league-tiered ELO (LCK/LPL = 1620, LEC = 1500, LCS/LTA = 1380). After each game, individual ELOs update with K=48. Team ELO is the average of all 5 players, so players carry their ELO when they switch teams or leagues."
          />

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[0,1,2].map(i => <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse h-24" />)}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <StatCard label="Train / Test Split" value="2024–25 / 2026" sub="LCK + LEC only" />
                <StatCard label="ELO Only Log Loss" value={eloLL != null ? eloLL.toFixed(4) : '0.6517'} sub="2026 out-of-sample, games with odds" />
                <StatCard label="vs Market" value={eloLL != null && marketLL != null ? (eloLL - marketLL).toFixed(4) : '+0.0263'} sub="Positive = worse than market" />
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 text-sm text-gray-400 leading-relaxed">
                <p className="font-semibold text-white mb-2">ELO Design Decisions</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Player-level (not team-level) — ELO persists through roster moves and promotions</li>
                  <li>Tiered starting ELOs reflect ~67% win rates between tiers (400 × log10(2) ≈ 120 pts per tier)</li>
                  <li>K=48 chosen to allow faster adaptation to new evidence vs standard K=32</li>
                  <li>ELO decay back to baseline during inactivity was tested but does not generalise out-of-sample — not used</li>
                </ul>
              </div>
            </>
          )}
        </div>

        {/* ── Section 3: Model Comparison ── */}
        <div className="mb-10">
          <SectionHeader
            title="Section 3 — Model Comparison (2026 Test Set)"
            description="All models trained on 2024–2025 LCK/LEC games, evaluated on all 2026 LCK/LEC games with available market odds (455 games). Raw logistic regression probabilities — no temperature scaling, which was found to hurt after adding the signed-squared ELO term."
          />

          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Model</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Features</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Log Loss</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">vs Market</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: 'Coin flip',          features: '—',                                              ll: 0.6931, highlight: false },
                  { name: 'Market odds',         features: 'Closing vig-free odds',                         ll: 0.6254, highlight: true },
                  { name: 'ELO only',            features: 'elo_diff',                                      ll: 0.6517, highlight: false },
                  { name: 'ELO + signed²',       features: 'elo_diff, elo_diff_signed_sq',                  ll: 0.6504, highlight: false },
                  { name: 'Full',                features: 'elo_diff, rwr_diff, h2h_wr, playoffs',          ll: 0.6522, highlight: false },
                  { name: 'Full + GD@15',        features: '+ gd15_diff',                                   ll: 0.6503, highlight: false },
                  { name: 'Full + outperf',      features: '+ outperf_diff',                                ll: 0.6511, highlight: false },
                  { name: 'GD@15 + outperf ★',  features: 'elo_diff, rwr_diff, h2h_wr, playoffs, gd15_diff, outperf_diff', ll: 0.6488, highlight: true },
                  { name: 'Role diffs',          features: 'per-position elo_diff × 5, rwr_diff, h2h_wr, playoffs', ll: 0.6542, highlight: false },
                ].map(({ name, features, ll, highlight }) => (
                  <tr key={name} className={`border-b border-gray-800 last:border-0 ${highlight ? 'bg-gray-800/40' : ''}`}>
                    <td className={`px-5 py-3 font-medium ${highlight ? 'text-white' : 'text-gray-300'}`}>{name}</td>
                    <td className="px-5 py-3 text-gray-500 font-mono text-xs">{features}</td>
                    <td className="px-5 py-3 text-right text-gray-300 font-mono">{ll.toFixed(4)}</td>
                    <td className={`px-5 py-3 text-right font-mono font-medium ${ll <= 0.6254 ? 'text-green-400' : 'text-red-400'}`}>
                      {ll === 0.6254 ? '—' : `+${(ll - 0.6254).toFixed(4)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Apples-to-apples log loss comparison (games with odds only) */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-6">
            <div className="px-5 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300">Apples-to-Apples Log Loss (Games with Market Odds Only)</h3>
              <p className="text-xs text-gray-500 mt-1">Restricted to the same set of games for a fair comparison. Train = 2024–25 (n=2,784), Test = 2026 (n=559). Our LR = GD@15 + Outperf model.</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Model</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Train LL</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Test LL</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Train vs Mkt</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Test vs Mkt</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: 'Market odds',  train: 0.6111, test: 0.6276, highlight: true },
                  { name: 'Our LR',       train: 0.6185, test: 0.6402, highlight: false },
                  { name: 'Null (base rate)', train: null, test: 0.6902, highlight: false },
                ].map(({ name, train, test, highlight }) => {
                  const mktTrain = 0.6111, mktTest = 0.6276
                  const trainDelta = train != null ? train - mktTrain : null
                  const testDelta  = test  != null ? test  - mktTest  : null
                  return (
                    <tr key={name} className={`border-b border-gray-800 last:border-0 ${highlight ? 'bg-gray-800/40' : ''}`}>
                      <td className={`px-5 py-3 font-medium ${highlight ? 'text-white' : 'text-gray-300'}`}>{name}</td>
                      <td className="px-5 py-3 text-right font-mono text-gray-300">{train != null ? train.toFixed(4) : '—'}</td>
                      <td className="px-5 py-3 text-right font-mono text-gray-300">{test != null ? test.toFixed(4) : '—'}</td>
                      <td className={`px-5 py-3 text-right font-mono font-medium ${trainDelta == null ? 'text-gray-500' : trainDelta === 0 ? 'text-gray-400' : trainDelta < 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {trainDelta == null ? '—' : trainDelta === 0 ? '—' : `${trainDelta > 0 ? '+' : ''}${trainDelta.toFixed(4)}`}
                      </td>
                      <td className={`px-5 py-3 text-right font-mono font-medium ${testDelta == null ? 'text-gray-500' : testDelta === 0 ? 'text-gray-400' : testDelta < 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {testDelta == null ? '—' : testDelta === 0 ? '—' : `${testDelta > 0 ? '+' : ''}${testDelta.toFixed(4)}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* McFadden R2 + permutation importance */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">McFadden R²</p>
              <p className="text-3xl font-bold text-white">0.061</p>
              <p className="text-xs text-gray-500 mt-1">Best model (GD@15 + outperf) on 2026 test set. 0.05–0.10 is typical for sports prediction — outcomes are genuinely noisy.</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Null Log Loss</p>
              <p className="text-3xl font-bold text-white">0.6908</p>
              <p className="text-xs text-gray-500 mt-1">Predicting the base rate (blue win %) for every game. Model achieves 0.6488 — R² measures how much of this gap the model explains.</p>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-6">
            <div className="px-5 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300">Permutation Importance</h3>
              <p className="text-xs text-gray-500 mt-1">Each feature is randomly shuffled; the log loss increase shows how much the model relies on it.</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Feature</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Shuffled LL</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">Delta</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">% Increase</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { feat: 'elo_diff',      shuffled: 0.7897, delta: +0.1409, pct: 21.73 },
                  { feat: 'h2h_wr',        shuffled: 0.6543, delta: +0.0055, pct:  0.85 },
                  { feat: 'rwr_diff',      shuffled: 0.6530, delta: +0.0043, pct:  0.66 },
                  { feat: 'outperf_diff',  shuffled: 0.6516, delta: +0.0028, pct:  0.43 },
                  { feat: 'gd15_diff',     shuffled: 0.6508, delta: +0.0021, pct:  0.32 },
                  { feat: 'playoffs',      shuffled: 0.6480, delta: -0.0008, pct: -0.12 },
                ].map(({ feat, shuffled, delta, pct }) => (
                  <tr key={feat} className="border-b border-gray-800 last:border-0">
                    <td className="px-5 py-3 font-mono text-blue-400">{feat}</td>
                    <td className="px-5 py-3 text-right font-mono text-gray-300">{shuffled.toFixed(4)}</td>
                    <td className={`px-5 py-3 text-right font-mono font-medium ${delta > 0.01 ? 'text-red-400' : delta > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
                      {delta >= 0 ? '+' : ''}{delta.toFixed(4)}
                    </td>
                    <td className={`px-5 py-3 text-right font-mono ${delta > 0.01 ? 'text-red-400' : delta > 0 ? 'text-yellow-400' : 'text-gray-500'}`}>
                      {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Current model formula */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <p className="font-semibold text-white mb-3 text-sm">Current Best Model — Coefficients (GD@15 + Outperf)</p>
            <div className="font-mono text-xs text-gray-300 space-y-1 mb-4">
              <div className="text-gray-500 mb-2">logit(P[blue wins]) = intercept + ...</div>
              {[
                { feat: 'elo_diff',       coef: '+0.8494', desc: 'Team avg player ELO gap' },
                { feat: 'rwr_diff',       coef: '−0.0754', desc: 'Rolling win rate diff (last 10 games)' },
                { feat: 'h2h_wr',         coef: '+0.2406', desc: 'Head-to-head win rate (blue team)' },
                { feat: 'playoffs',       coef: '−0.0672', desc: 'Playoff game indicator' },
                { feat: 'gd15_diff',      coef: '+0.1075', desc: 'Avg player gold diff at 15 min (last 5 games)' },
                { feat: 'outperf_diff',   coef: '−0.0538', desc: 'Rolling (actual − market-implied) win rate' },
              ].map(({ feat, coef, desc }) => (
                <div key={feat} className="flex gap-4 items-baseline">
                  <span className="w-36 text-blue-400 shrink-0">{feat}</span>
                  <span className={`w-16 shrink-0 ${coef.startsWith('+') ? 'text-green-400' : 'text-red-400'}`}>{coef}</span>
                  <span className="text-gray-500">{desc}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500">Features are standardised before fitting. Coefficients shown are on the standardised scale.</p>
          </div>
        </div>

        {/* ── Section 4: What We Tried ── */}
        <div className="mb-10">
          <SectionHeader
            title="Section 4 — Research Findings"
            description="A log of what helped, what didn't, and why — based on out-of-sample evaluation on 2025 and 2026 data."
          />

          <div className="space-y-4">
            {/* What worked */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <p className="font-semibold text-green-400 text-sm mb-3">What Helped</p>
              <ul className="text-sm text-gray-400 space-y-2 leading-relaxed">
                <li><span className="text-white font-medium">elo_diff_signed_sq</span> — signed squared ELO term (elo_diff × |elo_diff|). Coefficient −0.19 compresses overconfident tail predictions. Without it, the model is systematically too confident on heavy favorites.</li>
                <li><span className="text-white font-medium">outperf_diff</span> — rolling (actual result − market-implied probability). Negative coefficient confirms mean reversion: teams that have been beating their market odds tend to regress. Requires staleness guard to avoid stale LPL data contaminating LCK/LEC features.</li>
                <li><span className="text-white font-medium">gd15_diff</span> — rolling gold diff at 15 min per player. Captures laning-phase form independent of win rate.</li>
                <li><span className="text-white font-medium">h2h_wr</span> — head-to-head win rate. Consistently useful (~+0.24 coefficient), possibly capturing meta/style matchups not reflected in ELO.</li>
                <li><span className="text-white font-medium">Tiered starting ELOs</span> — initialising LCK/LPL players at 1620 rather than 1500 removes the warm-up period where cross-region ELO gaps are underestimated.</li>
              </ul>
            </div>

            {/* What didn't work */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <p className="font-semibold text-red-400 text-sm mb-3">What Didn&apos;t Help</p>
              <ul className="text-sm text-gray-400 space-y-2 leading-relaxed">
                <li><span className="text-white font-medium">ELO decay</span> — pulling ELO toward baseline during inactivity (30-day or 90-day half-life, or split resets). Improves 2026 predictions but hurts 2025 predictions — does not generalise out-of-sample.</li>
                <li><span className="text-white font-medium">Temperature scaling</span> — post-hoc calibration via logit compression. Made things worse once the signed-squared ELO term was added, which already handles tail overconfidence.</li>
                <li><span className="text-white font-medium">days_since_last_played</span> — zero coefficient in all configurations. Rest/rust has no detectable signal in LCK/LEC.</li>
                <li><span className="text-white font-medium">blue_first_pick</span> — constant in 2024/2025 (blue side always has first pick), so the model cannot learn a coefficient. Feature is uninformative on training data.</li>
                <li><span className="text-white font-medium">Lineup synergy</span> (games together, outperf per 5-man lineup) — small positive signal overall but doesn&apos;t address the core new-roster cold-start problem.</li>
                <li><span className="text-white font-medium">Fine-tuning on 2026 Jan–Mar</span> — only 249 games, too few. Pure pre-trained model always beats any blend or reweighting.</li>
                <li><span className="text-white font-medium">Market-implied ELO reset</span> — backing out implied team ELO from first game odds. Noisy because it requires holding the opponent&apos;s ELO constant. Blending at 25% gave marginal improvement that didn&apos;t persist.</li>
              </ul>
            </div>

            {/* Structural gap */}
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <p className="font-semibold text-yellow-400 text-sm mb-3">Known Structural Gap</p>
              <ul className="text-sm text-gray-400 space-y-2 leading-relaxed">
                <li><span className="text-white font-medium">New rosters</span> — the largest model-market gaps in 2026 are concentrated on teams with entirely new or rebranded rosters (Los Ratones, DN SOOPers). Player ELOs from prior teams don&apos;t transfer correctly when a team is essentially brand new. No structural fix found yet.</li>
                <li><span className="text-white font-medium">Academy teams</span> — Karmine Corp vs Karmine Corp Blue: the market correctly prices the parent-academy matchup (0.88 implied), the model sees two teams with similar player ELOs (0.46). The model has no concept of org affiliation.</li>
                <li><span className="text-white font-medium">Jan–Mar gap</span> — early-season log loss is significantly worse (~0.69) than late-season (~0.61) due to roster uncertainty and stale ELOs from the off-season. The full-year gap to market is ~0.023; the Apr–May gap narrows to ~0.007.</li>
              </ul>
            </div>
          </div>
        </div>

      </div>
    </main>
  )
}
