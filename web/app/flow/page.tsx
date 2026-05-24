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
  yes_outcome: string
  no_outcome: string
  n_trades: number
  total_volume_usd: number
  net_yes_shares: number
  net_yes_usd: number
  buy_volume_usd: number
  sell_volume_usd: number
  last_trade_ts: number
  last_trade_price: number
}

interface Summary {
  generated_at_utc: string
  window_hours: number
  min_trade_usd: number
  n_markets: number
  n_trades_window: number
  markets: MarketRow[]
}

// Public raw URL (no auth needed)
const SUMMARY_URL = 'https://raw.githubusercontent.com/lpoklpok/LoLMLAnalysis/main/data/processed/poly_market_balance.json'

type SortKey = keyof MarketRow
type SortDir = 'asc' | 'desc'

const COLS: { key: SortKey; label: string; fmt?: (v: any, row?: MarketRow) => string; width?: string; tip?: string }[] = [
  { key: 'event_title',     label: 'Event',        width: 'min-w-[260px]' },
  { key: 'market_type',     label: 'Market',       width: 'w-32' },
  { key: 'total_volume_usd',label: 'Volume 24h',   fmt: v => '$' + (v as number).toLocaleString('en-US', { maximumFractionDigits: 0 }), tip: 'Total notional traded in last 24h' },
  { key: 'n_trades',        label: 'Trades',       fmt: v => String(v), tip: 'Number of trades in last 24h' },
  { key: 'net_yes_usd',     label: 'Net Yes $',    fmt: v => (v >= 0 ? '+' : '') + '$' + Math.abs(v as number).toLocaleString('en-US', { maximumFractionDigits: 0 }), tip: 'Net taker $ on the Yes side (positive = bullish Yes)' },
  { key: 'net_yes_shares',  label: 'Net Yes Sh.',  fmt: v => (v >= 0 ? '+' : '') + Math.round(v as number).toLocaleString(), tip: 'Net taker shares on Yes side' },
  { key: 'buy_volume_usd',  label: 'Yes Buy $',    fmt: v => '$' + (v as number).toLocaleString('en-US', { maximumFractionDigits: 0 }) },
  { key: 'sell_volume_usd', label: 'Yes Sell $',   fmt: v => '$' + (v as number).toLocaleString('en-US', { maximumFractionDigits: 0 }) },
  { key: 'last_trade_price',label: 'Last Px',      fmt: (v, row) => `${(v as number).toFixed(3)}` },
  { key: 'last_trade_ts',   label: 'Last Trade',   fmt: v => relTime(v as number) },
]

function relTime(unixSec: number): string {
  if (!unixSec) return '—'
  const diff = Date.now() / 1000 - unixSec
  if (diff < 60)    return `${Math.round(diff)}s ago`
  if (diff < 3600)  return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

function cellColor(col: SortKey, val: number, row?: MarketRow): string {
  if (col === 'net_yes_usd' || col === 'net_yes_shares') {
    return val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-gray-400'
  }
  return 'text-gray-300'
}

export default function FlowPage() {
  const [data, setData]       = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('total_volume_usd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
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
    const id = setInterval(load, 30_000)  // refresh every 30s
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
      const av = a[sortKey], bv = b[sortKey]
      const cmp = (av as number) < (bv as number) ? -1 : (av as number) > (bv as number) ? 1 : 0
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
        <p className="text-sm text-gray-400 mt-1">Polymarket order flow · last 24h</p>
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
          {data ? `${sorted.length} of ${data.n_markets} markets · ${data.n_trades_window} trades in window · updated ${relTime(Date.parse(data.generated_at_utc)/1000)}` : (loading ? 'Loading…' : err ?? 'No data')}
        </span>
      </div>

      <main className="px-6 py-4 overflow-x-auto">
        {loading && !data ? (
          <p className="text-gray-500 text-sm mt-8">Loading order flow data…</p>
        ) : err && !data ? (
          <p className="text-red-400 text-sm mt-8">Error: {err} — first poll may not have written the file yet; refresh in a minute.</p>
        ) : (
          <table className="w-full text-xs whitespace-nowrap">
            <thead>
              <tr className="border-b border-gray-800">
                {COLS.map(col => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    title={col.tip}
                    className={`text-left py-2 pr-4 font-medium text-gray-500 cursor-pointer hover:text-gray-300 select-none ${col.width ?? ''}`}
                  >
                    {col.label}
                    {sortKey === col.key && <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => (
                <tr key={row.condition_id} className="border-b border-gray-800/30 hover:bg-gray-900/50">
                  {COLS.map(col => {
                    const v = row[col.key]
                    let cell: React.ReactNode = col.fmt ? col.fmt(v, row) : String(v ?? '—')
                    if (col.key === 'event_title') {
                      const url = row.event_slug ? `https://polymarket.com/event/${row.event_slug}` : null
                      cell = (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-gray-200">{row.team1} vs {row.team2}</span>
                          <span className="text-[10px] text-gray-500">{row.tournament || row.event_title}</span>
                        </div>
                      )
                      if (url) cell = <a href={url} target="_blank" rel="noreferrer" className="hover:text-blue-300">{cell}</a>
                    }
                    return (
                      <td key={col.key as string} className={`py-1.5 pr-4 font-mono ${cellColor(col.key, v as number, row)}`}>
                        {cell}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  )
}
