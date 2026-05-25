'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

interface DayRow {
  date:              string
  polymarket_pnl:    number
  kalshi_pnl:        number
  total_pnl:         number
  polymarket_trades: number
  kalshi_trades:     number
}

interface CumRow {
  date:           string
  polymarket_pnl: number
  kalshi_pnl:     number
  total_pnl:      number
  cum_pnl:        number
}

interface PnLData {
  generated_at_utc:  string
  wallet:            string
  kalshi_available:  boolean
  days:              DayRow[]
  cumulative_30d:    CumRow[]
  totals: {
    polymarket_pnl_7d:    number
    kalshi_pnl_7d:        number
    total_pnl_7d:         number
    polymarket_trades_7d: number
    kalshi_trades_7d:     number
  }
}

function fmt$(x: number, d = 0): string {
  const v = (Math.abs(x) >= 1000 ? x.toFixed(d) : x.toFixed(2))
  return (x >= 0 ? '+$' : '−$') + Math.abs(parseFloat(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function clrFor(v: number): string {
  if (v > 0)  return 'text-green-400'
  if (v < 0)  return 'text-red-400'
  return 'text-gray-500'
}

function bgFor(v: number, max: number): string {
  if (max === 0) return ''
  const intensity = Math.min(1, Math.abs(v) / max)
  if (v > 0) {
    if (intensity > 0.66) return 'bg-green-700/40'
    if (intensity > 0.33) return 'bg-green-700/25'
    return 'bg-green-700/10'
  }
  if (v < 0) {
    if (intensity > 0.66) return 'bg-red-700/40'
    if (intensity > 0.33) return 'bg-red-700/25'
    return 'bg-red-700/10'
  }
  return ''
}

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

function SparkLine({ data, color = '#3b82f6', height = 36 }: {
  data: number[]; color?: string; height?: number
}) {
  if (data.length === 0) return null
  const min = Math.min(...data, 0)
  const max = Math.max(...data, 0)
  const range = max - min || 1
  const w = 100
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1 || 1)) * w
    const y = height - ((v - min) / range) * height
    return `${x},${y}`
  }).join(' ')
  const zeroY = height - ((0 - min) / range) * height
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="#374151" strokeDasharray="2,2" strokeWidth="0.5" />
      <polyline fill="none" stroke={color} strokeWidth="1.4" points={pts} />
    </svg>
  )
}

