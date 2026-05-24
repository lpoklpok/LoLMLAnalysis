'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'

// ── Types ────────────────────────────────────────────────────────────────

interface MarketRow {
  condition_id: string
  event_slug: string
  event_title: string
  tournament: string
  team1: string
  team2: string
  market_type: string
}
interface BalanceSummary {
  generated_at_utc: string
  markets: (MarketRow & { last_trade_price: number; total_volume_usd: number })[]
}

interface MmConfig {
  id: number
  condition_id: string
  market_type: string
  outcome_index: number
  side: 'bid' | 'offer' | 'both'
  event_slug: string | null
  event_title: string | null
  team1: string | null
  team2: string | null
  outcome_label: string | null
  asset_id: string | null
  enabled: boolean
  strategy: 'join_best' | 'penny_back'
  quote_size_usd: number
  max_size_pct: number
  max_fill_usd: number
  max_position_shares: number
  min_spread_cents: number
  min_level_size_usd: number
  order_ttl_sec: number
}

interface MmState {
  condition_id: string
  outcome_index: number
  side: string
  active_order_id: string | null
  active_price: number | null
  active_size_shares: number | null
  fills_today_usd: number
  position_shares: number
  last_book_top_price: number | null
  last_book_top_size: number | null
  last_quote_ts: string | null
  paused_reason: string | null
  updated_at: string
}

interface KillSwitch {
  id: number
  killed: boolean
  reason: string | null
  updated_at: string
}

