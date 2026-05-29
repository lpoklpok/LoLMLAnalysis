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
  start_date:        string
  model_era_start?:  string   // "post-model" cutoff (default 2026-05-18)
  days:              DayRow[]
  cumulative:        CumRow[]
  totals: {
    polymarket_pnl:    number
    kalshi_pnl:        number
    total_pnl:         number
    polymarket_trades: number
    kalshi_trades:     number
  }
}

type RangeMode = 'all' | 'model_era' | '30d' | '90d'

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
  const [range, setRange] = useState<RangeMode>('all')

  useEffect(() => {
    fetch('/pnl_daily.json')
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch(e => setError(String(e)))
  }, [])

  // Filter days by the chosen range. All numbers (totals, cumulative, sparkline,
  // max-for-heatmap) recompute from the filtered subset so the entire page
  // reflects the selection.
  const modelEraStart = data?.model_era_start ?? '2026-05-18'
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = range === 'all'       ? '0000-00-00'
               : range === 'model_era' ? modelEraStart
               : range === '30d'       ? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
               : range === '90d'       ? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
               :                          '0000-00-00'

  const filtered = useMemo(() => {
    if (!data) return null
    const days = data.days.filter(d => d.date >= cutoff && d.date <= today)
    const totals = days.reduce((acc, d) => ({
      polymarket_pnl:    acc.polymarket_pnl    + d.polymarket_pnl,
      kalshi_pnl:        acc.kalshi_pnl        + d.kalshi_pnl,
      total_pnl:         acc.total_pnl         + d.total_pnl,
      polymarket_trades: acc.polymarket_trades + d.polymarket_trades,
      kalshi_trades:     acc.kalshi_trades     + d.kalshi_trades,
    }), { polymarket_pnl: 0, kalshi_pnl: 0, total_pnl: 0, polymarket_trades: 0, kalshi_trades: 0 })
    // Cumulative restarts from 0 inside the window (so the sparkline reads as
    // "what's my PnL gain over this period?").
    let run = 0
    const cumulative: CumRow[] = days.map(d => {
      run += d.total_pnl
      return { date: d.date, polymarket_pnl: d.polymarket_pnl, kalshi_pnl: d.kalshi_pnl, total_pnl: d.total_pnl, cum_pnl: run }
    })
    return { days, totals, cumulative }
  }, [data, cutoff, today])

  const maxAbs = useMemo(() => {
    if (!filtered) return 0
    return Math.max(
      ...filtered.days.flatMap(d => [Math.abs(d.polymarket_pnl), Math.abs(d.kalshi_pnl), Math.abs(d.total_pnl)]),
      1,
    )
  }, [filtered])

  const cum = filtered?.cumulative ?? []

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

        {data && filtered && (
          <>
            {/* Range filter — defaults to All-time (post-Feb start). */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-gray-500 mr-1">Range:</span>
              {([
                { id: 'all',       label: `All time (since ${data.start_date})` },
                { id: 'model_era', label: `Post-model era (since ${modelEraStart})` },
                { id: '90d',       label: 'Last 90d' },
                { id: '30d',       label: 'Last 30d' },
              ] as Array<{ id: RangeMode; label: string }>).map(opt => (
                <button key={opt.id} onClick={() => setRange(opt.id)}
                        className={`px-3 py-1 rounded border text-xs font-medium transition ${
                          range === opt.id
                            ? 'border-emerald-500/60 bg-emerald-900/30 text-emerald-300'
                            : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'
                        }`}>
                  {opt.label}
                </button>
              ))}
              <span className="ml-auto text-xs text-gray-500 font-mono">{filtered.days.length} days · {filtered.totals.polymarket_trades + filtered.totals.kalshi_trades} trades</span>
            </div>

            {/* Totals */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label={range === 'all' ? `Total since ${data.start_date}` :
                                range === 'model_era' ? `Total since ${modelEraStart}` :
                                range === '90d' ? 'Last 90 days' : 'Last 30 days'}
                        value={fmt$(filtered.totals.total_pnl)}
                        valueColor={clrFor(filtered.totals.total_pnl)}
                        sub={`${filtered.totals.polymarket_trades + filtered.totals.kalshi_trades} trades`} />
              <StatCard label="Polymarket" value={fmt$(filtered.totals.polymarket_pnl)}
                        valueColor={clrFor(filtered.totals.polymarket_pnl)}
                        sub={`${filtered.totals.polymarket_trades} trades`} />
              <StatCard label="Kalshi"     value={data.kalshi_available ? fmt$(filtered.totals.kalshi_pnl) : 'N/A'}
                        valueColor={data.kalshi_available ? clrFor(filtered.totals.kalshi_pnl) : 'text-gray-500'}
                        sub={data.kalshi_available ? `${filtered.totals.kalshi_trades} trades` : 'Kalshi unavailable'} />
              <StatCard label="Best/Worst Day"
                        value={filtered.days.length === 0 ? '—' :
                          `${fmt$(Math.max(...filtered.days.map(d => d.total_pnl)))} / ${fmt$(Math.min(...filtered.days.map(d => d.total_pnl)))}`}
                        valueColor="text-gray-200"
                        sub="best vs worst single day" />
            </div>

            {/* Daily breakdown table for current range */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-gray-100 mb-1">Daily breakdown — {range === 'all' ? `since ${data.start_date}` : range === 'model_era' ? `since ${modelEraStart} (post-model)` : range === '90d' ? 'last 90 days' : 'last 30 days'}</h2>
              <p className="text-xs text-gray-500 mb-5">
                Trade-date mark-to-current PnL by UTC date.
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
                    {filtered.days.map(d => (
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
                      <td className="px-2 py-2 text-gray-400 font-semibold">Total</td>
                      <td className={`px-2 py-2 text-right font-mono font-bold ${clrFor(filtered.totals.polymarket_pnl)}`}>
                        {fmt$(filtered.totals.polymarket_pnl)}
                      </td>
                      <td className="px-2 py-2 text-right text-gray-500 font-mono">{filtered.totals.polymarket_trades}</td>
                      <td className={`px-2 py-2 text-right font-mono font-bold ${clrFor(filtered.totals.kalshi_pnl)}`}>
                        {fmt$(filtered.totals.kalshi_pnl)}
                      </td>
                      <td className="px-2 py-2 text-right text-gray-500 font-mono">{filtered.totals.kalshi_trades}</td>
                      <td className={`px-2 py-2 text-right font-mono font-extrabold text-lg border-l border-gray-800 ${clrFor(filtered.totals.total_pnl)}`}>
                        {fmt$(filtered.totals.total_pnl)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Cumulative sparkline since start_date */}
            {cum.length > 0 && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Cumulative PnL — {range === 'all' ? `since ${data.start_date}` : range === 'model_era' ? `since ${modelEraStart} (post-model)` : range === '90d' ? 'last 90 days' : 'last 30 days'}</h2>
                <p className="text-xs text-gray-500 mb-4">
                  {`${cum[0].date} → ${cum[cum.length-1].date} · ${cum.length} days`}
                </p>
                <div className="bg-gray-950 rounded p-3 border border-gray-800">
                  <SparkLine data={cum.map(c => c.cum_pnl)} color={cum[cum.length-1].cum_pnl >= 0 ? '#34d399' : '#f87171'} height={120} />
                  <div className="flex justify-between text-xs text-gray-500 mt-2 font-mono">
                    <span>{cum[0].date}</span>
                    <span className={clrFor(cum[cum.length-1].cum_pnl)}>
                      ending {fmt$(cum[cum.length-1].cum_pnl)}
                    </span>
                    <span>{cum[cum.length-1].date}</span>
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
