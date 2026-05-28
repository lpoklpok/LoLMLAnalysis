'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import SideWinRate from './components/SideWinRate'
import ChampionTable from './components/ChampionTable'
import StatsCards from './components/StatsCards'
import Link from 'next/link'

const LEAGUES = ['All', 'Main Leagues', 'LCK', 'LEC', 'LCS', 'LPL']
const MAIN_LEAGUES = ['LCK', 'LEC', 'LCS', 'LPL']

export interface SummaryStats {
  total_games: number
  blue_wins: number
  avg_gamelength: number
  games_with_odds: number
  favorite_wins: number
}

export interface ChampionStat {
  champion: string
  picks: number
  wins: number
}

export default function Dashboard() {
  const [league, setLeague] = useState('All')
  const [year, setYear] = useState('All')
  const [patch, setPatch] = useState('All')
  const [years, setYears] = useState<string[]>([])
  const [patches, setPatches] = useState<string[]>([])
  const [stats, setStats] = useState<SummaryStats | null>(null)
  const [champions, setChampions] = useState<ChampionStat[]>([])
  const [position, setPosition] = useState('mid')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadFilters() {
      const { data } = await supabase.rpc('get_filter_options')
      if (!data) return
      setYears(['All', ...data.years.map(String)])
      setPatches(['All', ...data.patches.map(String)])
    }
    loadFilters()
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)

    const baseParams = {
      p_year:  year  === 'All' ? null : parseInt(year),
      p_patch: patch === 'All' ? null : patch,
    }

    if (league === 'Main Leagues') {
      const [summaryResults, champResults] = await Promise.all([
        Promise.all(MAIN_LEAGUES.map(l => supabase.rpc('get_summary_stats', { ...baseParams, p_league: l }))),
        Promise.all(MAIN_LEAGUES.map(l => supabase.rpc('get_champion_stats', { ...baseParams, p_league: l, p_position: position }))),
      ])

      const summaries = summaryResults.map(r => r.data).filter(Boolean) as SummaryStats[]
      const merged: SummaryStats = {
        total_games:    summaries.reduce((s, r) => s + r.total_games, 0),
        blue_wins:      summaries.reduce((s, r) => s + r.blue_wins, 0),
        games_with_odds: summaries.reduce((s, r) => s + r.games_with_odds, 0),
        favorite_wins:  summaries.reduce((s, r) => s + r.favorite_wins, 0),
        avg_gamelength: summaries.reduce((s, r) => s + r.avg_gamelength * r.total_games, 0) /
                        summaries.reduce((s, r) => s + r.total_games, 0),
      }
      setStats(merged)

      const champMap = new Map<string, ChampionStat>()
      for (const res of champResults) {
        for (const c of (res.data ?? []) as ChampionStat[]) {
          const existing = champMap.get(c.champion)
          if (existing) {
            existing.picks += c.picks
            existing.wins  += c.wins
          } else {
            champMap.set(c.champion, { ...c })
          }
        }
      }
      setChampions([...champMap.values()].sort((a, b) => b.picks - a.picks))
    } else {
      const params = { ...baseParams, p_league: league === 'All' ? null : league }
      const [summaryRes, champRes] = await Promise.all([
        supabase.rpc('get_summary_stats', params),
        supabase.rpc('get_champion_stats', { ...params, p_position: position }),
      ])
      setStats(summaryRes.data)
      setChampions(champRes.data ?? [])
    }

    setLoading(false)
  }, [league, year, patch, position])

  useEffect(() => { loadData() }, [loadData])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">LCK · LEC · LCS · LPL · 2024–2026</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-4 flex-wrap items-center">
        <FilterSelect label="League" value={league} options={LEAGUES} onChange={setLeague} />
        <FilterSelect label="Year"   value={year}   options={years}   onChange={setYear} />
        <FilterSelect label="Patch"  value={patch}  options={patches} onChange={setPatch} />
        <Link href="/players" className="ml-auto text-sm text-blue-400 hover:text-blue-300 transition-colors">
          Player Lookup →
        </Link>
        <Link href="/rankings" className="text-sm text-blue-400 hover:text-blue-300 transition-colors">
          ELO Rankings →
        </Link>
        <Link href="/model" className="text-sm text-purple-400 hover:text-purple-300 transition-colors">
          Model →
        </Link>
        <Link href="/predictions" className="text-sm text-green-400 hover:text-green-300 transition-colors">
          Predictions →
        </Link>
        <Link href="/trader" className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">
          Trader →
        </Link>
        <Link href="/vwaper" className="text-sm text-teal-400 hover:text-teal-300 transition-colors">
          VWAPer →
        </Link>
        <Link href="/games" className="text-sm text-yellow-400 hover:text-yellow-300 transition-colors">
          Game Explorer →
        </Link>
        <Link href="/chart" className="text-sm text-purple-400 hover:text-purple-300 transition-colors">
          Model vs Market →
        </Link>
        <Link href="/flow" className="text-sm text-rose-400 hover:text-rose-300 transition-colors">
          Order Flow →
        </Link>
        <Link href="/mm" className="text-sm text-fuchsia-400 hover:text-fuchsia-300 transition-colors">
          Market Maker →
        </Link>
        <Link href="/backtest" className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
          Kelly Backtest →
        </Link>
        <Link href="/calculator" className="text-sm text-orange-400 hover:text-orange-300 transition-colors">
          Series Calculator →
        </Link>
        <Link href="/findings" className="text-sm text-pink-400 hover:text-pink-300 transition-colors">
          General Findings →
        </Link>
        <Link href="/gold-lead" className="text-sm text-amber-400 hover:text-amber-300 transition-colors">
          Gold Lead →
        </Link>
        <Link href="/pnl" className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
          PnL →
        </Link>
        <Link href="/pre-live" className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
          Pre-Live →
        </Link>
        <Link href="/draft-sim" className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors">
          Draft Sim →
        </Link>
        <Link href="/predict" className="text-sm text-violet-400 hover:text-violet-300 transition-colors">
          Predict (manual) →
        </Link>
        <span className="text-xs text-gray-500">
          {loading ? 'Loading…' : `${(stats?.total_games ?? 0).toLocaleString()} games`}
        </span>
      </div>

      <main className="px-6 py-6 space-y-8">
        <StatsCards stats={stats} loading={loading} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SideWinRate stats={stats} loading={loading} />
        </div>
        <ChampionTable
          champions={champions}
          totalGames={stats?.total_games ?? 0}
          position={position}
          onPositionChange={setPosition}
          loading={loading}
        />
      </main>
    </div>
  )
}

function FilterSelect({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm text-gray-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      >
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  )
}
