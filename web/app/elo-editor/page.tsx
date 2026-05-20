'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

interface Override { elo: number; original: number; reason: string }
interface ModelParams { player_elos: Record<string, number>; rosters: Record<string, string[]> }

function eloColor(elo: number): string {
  if (elo >= 1800) return 'text-yellow-400'
  if (elo >= 1700) return 'text-blue-400'
  if (elo >= 1600) return 'text-green-400'
  return 'text-gray-400'
}

function EloBadge({ elo }: { elo: number }) {
  return <span className={`font-mono font-bold ${eloColor(elo)}`}>{Math.round(elo)}</span>
}

export default function EloEditorPage() {
  const [params, setParams]       = useState<ModelParams | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [search, setSearch]       = useState('')
  const [editing, setEditing]     = useState<string | null>(null)
  const [editElo, setEditElo]     = useState('')
  const [editReason, setEditReason] = useState('')
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState<string | null>(null)

  useEffect(() => {
    fetch('/model_params.json').then(r => r.json()).then(setParams)
    fetch('/api/elo-overrides').then(r => r.json()).then(setOverrides)
  }, [])

  // Build player→team index
  const playerTeam = useMemo(() => {
    if (!params) return {}
    const out: Record<string, string> = {}
    for (const [team, roster] of Object.entries(params.rosters)) {
      for (const p of roster) out[p] = team
    }
    return out
  }, [params])

  const players = useMemo(() => {
    if (!params) return []
    return Object.entries(params.player_elos)
      .filter(([name]) => name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
  }, [params, search])

  function startEdit(name: string, currentElo: number) {
    setEditing(name)
    setEditElo(String(Math.round(currentElo)))
    setEditReason(overrides[name]?.reason ?? '')
  }

  async function saveEdit(name: string) {
    const elo = parseFloat(editElo)
    if (isNaN(elo) || elo < 500 || elo > 2500) {
      alert('ELO must be between 500 and 2500')
      return
    }
    setSaving(true)
    const original = overrides[name]?.original ?? (params?.player_elos[name] ?? elo)
    const res = await fetch('/api/elo-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: name, elo, original, reason: editReason }),
    })
    const data = await res.json()
    setOverrides(data.overrides)
    setEditing(null)
    setSaving(false)
    showToast(`Saved override for ${name}: ${Math.round(elo)}`)
  }

  async function removeOverride(name: string) {
    const res = await fetch('/api/elo-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: name, delete: true }),
    })
    const data = await res.json()
    setOverrides(data.overrides)
    showToast(`Removed override for ${name}`)
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const overrideCount = Object.keys(overrides).length

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-purple-400">ELO Editor</h1>
          <p className="text-sm text-gray-400 mt-1">
            Manual ELO overrides · {overrideCount} active override{overrideCount !== 1 ? 's' : ''}
          </p>
        </div>
        <nav className="flex gap-6 text-sm">
          <Link href="/"            className="text-gray-400 hover:text-gray-200">Dashboard</Link>
          <Link href="/rankings"    className="text-gray-400 hover:text-gray-200">Rankings</Link>
          <Link href="/calculator"  className="text-gray-400 hover:text-gray-200">Calculator</Link>
          <Link href="/predictions" className="text-gray-400 hover:text-gray-200">Predictions</Link>
        </nav>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">

        {/* Info banner */}
        <div className="bg-purple-950/40 border border-purple-800/50 rounded-xl p-4 text-sm text-purple-200">
          Overrides are written to <code className="bg-black/30 px-1 rounded">data/processed/elo_overrides.json</code> and
          take effect in the calculator immediately. Re-run <code className="bg-black/30 px-1 rounded">python src/export_model_params.py</code> to
          bake them into the model for upcoming predictions.
        </div>

        {/* Active overrides */}
        {overrideCount > 0 && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h2 className="text-sm font-semibold text-gray-300 mb-3">Active Overrides</h2>
            <div className="space-y-2">
              {Object.entries(overrides).map(([name, ov]) => (
                <div key={name} className="flex items-center gap-3 text-sm">
                  <span className="w-32 font-medium text-gray-200 truncate">{name}</span>
                  <span className="text-gray-500 line-through font-mono text-xs">{Math.round(ov.original)}</span>
                  <span className="text-purple-300 font-mono font-bold">→ {Math.round(ov.elo)}</span>
                  {ov.reason && <span className="text-gray-500 italic truncate flex-1">{ov.reason}</span>}
                  <button
                    onClick={() => removeOverride(name)}
                    className="text-xs text-red-400 hover:text-red-300 ml-auto"
                  >Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search */}
        <div>
          <input
            type="text"
            placeholder="Search player…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        {/* Player list */}
        {!params ? (
          <p className="text-gray-400">Loading…</p>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="grid grid-cols-[1fr_80px_100px_80px_200px] gap-x-4 px-4 py-2 text-xs text-gray-500 border-b border-gray-800">
              <span>Player</span><span>Team</span><span className="text-right">Current ELO</span><span className="text-right">Override</span><span></span>
            </div>
            <div className="divide-y divide-gray-800/50 max-h-[60vh] overflow-y-auto">
              {players.map(([name, elo]) => {
                const ov = overrides[name]
                const isEditing = editing === name
                const displayElo = ov?.elo ?? elo
                return (
                  <div key={name} className="grid grid-cols-[1fr_80px_100px_80px_200px] gap-x-4 px-4 py-2.5 items-center text-sm hover:bg-gray-800/40">
                    <span className="font-medium text-gray-100 truncate flex items-center gap-2">
                      {name}
                      {ov && <span className="text-xs bg-purple-900/50 text-purple-300 px-1.5 py-0.5 rounded">edited</span>}
                    </span>
                    <span className="text-gray-500 text-xs truncate">{playerTeam[name] ?? '—'}</span>
                    <span className="text-right"><EloBadge elo={displayElo} /></span>
                    <span className="text-right text-xs">
                      {ov ? <span className="text-gray-600 line-through">{Math.round(ov.original)}</span> : ''}
                    </span>
                    <div className="flex items-center gap-2">
                      {isEditing ? (
                        <>
                          <input
                            type="number"
                            value={editElo}
                            onChange={e => setEditElo(e.target.value)}
                            className="w-20 bg-gray-800 border border-purple-600 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none"
                            autoFocus
                          />
                          <input
                            type="text"
                            value={editReason}
                            onChange={e => setEditReason(e.target.value)}
                            placeholder="reason…"
                            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none"
                          />
                          <button
                            onClick={() => saveEdit(name)}
                            disabled={saving}
                            className="text-xs bg-purple-700 hover:bg-purple-600 text-white px-2 py-1 rounded"
                          >Save</button>
                          <button
                            onClick={() => setEditing(null)}
                            className="text-xs text-gray-500 hover:text-gray-300"
                          >✕</button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(name, displayElo)}
                            className="text-xs text-gray-500 hover:text-purple-400 transition-colors"
                          >Edit ELO</button>
                          {ov && (
                            <button
                              onClick={() => removeOverride(name)}
                              className="text-xs text-red-500 hover:text-red-400"
                            >Remove</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-800 border border-gray-600 text-gray-100 text-sm px-5 py-2.5 rounded-xl shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