interface QuoteLogRow {
  id: number
  ts: string
  condition_id: string
  outcome_index: number
  side: string
  action: string
  price: number | null
  size_shares: number | null
  reason: string | null
  dry_run: boolean
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function MmPage() {
  const [configs, setConfigs] = useState<MmConfig[]>([])
  const [states,  setStates]  = useState<Record<string, MmState>>({})
  const [kill,    setKill]    = useState<KillSwitch | null>(null)
  const [logs,    setLogs]    = useState<QuoteLogRow[]>([])
  const [balance, setBalance] = useState<BalanceSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  const stateKey = (c: { condition_id: string; outcome_index: number; side: string }) =>
    `${c.condition_id}|${c.outcome_index}|${c.side}`

  const refresh = useCallback(async () => {
    const [cfg, st, ks, lg, bal] = await Promise.all([
      supabase.from('mm_config').select('*').order('updated_at', { ascending: false }),
      supabase.from('mm_state').select('*'),
      supabase.from('mm_kill_switch').select('*').eq('id', 1).single(),
      supabase.from('mm_quotes_log').select('*').order('ts', { ascending: false }).limit(50),
      fetch('/api/poly-flow').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
    setConfigs((cfg.data ?? []) as MmConfig[])
    const sMap: Record<string, MmState> = {}
    for (const s of (st.data ?? []) as MmState[]) sMap[stateKey(s)] = s
    setStates(sMap)
    setKill(ks.data as KillSwitch | null)
    setLogs((lg.data ?? []) as QuoteLogRow[])
    setBalance(bal as BalanceSummary | null)
    setLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5_000)
    return () => clearInterval(id)
  }, [refresh])

  async function flipKill() {
    if (!kill) return
    const newKilled = !kill.killed
    const reason = newKilled
      ? prompt('Reason for emergency stop?', 'manual stop') || 'manual stop'
      : null
    await supabase.from('mm_kill_switch')
      .update({ killed: newKilled, reason, updated_at: new Date().toISOString() })
      .eq('id', 1)
    refresh()
  }

  async function toggleEnabled(c: MmConfig) {
    await supabase.from('mm_config')
      .update({ enabled: !c.enabled, updated_at: new Date().toISOString() })
      .eq('id', c.id)
    refresh()
  }

  async function deleteConfig(c: MmConfig) {
    if (!confirm(`Delete MM config for ${c.event_title} (${c.market_type}, ${c.outcome_label}, ${c.side})?`)) return
    await supabase.from('mm_config').delete().eq('id', c.id)
    refresh()
  }

  async function updateField(c: MmConfig, field: keyof MmConfig, value: unknown) {
    await supabase.from('mm_config')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq('id', c.id)
    refresh()
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-blue-400">Market Maker</h1>
            <p className="text-sm text-gray-400 mt-1">Polymarket LoL · DRY_RUN until you flip MM_LIVE on the worker</p>
          </div>
          {kill && (
            <button
              onClick={flipKill}
              className={`px-6 py-3 rounded-lg font-bold text-sm border-2 transition-colors ${
                kill.killed
                  ? 'bg-gray-800 border-gray-700 text-gray-400 hover:border-green-500 hover:text-green-400'
                  : 'bg-red-700/40 border-red-600 text-red-200 hover:bg-red-700/60'
              }`}
              title={kill.killed ? 'All quoting halted. Click to ENABLE (worker will start.)' : 'Worker is live. Click to EMERGENCY STOP.'}
            >
              {kill.killed ? '▶ ENABLE MM' : '■ EMERGENCY STOP'}
            </button>
          )}
        </div>
        {kill && (
          <p className={`text-xs mt-2 font-mono ${kill.killed ? 'text-yellow-500' : 'text-green-400'}`}>
            kill_switch: {kill.killed ? `KILLED — ${kill.reason ?? '(no reason)'}` : 'ACTIVE — orders may be placed'}
            <span className="text-gray-600 ml-3">last updated {new Date(kill.updated_at).toLocaleString()}</span>
          </p>
        )}
      </header>

      <div className="px-6 py-4 border-b border-gray-800 flex gap-6 flex-wrap items-center">
        <Link href="/"            className="text-sm text-gray-400 hover:text-gray-200">Dashboard</Link>
        <Link href="/predictions" className="text-sm text-gray-400 hover:text-gray-200">Predictions</Link>
        <Link href="/games"       className="text-sm text-gray-400 hover:text-gray-200">Game Explorer</Link>
        <Link href="/trader"      className="text-sm text-gray-400 hover:text-gray-200">Trader</Link>
        <Link href="/flow"        className="text-sm text-gray-400 hover:text-gray-200">Order Flow</Link>
        <span className="text-sm text-yellow-400 font-medium">Market Maker</span>
      </div>

      <main className="px-6 py-6 max-w-7xl mx-auto">
        {/* Configs */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200">Configured markets ({configs.length})</h2>
            <button
              onClick={() => setShowAdd(true)}
              className="text-xs px-3 py-1.5 bg-blue-700/40 border border-blue-600 text-blue-200 rounded hover:bg-blue-700/60"
            >
              + Add market
            </button>
          </div>

          {loading ? (
            <p className="text-gray-500 text-sm">Loading…</p>
          ) : configs.length === 0 ? (
            <p className="text-gray-500 text-sm">No markets configured. Click <span className="text-blue-400">+ Add market</span> to set one up.</p>
          ) : (
            <div className="space-y-3">
              {configs.map(c => {
                const s = states[stateKey(c)]
                return (
                  <ConfigCard
                    key={c.id}
                    config={c}
                    state={s}
                    onToggle={() => toggleEnabled(c)}
                    onDelete={() => deleteConfig(c)}
                    onChange={(field, value) => updateField(c, field, value)}
                  />
                )
              })}
            </div>
          )}
        </section>

        {/* Activity log */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-gray-200 mb-3">Recent activity</h2>
          {logs.length === 0 ? (
            <p className="text-gray-500 text-xs">No activity yet.</p>
          ) : (
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500 w-32">When</th>
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500 w-20">Action</th>
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Market</th>
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500 w-16">Side</th>
                  <th className="text-right py-1.5 pr-4 font-medium text-gray-500 w-20">Price</th>
                  <th className="text-right py-1.5 pr-4 font-medium text-gray-500 w-20">Size</th>
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Reason</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l => (
                  <tr key={l.id} className="border-b border-gray-800/30">
                    <td className="py-1 pr-4 font-mono text-gray-500">{new Date(l.ts).toLocaleTimeString()}</td>
                    <td className={`py-1 pr-4 font-mono ${
                      l.action === 'quote'  ? 'text-green-400' :
                      l.action === 'cancel' ? 'text-yellow-300' :
                      l.action === 'fill'   ? 'text-blue-300' :
                      l.action === 'pause'  ? 'text-red-300' :
                      'text-gray-300'
                    }`}>{l.action}{l.dry_run ? ' (dry)' : ''}</td>
                    <td className="py-1 pr-4 text-gray-300">{l.condition_id.slice(0,10)}…</td>
                    <td className="py-1 pr-4 font-mono text-gray-400">{l.side} #{l.outcome_index}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300 text-right">{l.price?.toFixed(3) ?? '—'}</td>
                    <td className="py-1 pr-4 font-mono text-gray-300 text-right">{l.size_shares != null ? Math.round(l.size_shares).toLocaleString() : '—'}</td>
                    <td className="py-1 pr-4 text-gray-500">{l.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>

      {/* Add-market modal */}
      {showAdd && balance && (
        <AddMarketModal
          balance={balance}
          existing={configs}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); refresh() }}
        />
      )}
    </div>
  )
}

// ── Config row card ───────────────────────────────────────────────────────

function ConfigCard({
  config, state, onToggle, onDelete, onChange,
}: {
  config: MmConfig
  state?: MmState
  onToggle: () => void
  onDelete: () => void
  onChange: (field: keyof MmConfig, value: unknown) => void
}) {
  const c = config
  const s = state
  const enabled = c.enabled
  return (
    <div className={`border rounded-lg p-4 ${enabled ? 'border-green-700/60 bg-green-950/10' : 'border-gray-800 bg-gray-900/30'}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={onToggle}
          className={`mt-1 px-3 py-1 rounded text-xs font-semibold border ${
            enabled
              ? 'bg-green-700/40 border-green-600 text-green-200'
              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
          }`}
        >{enabled ? 'ON' : 'OFF'}</button>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-gray-100 truncate">
                {c.team1} vs {c.team2}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {c.market_type} · outcome={c.outcome_label} · side={c.side}
                {s?.paused_reason && <span className="ml-3 text-red-300">PAUSED: {s.paused_reason}</span>}
              </div>
            </div>
            <button onClick={onDelete} className="text-xs text-gray-500 hover:text-red-400">Delete</button>
          </div>

          {/* Live state */}
          {s && (
            <div className="mt-2 text-xs font-mono text-gray-400 grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>Book top: <span className="text-gray-200">{s.last_book_top_price?.toFixed(3) ?? '—'}</span> @ <span className="text-gray-200">{s.last_book_top_size?.toFixed(0) ?? '—'}</span></div>
              <div>Active order: <span className="text-yellow-300">{s.active_price ? `${s.active_price.toFixed(3)} × ${s.active_size_shares?.toFixed(0)}` : 'none'}</span></div>
              <div>Fills today: <span className={s.fills_today_usd >= c.max_fill_usd * 0.8 ? 'text-red-300' : 'text-gray-200'}>${s.fills_today_usd.toFixed(0)}</span> / ${c.max_fill_usd.toFixed(0)}</div>
              <div>Position: <span className="text-gray-200">{s.position_shares.toFixed(0)} sh</span></div>
            </div>
          )}

          {/* Params */}
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <ParamSelect label="Strategy" value={c.strategy} options={[['join_best','Join best'],['penny_back','Penny back']]} onChange={v => onChange('strategy', v)} />
            <ParamNumber label="Quote size $"  value={c.quote_size_usd}    step={5}    min={5}    onChange={v => onChange('quote_size_usd', v)} />
            <ParamNumber label="Max size %"    value={c.max_size_pct * 100} step={5}   min={1} max={100} onChange={v => onChange('max_size_pct', v/100)} />
            <ParamNumber label="Max fill $"    value={c.max_fill_usd}      step={100}  min={0}    onChange={v => onChange('max_fill_usd', v)} />
            <ParamNumber label="Min level $"   value={c.min_level_size_usd} step={5}   min={0}    onChange={v => onChange('min_level_size_usd', v)} />
            <ParamNumber label="TTL s"         value={c.order_ttl_sec}     step={10}   min={5}    onChange={v => onChange('order_ttl_sec', v)} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ParamSelect({ label, value, options, onChange }: { label: string; value: string; options: [string,string][]; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-gray-500">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs">
        {options.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}
      </select>
    </label>
  )
}

function ParamNumber({ label, value, step, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-gray-500">{label}</span>
      <input
        type="number"
        defaultValue={value}
        step={step ?? 1}
        min={min}
        max={max}
        onBlur={e => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v) && v !== value) onChange(v)
        }}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs w-20"
      />
    </label>
  )
}

// ── Add-market modal ──────────────────────────────────────────────────────

function AddMarketModal({
  balance, existing, onClose, onAdded,
}: {
  balance: BalanceSummary
  existing: MmConfig[]
  onClose: () => void
  onAdded: () => void
}) {
  const [eventSlug, setEventSlug] = useState('')
  const [submarketKey, setSubmarketKey] = useState('')  // condition_id
  const [outcomeIdx, setOutcomeIdx]   = useState(0)
  const [side, setSide]               = useState<'bid'|'offer'|'both'>('both')

  const events = useMemo(() => {
    const seen = new Map<string, MarketRow>()
    for (const m of balance.markets) {
      if (m.event_slug && !seen.has(m.event_slug)) seen.set(m.event_slug, m)
    }
    return [...seen.values()].sort((a,b) => a.event_title.localeCompare(b.event_title))
  }, [balance])

  const submarkets = useMemo(() =>
    balance.markets.filter(m => m.event_slug === eventSlug),
  [balance, eventSlug])

  const selectedSubmarket = submarkets.find(m => m.condition_id === submarketKey)

  async function add() {
    if (!selectedSubmarket) return
    const outcome_label = outcomeIdx === 0 ? selectedSubmarket.team1 : selectedSubmarket.team2
    // Try to pull the asset_id from the recent_trades feed (its known there)
    let asset_id: string | null = null
    try {
      const r = await fetch('/api/poly-trades')
      if (r.ok) {
        const j = await r.json()
        // recent_trades doesn't currently expose token id directly; worker can fetch.
        asset_id = null
      }
    } catch {}

    const row = {
      condition_id: selectedSubmarket.condition_id,
      market_type:  selectedSubmarket.market_type,
      outcome_index: outcomeIdx,
      side,
      event_slug:   selectedSubmarket.event_slug,
      event_title:  selectedSubmarket.event_title,
      team1:        selectedSubmarket.team1,
      team2:        selectedSubmarket.team2,
      outcome_label,
      asset_id,
      enabled:      false,    // start disabled
      strategy:     'join_best',
      quote_size_usd: 50,
      max_size_pct:   0.25,
      max_fill_usd:   500,
    }
    const dupe = existing.find(c =>
      c.condition_id === row.condition_id && c.outcome_index === row.outcome_index && c.side === row.side
    )
    if (dupe) {
      alert('A config for this submarket+outcome+side already exists.')
      return
    }
    const { error } = await supabase.from('mm_config').insert(row)
    if (error) {
      alert(`Insert failed: ${error.message}`)
      return
    }
    onAdded()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Add MM market</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200">✕</button>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Event</label>
            <select value={eventSlug} onChange={e => { setEventSlug(e.target.value); setSubmarketKey('') }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5">
              <option value="">— pick event —</option>
              {events.map(e => <option key={e.event_slug} value={e.event_slug}>{e.team1} vs {e.team2} ({e.tournament || e.event_slug})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Submarket</label>
            <select value={submarketKey} onChange={e => setSubmarketKey(e.target.value)} disabled={!eventSlug}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 disabled:opacity-50">
              <option value="">— pick submarket —</option>
              {submarkets.map(m => <option key={m.condition_id} value={m.condition_id}>{m.market_type}</option>)}
            </select>
          </div>
          {selectedSubmarket && (
            <>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Outcome</label>
                <select value={outcomeIdx} onChange={e => setOutcomeIdx(parseInt(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5">
                  <option value={0}>{selectedSubmarket.team1}</option>
                  <option value={1}>{selectedSubmarket.team2}</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Side</label>
                <select value={side} onChange={e => setSide(e.target.value as 'bid'|'offer'|'both')}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5">
                  <option value="bid">Bid only (buy at best bid)</option>
                  <option value="offer">Offer only (sell at best ask)</option>
                  <option value="both">Both sides</option>
                </select>
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button
            onClick={add}
            disabled={!selectedSubmarket}
            className="px-4 py-2 text-sm bg-blue-700/40 border border-blue-600 text-blue-200 rounded hover:bg-blue-700/60 disabled:opacity-40"
          >Add (starts OFF)</button>
        </div>
      </div>
    </div>
  )
}
