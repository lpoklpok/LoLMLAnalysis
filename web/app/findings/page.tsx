'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface ChampionRow {
  champion: string
  games:    number
  actual:   number
  expected: number
  outperf:  number
}

interface MatchupRow {
  champ:    string
  opp:      string
  games:    number
  actual:   number
  expected: number
  outperf:  number
}

interface SynergyRow {
  champA:   string
  champB:   string
  games:    number
  actual:   number
  expected: number
  outperf:  number
}

interface FindingsData {
  generated:         string
  year:              number
  min_games:         number
  min_games_major:   number
  by_position:       Record<string, ChampionRow[]>
  by_position_major: Record<string, ChampionRow[]>
  matchups:          Record<string, MatchupRow[]>
  matchups_major:    Record<string, MatchupRow[]>
  synergies:         SynergyRow[]
  synergies_major:   SynergyRow[]
}

const POSITIONS = ['top', 'jng', 'mid', 'bot', 'sup'] as const
const POS_LABEL: Record<string, string> = { top: 'Top', jng: 'Jungle', mid: 'Mid', bot: 'Bot', sup: 'Support' }
const TOP_N = 10

function pct(v: number) { return `${(v * 100).toFixed(1)}%` }
function sign(v: number) { return v >= 0 ? `+${(v * 100).toFixed(1)}%` : `${(v * 100).toFixed(1)}%` }

function outperfColor(v: number): string {
  if (v >=  0.15) return 'text-green-300 font-semibold'
  if (v >=  0.08) return 'text-green-400'
  if (v >=  0.04) return 'text-green-500'
  if (v <= -0.15) return 'text-red-300 font-semibold'
  if (v <= -0.08) return 'text-red-400'
  if (v <= -0.04) return 'text-red-500'
  return 'text-gray-400'
}

function LeagueToggle({ majorOnly, setMajor }: { majorOnly: boolean; setMajor: (v: boolean) => void }) {
  return (
    <div className="flex gap-2 mb-4">
      {[false, true].map(v => (
        <button key={String(v)} onClick={() => setMajor(v)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            majorOnly === v
              ? 'bg-gray-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
          }`}>
          {v ? 'Major Leagues (LCK / LEC / LCS / LPL)' : 'All Leagues'}
        </button>
      ))}
    </div>
  )
}

function PosTabs({ pos, setPos }: { pos: string; setPos: (p: typeof POSITIONS[number]) => void }) {
  return (
    <div className="flex gap-2 mb-6">
      {POSITIONS.map(p => (
        <button key={p} onClick={() => setPos(p)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            pos === p
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
          }`}>
          {POS_LABEL[p]}
        </button>
      ))}
    </div>
  )
}

function SideBySide<T>({
  rows, direction, header, renderRow, keyFn,
}: {
  rows: T[]
  direction: 'over' | 'under'
  header: string
  renderRow: (r: T, i: number) => React.ReactNode
  keyFn: (r: T) => string
}) {
  const sorted = direction === 'over'
    ? [...rows].sort((a: any, b: any) => b.outperf - a.outperf).slice(0, TOP_N)
    : [...rows].sort((a: any, b: any) => a.outperf - b.outperf).slice(0, TOP_N)
  const accent = direction === 'over' ? 'text-green-400' : 'text-red-400'
  return (
    <div className="flex-1 min-w-0">
      <h3 className={`text-sm font-semibold uppercase tracking-wide mb-3 ${accent}`}>{header}</h3>
      <div className="space-y-0">{sorted.map((r, i) => renderRow(r, i))}</div>
    </div>
  )
}

