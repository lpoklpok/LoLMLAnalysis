'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

interface PmPosition {
  asset:        string
  conditionId:  string
  size:         number
  avgPrice:     number
  curPrice:     number
  currentValue: number
  cashPnl:      number
  realizedPnl:  number
  title:        string
  slug:         string
  eventSlug:    string
  outcome:      string
  endDate:      string
  icon:         string
  redeemable:   boolean
}

interface Shark {
  wallet_address: string
  name:           string | null
  type:           'sharp' | 'fade' | 'watch'
  emoji:          string | null
  notes:          string | null
  active:         boolean
  added_at:       string
  positions:      PmPosition[]
  position_count: number
  total_value:    number
  total_pnl:      number
  fetched_ok:     boolean
  error?:         string
}

type SortKey = 'name' | 'value' | 'pnl' | 'count'

const LOL_PREFIXES = ['lol-', 'lck-', 'lec-', 'lpl-', 'lcs-']
const isLol = (p: PmPosition) =>
  LOL_PREFIXES.some(pre =>
    (p.slug || '').toLowerCase().startsWith(pre) ||
    (p.eventSlug || '').toLowerCase().startsWith(pre)
  )

const trunc  = (a: string) => `${a.slice(0,6)}…${a.slice(-4)}`
const dollar = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US',{maximumFractionDigits:0})}`
const pct    = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

