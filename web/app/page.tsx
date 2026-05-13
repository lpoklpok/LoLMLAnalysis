'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import SideWinRate from './components/SideWinRate'
import ChampionTable from './components/ChampionTable'
import StatsCards from './components/StatsCards'

const LEAGUES = ['All', 'LCK', 'LEC', 'LCS', 'LPL']

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
    const params = {
      p_league: league === 'All' ? null : league,
      p_year:   year   === 'All' ? null : parseInt(year),
      p_patch:  patch  === 'All' ? null : patch,
    }

    const [summaryRes, champRes] = await Promise.all([
      supabase.rpc('get_summary_stats', params),
      supabase.rpc('get_champion_stats', { ...params, p_position: position }),
    ])

    setStats(summaryRes.data)
    setChampions(champRes.data ?? [])
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
        <span className="text-xs text-gray-500 ml-auto">
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
