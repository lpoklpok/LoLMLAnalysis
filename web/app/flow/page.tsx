'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

interface MarketRow {
  condition_id: string
  event_slug: string
  event_title: string
  tournament: string
  team1: string
  team2: string
  best_of: number
  market_type: string
  market_question: string
  n_trades: number
  total_volume_usd: number
  team1_flow_usd: number
  team2_flow_usd: number
  team1_flow_shares: number
  team2_flow_shares: number
  team1_share_pct: number   // 0..100 — team1's share of directional flow $
  last_trade_ts: number
  last_trade_price: number
}

interface Summary {
  generated_at_utc: string
  window_hours: number
  min_trade_usd: number
  price_floor: number
  price_ceil: number
  n_markets: number
  n_trades_window: number
  n_excluded_tail: number
  markets: MarketRow[]
}

const SUMMARY_URL = 'https://raw.githubusercontent.com/lpoklpok/LoLMLAnalysis/main/data/processed/poly_market_balance.json'

type SortKey = 'total_volume_usd' | 'team1_flow_usd' | 'team2_flow_usd' | 'team1_share_pct' | 'last_trade_ts' | 'n_trades'

function relTime(unixSec: number): string {
  if (!unixSec) return '—'
  const diff = Date.now() / 1000 - unixSec
  if (diff < 60)    return `${Math.round(diff)}s ago`
  if (diff < 3600)  return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

function ImbalanceBar({ row }: { row: MarketRow }) {
  const pct = row.team1_share_pct ?? 50
  // Light-tinted bar that visually represents the split
  return (
    <div className="w-full">
      <div className="flex items-center gap-2 text-[11px] font-mono mb-0.5">
        <span className="text-blue-300 truncate flex-1" title={row.team1}>{row.team1}</span>
        <span className="text-gray-500 text-[10px]">{pct.toFixed(0)}% / {(100-pct).toFixed(0)}%</span>
        <span className="text-red-300 truncate flex-1 text-right" title={row.team2}>{row.team2}</span>
      </div>
      <div className="flex h-2 rounded-sm overflow-hidden bg-gray-800 border border-gray-700">
        <div
          className="bg-blue-500/70 h-full transition-all"
          style={{ width: `${pct}%` }}
        />
        <div
          className="bg-red-500/70 h-full transition-all"
          style={{ width: `${100 - pct}%` }}
        />
      </div>
    </div>
  )
}

function fmtUsd(v: number): string {
  if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'k'
  return '$' + Math.round(v).toLocaleString()
}

export default function FlowPage() {
  const [data, setData]       = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('total_volume_usd')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch]   = useState('')
  const [marketTypeFilter, setMarketTypeFilter] = useState('All')

  async function load() {
    try {
      const r = await fetch(SUMMARY_URL + '?t=' + Date.now(), { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j: Summary = await r.json()
      setData(j)
      setErr(null)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.toLowerCase()
    return data.markets.filter(m => {
      if (marketTypeFilter !== 'All' && m.market_type !== marketTypeFilter) return false
      if (q && !`${m.event_title} ${m.team1} ${m.team2}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [data, search, marketTypeFilter])

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] as number
      const bv = b[sortKey] as number
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir])

  const marketTypes = useMemo(() => {
    if (!data) return ['All']
    return ['All', ...Array.from(new Set(data.markets.map(m => m.market_type))).sort()]
  }, [data])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold text-blue-400">LoL Esports Analytics</h1>
        <p className="text-sm text-gray-400 mt-1">Polymarket order flow · last 24h · excl. trades at &le;{data?.price_floor ?? 0.02} or &ge;{data?.price_ceil ?? 0.98}</p>
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"            className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
        <Link href="/players"     className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Player Lookup</Link>
        <Link href="/model"       className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Model</Link>
        <Link href="/predictions" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Predictions</Link>
        <Link href="/chart"       className="text-sm text-purple-400 hover:text-purple-300 transition-colors">Model vs Market</Link>
        <Link href="/games"       className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Game Explorer</Link>
        <Link href="/trader"      className="text-sm text-gray-400 hover:text-gray-200 transition-colors">Trader</Link>
        <span className="text-sm text-yellow-400 font-medium">Order Flow</span>
      </div>

      <div className="px-6 py-3 border-b border-gray-800 flex gap-4 flex-wrap items-center">
        <input
          type="text"
          placeholder="Search event / team…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 w-56 focus:outline-none focus:border-blue-500"
        />
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-400">Market</label>
          <select
            value={marketTypeFilter}
            onChange={e => setMarketTypeFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
          >
            {marketTypes.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <span className="text-xs text-gray-500 ml-auto">
          {data
            ? `${sorted.length} of ${data.n_markets} markets · ${data.n_trades_window} trades in window (${data.n_excluded_tail} excluded as tail) · updated ${relTime(Date.parse(data.generated_at_utc) / 1000)}`
            : (loading ? 'Loading…' : err ?? 'No data')}
        </span>
      </div>

      <main className="px-6 py-4 overflow-x-auto">
        {loading && !data ? (
          <p className="text-gray-500 text-sm mt-8">Loading order flow data…</p>
        ) : err && !data ? (
          <p className="text-red-400 text-sm mt-8">Error: {err}</p>
        ) : (
          <table className="w-full text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left py-2 pr-4 font-medium text-gray-500 min-w-[260px]">Event</th>
                <th className="text-left py-2 pr-4 font-medium text-gray-500 w-32">Market</th>
                <th className="text-right py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none w-24"
                    onClick={() => toggleSort('total_volume_usd')}
                    title="Total notional traded in window">
                  Volume {sortKey === 'total_volume_usd' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th className="text-right py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none w-16"
                    onClick={() => toggleSort('n_trades')}>
                  Trades {sortKey === 'n_trades' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th className="text-right py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none w-24"
                    onClick={() => toggleSort('team1_flow_usd')}
                    title="$ flow bullish on team 1 (= BUY team1 + SELL team2)">
                  Team 1 $ {sortKey === 'team1_flow_usd' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th className="py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none min-w-[220px]"
                    onClick={() => toggleSort('team1_share_pct')}
                    title="Team1 share of bullish flow $ (50% = balanced)">
                  Imbalance {sortKey === 'team1_share_pct' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th className="text-right py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none w-24"
                    onClick={() => toggleSort('team2_flow_usd')}
                    title="$ flow bullish on team 2 (= BUY team2 + SELL team1)">
                  Team 2 $ {sortKey === 'team2_flow_usd' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
                <th className="text-right py-2 pr-4 font-medium text-gray-500 w-16">Last Px</th>
                <th className="text-right py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none w-20"
                    onClick={() => toggleSort('last_trade_ts')}>
                  Last {sortKey === 'last_trade_ts' && (sortDir === 'asc' ? '↑' : '↓')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => {
                const url = row.event_slug ? `https://polymarket.com/event/${row.event_slug}` : null
                return (
                  <tr key={row.condition_id} className="border-b border-gray-800/30 hover:bg-gray-900/50">
                    <td className="py-2 pr-4">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="hover:text-blue-300">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-gray-200">{row.team1} vs {row.team2}</span>
                            <span className="text-[10px] text-gray-500">{row.tournament || row.event_title}</span>
                          </div>
                        </a>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-gray-200">{row.team1} vs {row.team2}</span>
                          <span className="text-[10px] text-gray-500">{row.tournament || row.event_title}</span>
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-mono text-gray-300">{row.market_type}</td>
                    <td className="py-2 pr-4 font-mono text-gray-300 text-right">{fmtUsd(row.total_volume_usd)}</td>
                    <td className="py-2 pr-4 font-mono text-gray-400 text-right">{row.n_trades}</td>
                    <td className="py-2 pr-4 font-mono text-blue-300 text-right">{fmtUsd(row.team1_flow_usd)}</td>
                    <td className="py-2 pr-4"><ImbalanceBar row={row} /></td>
                    <td className="py-2 pr-4 font-mono text-red-300 text-right">{fmtUsd(row.team2_flow_usd)}</td>
                    <td className="py-2 pr-4 font-mono text-gray-300 text-right">{row.last_trade_price.toFixed(3)}</td>
                    <td className="py-2 pr-4 font-mono text-gray-500 text-right">{relTime(row.last_trade_ts)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </main>
    </div>
  )
}
