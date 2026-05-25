'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'

interface AutoRules {
  id: number
  enabled: boolean
  lookahead_hours: number
  max_concurrent_capital_usd: number
  default_quote_size_shares: number
  default_strategy: 'penny_back' | 'join_best'
  tournament_filter: string[] | null
  big_fill_alert_usd: number
  discord_webhook_url: string | null
  updated_at: string
}

interface FillRow {
  id: number
  ts: string
  condition_id: string
  outcome_index: number
  side: string
  price: number | null
  size_shares: number | null
  reason: string | null
}

interface EnabledRow {
  condition_id: string
  event_slug: string | null
  event_title: string | null
  market_type: string
  outcome_index: number
  outcome_label: string | null
  quote_size_shares: number | null
}

interface PnlRow {
  day: string
  cost_basis: number
  mtm_value: number
  unrealized_pnl: number
  fills_count: number
  fills_usd: number
  updated_at: string
}

export default function SystematicPage() {
  const [rules, setRules] = useState<AutoRules | null>(null)
  const [enabled, setEnabled] = useState<EnabledRow[]>([])
  const [fills, setFills] = useState<FillRow[]>([])
  const [pnl, setPnl] = useState<PnlRow[]>([])
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    const [r, e, f, p] = await Promise.all([
      supabase.from('mm_auto_rules').select('*').eq('id', 1).single(),
      supabase.from('mm_config')
        .select('condition_id,event_slug,event_title,market_type,outcome_index,outcome_label,quote_size_shares')
        .or('bid_enabled.eq.true,offer_enabled.eq.true'),
      supabase.from('mm_quotes_log').select('*').eq('action', 'fill').order('ts', { ascending: false }).limit(30),
      supabase.from('mm_pnl_daily').select('*').order('day', { ascending: false }).limit(14),
    ])
    setRules(r.data as AutoRules | null)
    setEnabled((e.data ?? []) as EnabledRow[])
    setFills((f.data ?? []) as FillRow[])
    setPnl((p.data ?? []) as PnlRow[])
  }, [])

  useEffect(() => {
    refresh()
    const ch = supabase
      .channel('systematic')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mm_auto_rules' },
          () => refresh())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mm_quotes_log' },
          (p) => {
            const row = p.new as FillRow
            if (row.condition_id && (row as { action?: string }).action === 'fill') {
              setFills(prev => [row, ...prev].slice(0, 30))
            }
          })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mm_pnl_daily' },
          (p) => {
            const row = (p.new ?? p.old) as PnlRow
            if (!row) return
            setPnl(prev => {
              const without = prev.filter(x => x.day !== row.day)
              return [row, ...without].sort((a,b) => b.day.localeCompare(a.day)).slice(0, 14)
            })
          })
      .subscribe()
    const id = setInterval(refresh, 30_000)
    return () => { clearInterval(id); supabase.removeChannel(ch) }
  }, [refresh])

  const patchRules = async (patch: Partial<AutoRules>) => {
    setRules(prev => prev ? { ...prev, ...patch } as AutoRules : prev)  // optimistic
    setSaving(true)
    try {
      await supabase.from('mm_auto_rules')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', 1)
    } finally { setSaving(false) }
  }

  if (!rules) return <div className="p-8 text-gray-400">Loading…</div>

  // Group enabled rows by event for the active-event list
  const eventGroups = new Map<string, { title: string; submarkets: number }>()
  for (const r of enabled) {
    const key = r.event_slug || r.condition_id
    const cur = eventGroups.get(key) ?? { title: r.event_title ?? r.condition_id, submarkets: 0 }
    cur.submarkets += 1
    eventGroups.set(key, cur)
  }

  // Capital estimate: sum quote_size_shares * 0.5 (rough mid)
  const estCapital = enabled.reduce((s, r) => s + (Number(r.quote_size_shares) || 20) * 0.5, 0)
  const capRoom = Math.max(0, Number(rules.max_concurrent_capital_usd) - estCapital)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <h1 className="text-lg font-semibold">Systematic Trading</h1>
        <span className={`px-2 py-0.5 rounded text-xs font-mono ${rules.enabled ? 'bg-green-700/40 text-green-200' : 'bg-gray-800 text-gray-500'}`}>
          {rules.enabled ? 'RUNNING' : 'PAUSED'}
        </span>
        <span className="text-xs text-gray-500 ml-auto">{saving ? 'saving…' : ''}</span>
        <Link href="/mm" className="text-xs text-blue-400 hover:underline">/mm (manual) →</Link>
      </header>

      <main className="px-6 py-6 max-w-6xl mx-auto space-y-6">
        {/* Today's PnL — most prominent block on the page */}
        {(() => {
          const today = new Date().toISOString().slice(0, 10)
          const todayRow = pnl.find(p => p.day === today)
          const prevRow  = pnl.find(p => p.day < today)
          const dayDelta = todayRow && prevRow
            ? Number(todayRow.unrealized_pnl) - Number(prevRow.unrealized_pnl)
            : null
          const upnl = todayRow ? Number(todayRow.unrealized_pnl) : 0
          const col = upnl >= 0 ? 'text-green-300' : 'text-red-300'
          return (
            <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center gap-8">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Today MTM PnL</div>
                <div className={`text-3xl font-mono font-semibold ${col}`}>
                  {upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}
                </div>
                {dayDelta != null && (
                  <div className="text-[11px] text-gray-500 mt-1">
                    Δ vs yesterday: <span className={dayDelta >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {dayDelta >= 0 ? '+' : ''}${dayDelta.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
              <div className="border-l border-gray-800 pl-8">
                <div className="text-xs text-gray-500">Cost basis</div>
                <div className="font-mono text-gray-200">${Number(todayRow?.cost_basis ?? 0).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">MTM value</div>
                <div className="font-mono text-gray-200">${Number(todayRow?.mtm_value ?? 0).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Fills today</div>
                <div className="font-mono text-gray-200">
                  {todayRow?.fills_count ?? 0} · ${Number(todayRow?.fills_usd ?? 0).toFixed(0)}
                </div>
              </div>
              <div className="ml-auto text-[10px] text-gray-600">
                updated {todayRow ? new Date(todayRow.updated_at).toLocaleTimeString() : '—'}
              </div>
            </section>
          )
        })()}

        {/* Daily PnL history */}
        {pnl.length > 1 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-200 mb-3">Daily PnL ({pnl.length} days)</h2>
            <table className="w-full text-xs whitespace-nowrap">
              <thead><tr className="border-b border-gray-800 text-gray-500">
                <th className="text-left py-1.5 pr-4 font-medium w-24">Day</th>
                <th className="text-right py-1.5 pr-4 font-medium w-28">Unrealized PnL</th>
                <th className="text-right py-1.5 pr-4 font-medium w-24">Δ vs prior</th>
                <th className="text-right py-1.5 pr-4 font-medium w-24">Cost</th>
                <th className="text-right py-1.5 pr-4 font-medium w-24">MTM</th>
                <th className="text-right py-1.5 pr-4 font-medium w-16">Fills</th>
                <th className="text-right py-1.5 pr-4 font-medium w-24">Volume</th>
              </tr></thead>
              <tbody>
                {pnl.map((row, i) => {
                  const next = pnl[i + 1]
                  const delta = next ? Number(row.unrealized_pnl) - Number(next.unrealized_pnl) : null
                  const c = Number(row.unrealized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'
                  return (
                    <tr key={row.day} className="border-b border-gray-800/30">
                      <td className="py-1 pr-4 font-mono text-gray-300">{row.day}</td>
                      <td className={`py-1 pr-4 font-mono text-right ${c}`}>
                        {Number(row.unrealized_pnl) >= 0 ? '+' : ''}${Number(row.unrealized_pnl).toFixed(2)}
                      </td>
                      <td className={`py-1 pr-4 font-mono text-right ${delta == null ? 'text-gray-600' : delta >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {delta == null ? '—' : `${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`}
                      </td>
                      <td className="py-1 pr-4 font-mono text-gray-400 text-right">${Number(row.cost_basis).toFixed(0)}</td>
                      <td className="py-1 pr-4 font-mono text-gray-400 text-right">${Number(row.mtm_value).toFixed(0)}</td>
                      <td className="py-1 pr-4 font-mono text-gray-400 text-right">{row.fills_count}</td>
                      <td className="py-1 pr-4 font-mono text-gray-400 text-right">${Number(row.fills_usd).toFixed(0)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )}

        {/* Master switch */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold mb-1">Master switch</div>
            <div className="text-xs text-gray-500">
              When ON, the worker auto-enables bid+offer on every upcoming Polymarket LoL event within the lookahead window and disables stale rows. mm_kill_switch still overrides everything.
            </div>
          </div>
          <button
            onClick={() => patchRules({ enabled: !rules.enabled })}
            className={`px-4 py-2 rounded font-semibold ${rules.enabled
              ? 'bg-red-700 hover:bg-red-600 text-red-100'
              : 'bg-green-700 hover:bg-green-600 text-green-100'}`}>
            {rules.enabled ? 'STOP' : 'START'}
          </button>
        </section>

        {/* Configurable settings */}
        <section className="grid grid-cols-2 gap-4">
          <ConfigField label="Lookahead (hours)" value={rules.lookahead_hours} type="number"
            onChange={v => patchRules({ lookahead_hours: Number(v) })}
            hint="Auto-enable events whose date is within this many hours from now." />
          <ConfigField label="Max concurrent capital (USD)" value={rules.max_concurrent_capital_usd} type="number"
            onChange={v => patchRules({ max_concurrent_capital_usd: Number(v) })}
            hint="Stop enabling new events once this notional cap is hit." />
          <ConfigField label="Default quote size (shares)" value={rules.default_quote_size_shares} type="number"
            onChange={v => patchRules({ default_quote_size_shares: Number(v) })}
            hint="Applied to all newly auto-enabled rows." />
          <ConfigField label="Default strategy" value={rules.default_strategy} type="select"
            options={['penny_back', 'join_best']}
            onChange={v => patchRules({ default_strategy: v as 'penny_back' | 'join_best' })}
            hint="penny_back = 1¢ behind top; join_best = match top." />
          <ConfigField label="Big-fill alert threshold (USD)" value={rules.big_fill_alert_usd} type="number"
            onChange={v => patchRules({ big_fill_alert_usd: Number(v) })}
            hint="Discord ping when any single fill exceeds this notional." />
          <ConfigField label="Discord webhook URL" value={rules.discord_webhook_url ?? ''} type="text"
            onChange={v => patchRules({ discord_webhook_url: String(v) || null })}
            hint="Leave blank to disable alerts." />
        </section>

        {/* Live capital + event count */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div><span className="text-gray-500 mr-2">Events live:</span><span className="font-mono">{eventGroups.size}</span></div>
          <div><span className="text-gray-500 mr-2">Sides active:</span><span className="font-mono">{enabled.length}</span></div>
          <div><span className="text-gray-500 mr-2">Est. capital deployed:</span><span className="font-mono">${estCapital.toFixed(0)}</span></div>
          <div><span className="text-gray-500 mr-2">Room remaining:</span><span className="font-mono">${capRoom.toFixed(0)}</span></div>
        </section>

        {/* Active events */}
        <section>
          <h2 className="text-sm font-semibold text-gray-200 mb-3">Active events ({eventGroups.size})</h2>
          {eventGroups.size === 0 ? (
            <p className="text-gray-500 text-xs">No events currently active. Turn on the master switch.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {[...eventGroups.entries()].map(([slug, info]) => (
                <li key={slug} className="border-b border-gray-800/30 py-1">
                  <span className="text-gray-300">{info.title}</span>
                  <span className="text-gray-600 ml-2">· {info.submarkets} submarket{info.submarkets === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent fills */}
        <section>
          <h2 className="text-sm font-semibold text-gray-200 mb-3">Recent fills</h2>
          {fills.length === 0 ? (
            <p className="text-gray-500 text-xs">No fills yet.</p>
          ) : (
            <table className="w-full text-xs whitespace-nowrap">
              <thead><tr className="border-b border-gray-800 text-gray-500">
                <th className="text-left py-1.5 pr-4 font-medium w-28">When</th>
                <th className="text-left py-1.5 pr-4 font-medium w-16">Side</th>
                <th className="text-right py-1.5 pr-4 font-medium w-20">Price</th>
                <th className="text-right py-1.5 pr-4 font-medium w-20">Size</th>
                <th className="text-right py-1.5 pr-4 font-medium w-24">Notional</th>
                <th className="text-left py-1.5 pr-4 font-medium">Reason</th>
              </tr></thead>
              <tbody>
                {fills.map(f => (
                  <tr key={f.id} className="border-b border-gray-800/30">
                    <td className="py-1 pr-4 font-mono text-gray-500">{new Date(f.ts).toLocaleTimeString()}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300">{f.side}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300 text-right">{f.price?.toFixed(3) ?? '—'}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300 text-right">{f.size_shares != null ? Math.round(f.size_shares).toLocaleString() : '—'}</td>
                    <td className="py-1 pr-4 font-mono text-blue-300 text-right">
                      {f.price != null && f.size_shares != null ? `$${(f.price * f.size_shares).toFixed(2)}` : '—'}
                    </td>
                    <td className="py-1 pr-4 text-gray-500">{f.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  )
}

function ConfigField({ label, value, type, options, onChange, hint }: {
  label: string
  value: string | number
  type: 'text' | 'number' | 'select'
  options?: string[]
  onChange: (v: string | number) => void
  hint?: string
}) {
  const debounceRef = useRef<number | null>(null)
  const [local, setLocal] = useState<string>(String(value ?? ''))
  useEffect(() => { setLocal(String(value ?? '')) }, [value])
  const save = (v: string) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      onChange(type === 'number' ? Number(v) : v)
    }, 400)
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <label className="text-xs text-gray-500 block mb-1">{label}</label>
      {type === 'select' ? (
        <select
          value={String(value)}
          onChange={e => onChange(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono">
          {options?.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={type}
          value={local}
          onChange={e => { setLocal(e.target.value); save(e.target.value) }}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono" />
      )}
      {hint && <div className="text-[10px] text-gray-600 mt-1">{hint}</div>}
    </div>
  )
}
