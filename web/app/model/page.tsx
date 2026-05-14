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
            title="Section 2 — ELO Model (Logistic Regression)"
            description="Our first model uses a single feature: the difference in average player ELO between the two teams. Every player starts at 1500 ELO. After each game, ELO updates using the standard formula with K=32. The team ELO is the average across all 5 players. We train on 2024 games and test on 2025–2026."
          />

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[0,1,2].map(i => <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-5 animate-pulse h-24" />)}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <StatCard label="Test Games" value={predictions.length.toLocaleString()} sub="Out-of-sample (2025–2026)" />
                <StatCard label="ELO Model Log Loss" value={eloLL != null ? eloLL.toFixed(4) : '—'} sub="On games with market odds" />
                <StatCard label="vs Market" value={eloLL != null && marketLL != null ? (eloLL - marketLL).toFixed(4) : '—'} sub="Positive = worse than market" />
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 text-sm text-gray-400 leading-relaxed">
                <p className="font-semibold text-white mb-2">Findings</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>ELO alone achieves a log loss of <span className="text-white">{eloLL != null ? eloLL.toFixed(4) : '—'}</span> vs market&apos;s <span className="text-white">{marketLL != null ? marketLL.toFixed(4) : '—'}</span></li>
                  <li>A single ELO feature closes the majority of the gap between a coin flip and the market</li>
                  <li>Next step: add rolling team form, head-to-head record, and playoff indicator</li>
                </ul>
              </div>
            </>
          )}
        </div>

      </div>
    </main>
  )
}