export default function SharksPage() {
  const [sharks,   setSharks]   = useState<Shark[]>([])
  const [err,      setErr]      = useState<string | null>(null)
  const [loading,  setLoading]  = useState<boolean>(true)
  const [filter,   setFilter]   = useState<string>('')
  const [sort,     setSort]     = useState<SortKey>('value')
  const [lolOnly,  setLolOnly]  = useState<boolean>(true)
  const [openOnly, setOpenOnly] = useState<boolean>(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // add-shark form
  const [newWallet, setNewWallet] = useState('')
  const [newName,   setNewName]   = useState('')
  const [newType,   setNewType]   = useState<'sharp'|'fade'|'watch'>('sharp')
  const [adding,    setAdding]    = useState(false)

  async function load() {
    try {
      const r = await fetch('/api/sharks', { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setSharks(j.sharks ?? []); setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  async function addShark() {
    if (!newWallet.trim()) return
    setAdding(true)
    try {
      const r = await fetch('/api/sharks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          wallet: newWallet.trim(),
          name:   newName.trim() || undefined,
          type:   newType,
        }),
      })
      if (!r.ok) {
        const j = await r.json().catch(()=>({}))
        alert(`add failed: ${j.error ?? r.status}`)
      } else {
        setNewWallet(''); setNewName('')
        await load()
      }
    } finally { setAdding(false) }
  }

  async function removeShark(wallet: string, name: string | null) {
    if (!confirm(`Remove ${name ?? trunc(wallet)} from sharks?`)) return
    const r = await fetch(`/api/sharks?wallet=${encodeURIComponent(wallet)}`, { method: 'DELETE' })
    if (!r.ok) alert(`delete failed: ${r.status}`)
    await load()
  }

  async function saveEdit(wallet: string, name: string, notes: string, type: 'sharp'|'fade'|'watch') {
    const r = await fetch('/api/sharks', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ wallet, name: name || undefined, notes: notes || undefined, type }),
    })
    if (!r.ok) {
      const j = await r.json().catch(()=>({}))
      alert(`save failed: ${j.error ?? r.status}`)
    }
    await load()
  }

  function toggle(w: string) {
    setExpanded(s => {
      const ns = new Set(s)
      if (ns.has(w)) ns.delete(w); else ns.add(w)
      return ns
    })
  }

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase()
    let xs = sharks.map(s => {
      let positions = s.positions
      if (lolOnly)  positions = positions.filter(isLol)
      if (openOnly) positions = positions.filter(p => !p.redeemable)
      return {
        ...s,
        positions,
        position_count: positions.length,
        total_value:    positions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0),
        total_pnl:      positions.reduce((sum, p) => sum + (p.cashPnl ?? 0),     0),
      }
    })
    if (f) xs = xs.filter(s =>
      (s.name || '').toLowerCase().includes(f) ||
      s.wallet_address.includes(f) ||
      (s.notes || '').toLowerCase().includes(f)
    )
    switch (sort) {
      case 'name':  xs.sort((a,b) => (a.name ?? '').localeCompare(b.name ?? ''));            break
      case 'value': xs.sort((a,b) => b.total_value - a.total_value);                          break
      case 'pnl':   xs.sort((a,b) => b.total_pnl   - a.total_pnl);                            break
      case 'count': xs.sort((a,b) => b.position_count - a.position_count);                    break
    }
    return xs
  }, [sharks, filter, sort, lolOnly, openOnly])

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-emerald-400">Sharks</h1>
          <p className="text-sm text-gray-400 mt-1">
            {visible.length} tracked · {lolOnly ? 'LoL' : 'all'} · {openOnly ? 'open only' : 'incl. settled'} · refreshes every 30s
            {err && <span className="text-red-400 ml-3">error: {err}</span>}
          </p>
        </div>
        <nav className="flex gap-5 text-sm">
          <Link href="/"          className="text-gray-400 hover:text-gray-200">Home</Link>
          <Link href="/trader"    className="text-gray-400 hover:text-gray-200">Trader</Link>
          <Link href="/scanner"   className="text-gray-400 hover:text-gray-200">Scanner</Link>
          <Link href="/kalshi-mm" className="text-gray-400 hover:text-gray-200">Kalshi-MM</Link>
          <Link href="/pnl"       className="text-gray-400 hover:text-gray-200">PnL</Link>
        </nav>
      </header>

      <main className="px-6 py-5">
        {/* add-shark form */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-5 flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[280px]">
            <label className="text-xs text-gray-500 mb-1 block">wallet address</label>
            <input value={newWallet} onChange={e => setNewWallet(e.target.value)}
                   placeholder="0x…" spellCheck={false}
                   className="bg-gray-950 border border-gray-700 rounded px-3 py-1.5 text-sm w-full font-mono" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">name</label>
            <input value={newName} onChange={e => setNewName(e.target.value)}
                   placeholder="(optional)"
                   className="bg-gray-950 border border-gray-700 rounded px-3 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">type</label>
            <select value={newType} onChange={e => setNewType(e.target.value as 'sharp'|'fade'|'watch')}
                    className="bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm">
              <option value="sharp">sharp</option>
              <option value="fade">fade</option>
              <option value="watch">watch</option>
            </select>
          </div>
          <button onClick={addShark} disabled={adding || !newWallet}
                  className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm">
            {adding ? 'adding…' : 'add shark'}
          </button>
        </div>

        {/* controls */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <input value={filter} onChange={e => setFilter(e.target.value)}
                 placeholder="filter by name / wallet / notes"
                 className="bg-gray-900 border border-gray-800 rounded px-3 py-1.5 text-sm w-72" />
          <label className="text-xs text-gray-400 flex items-center gap-1.5">
            <input type="checkbox" checked={lolOnly} onChange={e => setLolOnly(e.target.checked)} />
            LoL only
          </label>
          <label className="text-xs text-gray-400 flex items-center gap-1.5">
            <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
            open only
          </label>
          <span className="text-xs text-gray-500 ml-3">sort:</span>
          {(['value','pnl','count','name'] as SortKey[]).map(k => (
            <button key={k} onClick={() => setSort(k)}
                    className={`px-2 py-0.5 text-xs rounded ${sort === k ? 'bg-emerald-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {k}
            </button>
          ))}
        </div>

        {/* sharks list */}
        {loading ? (
          <p className="text-gray-500">loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-gray-500">no sharks{filter ? ' match' : ''}.</p>
        ) : (
          <div className="space-y-3">
            {visible.map(s => {
              const open = expanded.has(s.wallet_address)
              return (
                <div key={s.wallet_address} className="bg-gray-900 border border-gray-800 rounded-lg">
                  <button onClick={() => toggle(s.wallet_address)}
                          className="w-full px-4 py-3 flex items-center gap-4 text-left hover:bg-gray-900/60">
                    <span className="text-2xl">{s.emoji ?? '🦈'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-3">
                        <span className="text-base font-semibold">{s.name || trunc(s.wallet_address)}</span>
                        <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                          s.type === 'sharp' ? 'bg-emerald-900 text-emerald-300' :
                          s.type === 'fade'  ? 'bg-red-900 text-red-300' :
                                               'bg-gray-800 text-gray-400'}`}>
                          {s.type}
                        </span>
                        <code className="text-xs text-gray-500 font-mono">{trunc(s.wallet_address)}</code>
                        {!s.fetched_ok && <span className="text-xs text-red-400">err: {s.error}</span>}
                      </div>
                      {s.notes && <div className="text-xs text-gray-500 mt-0.5">{s.notes}</div>}
                    </div>
                    <div className="text-right text-sm">
                      <div className="text-gray-200">{s.position_count} pos · {dollar(s.total_value)}</div>
                      <div className={s.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {dollar(s.total_pnl)} {s.total_value > 0 ? `(${pct(s.total_pnl / s.total_value * 100)})` : ''}
                      </div>
                    </div>
                    <span className="text-gray-600 text-xs ml-2">{open ? '▲' : '▼'}</span>
                  </button>

                  {open && (
                    <div className="border-t border-gray-800 px-4 py-3">
                      <SharkEdit shark={s} onSave={saveEdit}
                                 onRemove={() => removeShark(s.wallet_address, s.name)} />
                      {s.positions.length === 0 ? (
                        <p className="text-sm text-gray-500">no {lolOnly ? 'LoL ' : ''}positions.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-gray-500 uppercase tracking-wide">
                              <tr>
                                <th className="text-left  py-1.5 pr-3">Market</th>
                                <th className="text-left  py-1.5 pr-3">Side</th>
                                <th className="text-right py-1.5 pr-3">Size</th>
                                <th className="text-right py-1.5 pr-3">Avg</th>
                                <th className="text-right py-1.5 pr-3">Cur</th>
                                <th className="text-right py-1.5 pr-3">Value</th>
                                <th className="text-right py-1.5 pr-3">PnL</th>
                              </tr>
                            </thead>
                            <tbody>
                              {s.positions
                                .slice()
                                .sort((a, b) => b.currentValue - a.currentValue)
                                .map(p => (
                                <tr key={p.asset} className="border-t border-gray-800/50">
                                  <td className="py-1.5 pr-3">
                                    <a href={`https://polymarket.com/event/${p.eventSlug}`} target="_blank" rel="noreferrer"
                                       className="text-gray-200 hover:text-emerald-300">{p.title}</a>
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    <span className={p.outcome === 'Yes' ? 'text-emerald-300' : 'text-amber-300'}>{p.outcome}</span>
                                  </td>
                                  <td className="py-1.5 pr-3 text-right text-gray-300">
                                    {p.size.toLocaleString('en-US',{maximumFractionDigits:0})}
                                  </td>
                                  <td className="py-1.5 pr-3 text-right text-gray-400">{(p.avgPrice * 100).toFixed(1)}¢</td>
                                  <td className="py-1.5 pr-3 text-right text-gray-400">{(p.curPrice * 100).toFixed(1)}¢</td>
                                  <td className="py-1.5 pr-3 text-right text-gray-200">{dollar(p.currentValue)}</td>
                                  <td className={`py-1.5 pr-3 text-right ${p.cashPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {dollar(p.cashPnl)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}


function SharkEdit({ shark, onSave, onRemove }: {
  shark:    Shark
  onSave:   (wallet: string, name: string, notes: string, type: 'sharp'|'fade'|'watch') => Promise<void>
  onRemove: () => Promise<void>
}) {
  const [name,    setName]    = useState(shark.name  ?? '')
  const [notes,   setNotes]   = useState(shark.notes ?? '')
  const [type,    setType]    = useState<'sharp'|'fade'|'watch'>(shark.type)
  const [saving,  setSaving]  = useState(false)
  const dirty = name !== (shark.name ?? '') || notes !== (shark.notes ?? '') || type !== shark.type
  return (
    <div className="flex flex-wrap items-end gap-3 mb-3 bg-gray-950/60 border border-gray-800 rounded p-2.5">
      <div className="flex-1 min-w-[160px]">
        <label className="text-[10px] uppercase text-gray-500">name</label>
        <input value={name} onChange={e => setName(e.target.value)}
               placeholder="(no name)"
               className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs w-full" />
      </div>
      <div className="flex-1 min-w-[200px]">
        <label className="text-[10px] uppercase text-gray-500">notes</label>
        <input value={notes} onChange={e => setNotes(e.target.value)}
               placeholder="(none)"
               className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs w-full" />
      </div>
      <div>
        <label className="text-[10px] uppercase text-gray-500">type</label>
        <select value={type} onChange={e => setType(e.target.value as 'sharp'|'fade'|'watch')}
                className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs block">
          <option value="sharp">sharp</option>
          <option value="fade">fade</option>
          <option value="watch">watch</option>
        </select>
      </div>
      <button
        disabled={!dirty || saving}
        onClick={async () => {
          setSaving(true)
          try { await onSave(shark.wallet_address, name.trim(), notes.trim(), type) }
          finally { setSaving(false) }
        }}
        className="px-3 py-1 text-xs rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30">
        {saving ? 'saving…' : 'save'}
      </button>
      <button onClick={onRemove} className="px-2 py-1 text-xs text-red-400 hover:text-red-300">remove</button>
    </div>
  )
}