// ---- Individual champion table ----
function ChampionHalf({ rows, direction }: { rows: ChampionRow[]; direction: 'over' | 'under' }) {
  const sorted = direction === 'over'
    ? [...rows].sort((a, b) => b.outperf - a.outperf).slice(0, TOP_N)
    : [...rows].sort((a, b) => a.outperf - b.outperf).slice(0, TOP_N)
  const accent = direction === 'over' ? 'text-green-400' : 'text-red-400'
  const label  = direction === 'over' ? 'Overperformers' : 'Underperformers'
  return (
    <div className="flex-1 min-w-0">
      <h3 className={`text-sm font-semibold uppercase tracking-wide mb-3 ${accent}`}>{label}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800">
            <th className="text-left pb-2 font-normal">Champion</th>
            <th className="text-right pb-2 font-normal">G</th>
            <th className="text-right pb-2 font-normal">Actual</th>
            <th className="text-right pb-2 font-normal">Model</th>
            <th className="text-right pb-2 font-normal">Δ</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.champion} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
              <td className="py-1.5 pr-3 text-gray-200">{r.champion}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
              <td className="py-1.5 text-right text-gray-300 tabular-nums">{pct(r.actual)}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{pct(r.expected)}</td>
              <td className={`py-1.5 text-right tabular-nums ${outperfColor(r.outperf)}`}>{sign(r.outperf)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- Matchup table ----
function MatchupHalf({ rows, direction }: { rows: MatchupRow[]; direction: 'over' | 'under' }) {
  const sorted = direction === 'over'
    ? [...rows].sort((a, b) => b.outperf - a.outperf).slice(0, TOP_N)
    : [...rows].sort((a, b) => a.outperf - b.outperf).slice(0, TOP_N)
  const accent = direction === 'over' ? 'text-green-400' : 'text-red-400'
  const label  = direction === 'over' ? 'Counters' : 'Gets Countered'
  return (
    <div className="flex-1 min-w-0">
      <h3 className={`text-sm font-semibold uppercase tracking-wide mb-3 ${accent}`}>{label}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800">
            <th className="text-left pb-2 font-normal">Champ</th>
            <th className="text-left pb-2 font-normal pl-2">vs</th>
            <th className="text-right pb-2 font-normal">G</th>
            <th className="text-right pb-2 font-normal">Actual</th>
            <th className="text-right pb-2 font-normal">Model</th>
            <th className="text-right pb-2 font-normal">Δ</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={`${r.champ}|${r.opp}`} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
              <td className="py-1.5 pr-1 text-gray-200 whitespace-nowrap">{r.champ}</td>
              <td className="py-1.5 pl-2 text-gray-500 whitespace-nowrap">{r.opp}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
              <td className="py-1.5 text-right text-gray-300 tabular-nums">{pct(r.actual)}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{pct(r.expected)}</td>
              <td className={`py-1.5 text-right tabular-nums ${outperfColor(r.outperf)}`}>{sign(r.outperf)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- Synergy table ----
function SynergyHalf({ rows, direction }: { rows: SynergyRow[]; direction: 'over' | 'under' }) {
  const sorted = direction === 'over'
    ? [...rows].sort((a, b) => b.outperf - a.outperf).slice(0, TOP_N)
    : [...rows].sort((a, b) => a.outperf - b.outperf).slice(0, TOP_N)
  const accent = direction === 'over' ? 'text-green-400' : 'text-red-400'
  const label  = direction === 'over' ? 'Best Synergies' : 'Worst Synergies'
  return (
    <div className="flex-1 min-w-0">
      <h3 className={`text-sm font-semibold uppercase tracking-wide mb-3 ${accent}`}>{label}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800">
            <th className="text-left pb-2 font-normal">Pair</th>
            <th className="text-right pb-2 font-normal">G</th>
            <th className="text-right pb-2 font-normal">Actual</th>
            <th className="text-right pb-2 font-normal">Model</th>
            <th className="text-right pb-2 font-normal">Δ</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={`${r.champA}|${r.champB}`} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
              <td className="py-1.5 pr-3 text-gray-200">
                <span>{r.champA}</span>
                <span className="text-gray-600 mx-1.5">+</span>
                <span>{r.champB}</span>
              </td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
              <td className="py-1.5 text-right text-gray-300 tabular-nums">{pct(r.actual)}</td>
              <td className="py-1.5 text-right text-gray-500 tabular-nums">{pct(r.expected)}</td>
              <td className={`py-1.5 text-right tabular-nums ${outperfColor(r.outperf)}`}>{sign(r.outperf)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function FindingsPage() {
  const [data, setData]       = useState<FindingsData | null>(null)
  const [pos, setPos]         = useState<typeof POSITIONS[number]>('mid')
  const [majorOnly, setMajor] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch('/champion_findings.json')
      .then(r => r.json())
      .then(setData)
      .catch(() => setError('Failed to load findings data'))
  }, [])

  const champRows   = data ? (majorOnly ? data.by_position_major : data.by_position)[pos]  ?? [] : []
  const matchupRows = data ? (majorOnly ? data.matchups_major    : data.matchups)[pos]      ?? [] : []
  const synergyRows = data ? (majorOnly ? data.synergies_major   : data.synergies)          ?? [] : []

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/" className="text-gray-500 hover:text-gray-300 text-sm transition-colors">← Home</Link>
        <h1 className="text-2xl font-bold text-white">General Findings</h1>
        {data && (
          <span className="text-xs text-gray-600 ml-auto">
            2026 · model trained on 2024–2025
          </span>
        )}
      </div>

      {error && <p className="text-red-400">{error}</p>}
      {!data && !error && <div className="text-gray-500 text-sm">Loading…</div>}

      {data && (
        <div className="space-y-10">
          {/* Shared filters */}
          <LeagueToggle majorOnly={majorOnly} setMajor={setMajor} />

          {/* ── Section 1: Individual champion performance ── */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-1">Champion Performance</h2>
            <p className="text-gray-500 text-sm mb-4">
              How much more or less a team wins vs model expectation when drafting this champion.
            </p>
            <PosTabs pos={pos} setPos={setPos} />
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <div className="flex gap-8">
                <ChampionHalf rows={champRows} direction="over" />
                <div className="w-px bg-gray-800 shrink-0" />
                <ChampionHalf rows={champRows} direction="under" />
              </div>
            </div>
          </section>

          {/* ── Section 2: Matchup deltas ── */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-1">Matchup Deltas</h2>
            <p className="text-gray-500 text-sm mb-4">
              Same-role matchups where one champion's team wins far more or less than the model predicted.
              "Champ vs Opp" means champ's team beats opp's team at the listed actual rate.
            </p>
            <PosTabs pos={pos} setPos={setPos} />
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <div className="flex gap-8">
                <MatchupHalf rows={matchupRows} direction="over" />
                <div className="w-px bg-gray-800 shrink-0" />
                <MatchupHalf rows={matchupRows} direction="under" />
              </div>
            </div>
          </section>

          {/* ── Section 3: Synergy deltas ── */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-1">Synergy Deltas</h2>
            <p className="text-gray-500 text-sm mb-4">
              Same-team champion pairs whose teams win significantly more or less than expected — across all positions.
            </p>
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <div className="flex gap-8">
                <SynergyHalf rows={synergyRows} direction="over" />
                <div className="w-px bg-gray-800 shrink-0" />
                <SynergyHalf rows={synergyRows} direction="under" />
              </div>
            </div>
          </section>

          <p className="text-xs text-gray-600">
            Updated {new Date(data.generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
      )}
    </div>
  )
}