export default function PnLPage() {
  const [data, setData]   = useState<PnLData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/pnl_daily.json')
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [])

  const maxAbs = useMemo(() => {
    if (!data) return 0
    return Math.max(
      ...data.days.flatMap(d => [Math.abs(d.polymarket_pnl), Math.abs(d.kalshi_pnl), Math.abs(d.total_pnl)]),
      1,
    )
  }, [data])

  const cum30 = data?.cumulative_30d ?? []

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-400">PnL — Polymarket + Kalshi</h1>
          <p className="text-sm text-gray-400 mt-1">
            Day-by-day cash flow for LoL markets only
            {data && (
              <span className="text-gray-600 ml-2">
                · refreshed {new Date(data.generated_at_utc).toLocaleString()} ·
                wallet <code className="text-gray-500">{data.wallet.slice(0,6)}…{data.wallet.slice(-4)}</code>
              </span>
            )}
          </p>
        </div>
        <nav className="flex gap-5 text-sm">
          <Link href="/"          className="text-gray-400 hover:text-gray-200">Home</Link>
          <Link href="/trader"    className="text-gray-400 hover:text-gray-200">Trader</Link>
          <Link href="/findings"  className="text-gray-400 hover:text-gray-200">Findings</Link>
          <Link href="/gold-lead" className="text-gray-400 hover:text-gray-200">Gold Lead</Link>
        </nav>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {error && <p className="text-red-400">Failed to load PnL data: {error}</p>}
        {!data && !error && <p className="text-gray-400">Loading…</p>}

        {data && (
          <>
            {/* 7-day totals */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="Total 7-day"      value={fmt$(data.totals.total_pnl_7d)}
                        valueColor={clrFor(data.totals.total_pnl_7d)}
                        sub={`${data.totals.polymarket_trades_7d + data.totals.kalshi_trades_7d} trades`} />
              <StatCard label="Polymarket 7-day" value={fmt$(data.totals.polymarket_pnl_7d)}
                        valueColor={clrFor(data.totals.polymarket_pnl_7d)}
                        sub={`${data.totals.polymarket_trades_7d} trades`} />
              <StatCard label="Kalshi 7-day"     value={data.kalshi_available ? fmt$(data.totals.kalshi_pnl_7d) : 'N/A'}
                        valueColor={data.kalshi_available ? clrFor(data.totals.kalshi_pnl_7d) : 'text-gray-500'}
                        sub={data.kalshi_available ? `${data.totals.kalshi_trades_7d} trades` : 'Kalshi unavailable'} />
              <StatCard label="Best/Worst Day"
                        value={`${fmt$(Math.max(...data.days.map(d => d.total_pnl)))} / ${fmt$(Math.min(...data.days.map(d => d.total_pnl)))}`}
                        valueColor="text-gray-200"
                        sub="best vs worst single day" />
            </div>

            {/* 7-day breakdown table */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-1">Daily breakdown — last 7 days</h2>
              <p className="text-xs text-gray-500 mb-5">
                Cash-flow PnL by UTC date. BUY → cash out, SELL/REDEEM → cash in.
                LoL markets only ({data.kalshi_available ? 'PM keywords + Kalshi KXLOL* prefix' : 'PM only — Kalshi auth unavailable'}).
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 border-b border-gray-800">
                      <th className="text-left  px-2 py-2">Date</th>
                      <th className="text-right px-2 py-2">Polymarket PnL</th>
                      <th className="text-right px-2 py-2">PM trades</th>
                      <th className="text-right px-2 py-2">Kalshi PnL</th>
                      <th className="text-right px-2 py-2">Kalshi trades</th>
                      <th className="text-right px-2 py-2 border-l border-gray-800">Total PnL</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {data.days.map(d => (
                      <tr key={d.date} className="border-b border-gray-800/60">
                        <td className="px-2 py-2 font-sans">
                          {new Date(d.date + 'T00:00:00Z').toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', weekday: 'short',
                          })}
                        </td>
                        <td className={`px-2 py-2 text-right ${clrFor(d.polymarket_pnl)} ${bgFor(d.polymarket_pnl, maxAbs)}`}>
                          {d.polymarket_pnl === 0 ? '—' : fmt$(d.polymarket_pnl)}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-500">{d.polymarket_trades || '—'}</td>
                        <td className={`px-2 py-2 text-right ${clrFor(d.kalshi_pnl)} ${bgFor(d.kalshi_pnl, maxAbs)}`}>
                          {d.kalshi_pnl === 0 ? '—' : fmt$(d.kalshi_pnl)}
                        </td>
                        <td className="px-2 py-2 text-right text-gray-500">{d.kalshi_trades || '—'}</td>
                        <td className={`px-2 py-2 text-right font-bold border-l border-gray-800 ${clrFor(d.total_pnl)} ${bgFor(d.total_pnl, maxAbs)}`}>
                          {d.total_pnl === 0 ? '—' : fmt$(d.total_pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-700">
                      <td className="px-2 py-2 text-gray-400 font-semibold">7-day total</td>
                      <td className={`px-2 py-2 text-right font-mono font-bold ${clrFor(data.totals.polymarket_pnl_7d)}`}>
                        {fmt$(data.totals.polymarket_pnl_7d)}
                      </td>
                      <td className="px-2 py-2 text-right text-gray-500 font-mono">{data.totals.polymarket_trades_7d}</td>
                      <td className={`px-2 py-2 text-right font-mono font-bold ${clrFor(data.totals.kalshi_pnl_7d)}`}>
                        {fmt$(data.totals.kalshi_pnl_7d)}
                      </td>
                      <td className="px-2 py-2 text-right text-gray-500 font-mono">{data.totals.kalshi_trades_7d}</td>
                      <td className={`px-2 py-2 text-right font-mono font-extrabold text-lg border-l border-gray-800 ${clrFor(data.totals.total_pnl_7d)}`}>
                        {fmt$(data.totals.total_pnl_7d)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* 30-day cumulative sparkline */}
            {cum30.length > 0 && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Cumulative PnL — last 30 days</h2>
                <p className="text-xs text-gray-500 mb-4">
                  {cum30.length > 0 && `${cum30[0].date} → ${cum30[cum30.length-1].date} · ${cum30.length} active days`}
                </p>
                <div className="bg-gray-950 rounded p-3 border border-gray-800">
                  <SparkLine data={cum30.map(c => c.cum_pnl)} color={cum30[cum30.length-1].cum_pnl >= 0 ? '#34d399' : '#f87171'} height={120} />
                  <div className="flex justify-between text-xs text-gray-500 mt-2 font-mono">
                    <span>{cum30[0].date}</span>
                    <span className={clrFor(cum30[cum30.length-1].cum_pnl)}>
                      ending {fmt$(cum30[cum30.length-1].cum_pnl)}
                    </span>
                    <span>{cum30[cum30.length-1].date}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Method notes */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="text-sm font-semibold text-gray-300 mb-3">Methodology</h2>
              <ul className="text-xs text-gray-400 space-y-1.5 list-disc pl-5">
                <li><b className="text-gray-200">Trade-date mark-to-current PnL.</b> For every trade you placed on day D, value the position at the <i>current</i> market price (or settle price if the market has resolved). PnL = size × (current_price − entry_price) for BUYs, mirrored for SELLs. Attributed to the trade&apos;s UTC date.</li>
                <li><b className="text-gray-200">What this captures:</b> &ldquo;Was that day&apos;s trading directionally right?&rdquo; — open positions count at today&apos;s mid, resolved positions count at their final price. Updates daily as open markets reprice.</li>
                <li><b className="text-gray-200">Polymarket:</b> filtered by title keywords (LoL, MSI, Worlds, LEC/LCS/LCK/LPL, etc.). Manual exclusions for nullified markets are honored.</li>
                <li><b className="text-gray-200">Kalshi:</b> filtered to KXLOL-prefixed tickers. YES side scored at current yes_mid; NO side at (1 − yes_mid).</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
