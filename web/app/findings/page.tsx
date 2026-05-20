'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'

// ── Gold lead types ──────────────────────────────────────────────────────────

interface GoldBucket {
  bucket:   string
  gold_lo:  number
  gold_hi:  number | null
  n:        number
  win_rate: number
}

interface ProbGoldRow {
  prob_bucket: string
  prob_lo:     number
  prob_hi:     number
  n:           number
  overall_wr:  number
  gold_buckets: GoldBucket[]
}

interface ObjectiveStat { n: number; wins: number; win_rate: number | null }
interface ObjectivesSet { dragons_4plus: ObjectiveStat; first_baron: ObjectiveStat }
interface ProbObjRow {
  prob_bucket: string
  prob_lo:     number
  prob_hi:     number
  n:           number
  wins:        number
  win_rate:    number
}
interface ProbXObjectiveSet { dragons_4plus: ProbObjRow[]; first_baron: ProbObjRow[] }

interface GoldLeadData {
  generated:        string
  year:             number
  gold_lead:        { all: Record<string, GoldBucket[]>;   major: Record<string, GoldBucket[]> }
  prob_x_gold:      { all: Record<string, ProbGoldRow[]>;  major: Record<string, ProbGoldRow[]> }
  objectives:       { all: ObjectivesSet;                  major: ObjectivesSet }
  prob_x_objective: { all: ProbXObjectiveSet;              major: ProbXObjectiveSet }
}

// ── Champion types ───────────────────────────────────────────────────────────

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

function wrColor(wr: number): string {
  if (wr >= 0.90) return 'text-green-300 font-bold'
  if (wr >= 0.80) return 'text-green-400 font-semibold'
  if (wr >= 0.70) return 'text-green-500'
  if (wr >= 0.60) return 'text-emerald-600'
  if (wr >= 0.55) return 'text-gray-300'
  if (wr >= 0.45) return 'text-gray-400'
  return 'text-gray-500'
}

function wrBg(wr: number): string {
  if (wr >= 0.85) return 'bg-green-900/60'
  if (wr >= 0.75) return 'bg-green-900/40'
  if (wr >= 0.65) return 'bg-green-900/20'
  if (wr >= 0.55) return 'bg-gray-800/60'
  return 'bg-gray-800/30'
}

function TimeTabs({ time, setTime }: { time: string; setTime: (t: string) => void }) {
  return (
    <div className="flex gap-2 mb-5">
      {['10', '15', '20'].map(t => (
        <button key={t} onClick={() => setTime(t)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            time === t
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
          }`}>
          @{t} min
        </button>
      ))}
    </div>
  )
}

function GoldLeadTable({ buckets }: { buckets: GoldBucket[] }) {
  const max = Math.max(...buckets.map(b => b.win_rate))
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-gray-500 border-b border-gray-800">
          <th className="text-left pb-2 font-normal">Gold lead (leading team)</th>
          <th className="text-right pb-2 font-normal">Win rate</th>
          <th className="pb-2 px-4 font-normal w-48"></th>
          <th className="text-right pb-2 font-normal">n</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b, i) => (
          <tr key={b.bucket} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
            <td className="py-2 pr-4 text-gray-300 font-mono text-xs">{b.bucket}</td>
            <td className={`py-2 text-right tabular-nums font-mono ${wrColor(b.win_rate)}`}>
              {pct(b.win_rate)}
            </td>
            <td className="py-2 px-4">
              <div className="h-4 bg-gray-800 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded transition-all duration-300"
                  style={{ width: `${(b.win_rate / max) * 100}%` }}
                />
              </div>
            </td>
            <td className="py-2 text-right text-gray-600 tabular-nums text-xs">{b.n.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProbXGoldTable({ rows, allBuckets }: { rows: ProbGoldRow[]; allBuckets: string[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left pb-2 font-normal pr-4">Model prob (leading team)</th>
            <th className="text-right pb-2 font-normal pr-4">Overall</th>
            {allBuckets.map(b => (
              <th key={b} className="text-right pb-2 font-normal px-2 whitespace-nowrap">{b}</th>
            ))}
            <th className="text-right pb-2 font-normal pl-4">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const byBucket: Record<string, GoldBucket> = {}
            for (const gb of row.gold_buckets) byBucket[gb.bucket] = gb
            return (
              <tr key={row.prob_bucket} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
                <td className="py-2 pr-4 text-gray-300 font-mono whitespace-nowrap">{row.prob_bucket}</td>
                <td className={`py-2 pr-4 text-right tabular-nums font-mono ${wrColor(row.overall_wr)}`}>
                  {pct(row.overall_wr)}
                </td>
                {allBuckets.map(b => {
                  const gb = byBucket[b]
                  return (
                    <td key={b} className={`py-2 px-2 text-right tabular-nums font-mono ${gb ? wrColor(gb.win_rate) : 'text-gray-700'} ${gb ? wrBg(gb.win_rate) : ''}`}>
                      {gb ? pct(gb.win_rate) : '—'}
                      {gb && <span className="text-gray-600 ml-0.5 text-[10px]">/{gb.n}</span>}
                    </td>
                  )
                })}
                <td className="py-2 pl-4 text-right text-gray-600 tabular-nums">{row.n}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ProbXObjectiveTable({ rows }: { rows: ProbObjRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left pb-2 font-normal pr-4">Model prob (team that secured objective)</th>
            <th className="text-right pb-2 font-normal pr-4">Win rate</th>
            <th className="text-right pb-2 font-normal pl-4">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.prob_bucket} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
              <td className="py-2 pr-4 text-gray-300 font-mono whitespace-nowrap">{row.prob_bucket}</td>
              <td className={`py-2 pr-4 text-right tabular-nums font-mono ${wrColor(row.win_rate)}`}>
                {pct(row.win_rate)}
              </td>
              <td className="py-2 pl-4 text-right text-gray-600 tabular-nums">{row.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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
    <div className="flex gap-2">
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

// ---- Matchup tables ----
// Both halves select the same top-N pairs ranked by |delta|.
// "Counters" shows from the winner's perspective; "Gets Countered" flips to the loser's.
function MatchupPair({ rows }: { rows: MatchupRow[] }) {
  // Select top N by absolute delta, normalise so outperf is always positive
  // (counter = the side that overperforms, countered = the other side)
  const strongest = [...rows]
    .sort((a, b) => Math.abs(b.outperf) - Math.abs(a.outperf))
    .slice(0, TOP_N)
    .map(r => r.outperf >= 0
      ? { counter: r.champ, countered: r.opp, games: r.games, actual: r.actual,       expected: r.expected,       delta: r.outperf }
      : { counter: r.opp,  countered: r.champ, games: r.games, actual: 1 - r.actual,  expected: 1 - r.expected,  delta: -r.outperf }
    )

  const col = (label: string, accent: string, flip: boolean) => (
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
          {strongest.map((r, i) => {
            const a = flip ? r.countered : r.counter
            const b = flip ? r.counter   : r.countered
            const actual   = flip ? 1 - r.actual   : r.actual
            const expected = flip ? 1 - r.expected : r.expected
            const delta    = flip ? -r.delta        : r.delta
            return (
              <tr key={`${r.counter}|${r.countered}`} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
                <td className="py-1.5 pr-1 text-gray-200 whitespace-nowrap">{a}</td>
                <td className="py-1.5 pl-2 text-gray-500 whitespace-nowrap">{b}</td>
                <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
                <td className="py-1.5 text-right text-gray-300 tabular-nums">{pct(actual)}</td>
                <td className="py-1.5 text-right text-gray-500 tabular-nums">{pct(expected)}</td>
                <td className={`py-1.5 text-right tabular-nums ${outperfColor(delta)}`}>{sign(delta)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="flex gap-8">
      {col('Counters',      'text-green-400', false)}
      <div className="w-px bg-gray-800 shrink-0" />
      {col('Gets Countered', 'text-red-400',   true)}
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
  const [glData, setGlData]   = useState<GoldLeadData | null>(null)
  const [glTime, setGlTime]   = useState('10')
  const [pos, setPos]         = useState<typeof POSITIONS[number]>('mid')
  const [majorOnly, setMajor] = useState(false)
  const [minGames, setMinGames] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch('/champion_findings.json')
      .then(r => r.json())
      .then(setData)
      .catch(() => setError('Failed to load findings data'))
    fetch('/gold_lead.json')
      .then(r => r.json())
      .then(setGlData)
      .catch(() => {})
  }, [])

  const allGoldBuckets = useMemo(() => {
    if (!glData) return []
    const src = majorOnly ? glData.prob_x_gold.major : glData.prob_x_gold.all
    const rows = src[glTime] ?? []
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of rows) {
      for (const gb of row.gold_buckets) {
        if (!seen.has(gb.bucket)) { seen.add(gb.bucket); out.push(gb.bucket) }
      }
    }
    return out
  }, [glData, glTime, majorOnly])

  const gFilter = <T extends { games: number }>(rows: T[]) =>
    minGames ? rows.filter(r => r.games >= 10) : rows

  const champRows   = gFilter(data ? (majorOnly ? data.by_position_major : data.by_position)[pos]  ?? [] : [])
  const matchupRows = gFilter(data ? (majorOnly ? data.matchups_major    : data.matchups)[pos]      ?? [] : [])
  const synergyRows = gFilter(data ? (majorOnly ? data.synergies_major   : data.synergies)          ?? [] : [])

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
          <div className="flex flex-wrap items-center gap-3">
            <LeagueToggle majorOnly={majorOnly} setMajor={setMajor} />
            <button
              onClick={() => setMinGames(v => !v)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                minGames
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              Min 10 games
            </button>
          </div>

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
              <MatchupPair rows={matchupRows} />
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

          {/* ── Section 4: Gold lead win rate ── */}
          {glData && (
            <section>
              <h2 className="text-lg font-semibold text-gray-100 mb-1">Gold Lead Win Rate (2026)</h2>
              <p className="text-gray-500 text-sm mb-4">
                Win probability of the team with the gold lead, bucketed by lead magnitude. Regardless of side.
              </p>
              <TimeTabs time={glTime} setTime={setGlTime} />
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                <GoldLeadTable buckets={(majorOnly ? glData.gold_lead.major : glData.gold_lead.all)[glTime] ?? []} />
              </div>
            </section>
          )}

          {/* ── Section 5: Pre-game prob × gold lead ── */}
          {glData && (
            <section>
              <h2 className="text-lg font-semibold text-gray-100 mb-1">Pre-Game Probability × Gold Lead</h2>
              <p className="text-gray-500 text-sm mb-4">
                Win rate of the gold-leading team, split by that team's pre-game model probability bucket.
                Shows how gold leads interact with pre-game strength — useful for live betting.
                Cell format: win rate / n games.
              </p>
              <TimeTabs time={glTime} setTime={setGlTime} />
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                <ProbXGoldTable
                  rows={(majorOnly ? glData.prob_x_gold.major : glData.prob_x_gold.all)[glTime] ?? []}
                  allBuckets={allGoldBuckets}
                />
              </div>
            </section>
          )}

          {/* ── Section 6: Objective win rates ── */}
          {glData && (() => {
            const obj = majorOnly ? glData.objectives.major : glData.objectives.all
            const card = (label: string, sub: string, stat: ObjectiveStat) => (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 flex-1">
                <div className="text-sm text-gray-400 mb-1">{label}</div>
                <div className="text-xs text-gray-600 mb-3">{sub}</div>
                <div className="text-4xl font-bold text-emerald-400">
                  {stat.win_rate !== null ? `${(stat.win_rate * 100).toFixed(1)}%` : '—'}
                </div>
                <div className="text-xs text-gray-500 mt-2">
                  {stat.wins.toLocaleString()} wins / {stat.n.toLocaleString()} team-games
                </div>
              </div>
            )
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Objective Win Rates</h2>
                <p className="text-gray-500 text-sm mb-4">
                  Win rate of a team that secured the objective. Side-agnostic — pools both blue and red team-game instances.
                </p>
                <div className="flex flex-col md:flex-row gap-4">
                  {card('4+ Dragons', 'P(win | team got 4+ dragons)',  obj.dragons_4plus)}
                  {card('First Baron', 'P(win | team got first baron)', obj.first_baron)}
                </div>
              </section>
            )
          })()}

          {/* ── Section 7: Pre-game prob × objective ── */}
          {glData && (() => {
            const pxo = majorOnly ? glData.prob_x_objective.major : glData.prob_x_objective.all
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Pre-Game Probability × Objective</h2>
                <p className="text-gray-500 text-sm mb-4">
                  Win rate of the team that secured the objective, bucketed by their pre-game model probability.
                  Side-agnostic — useful for spotting when objectives matter most relative to pre-game strength.
                </p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                    <h3 className="text-sm font-semibold text-gray-200 mb-3">4+ Dragons</h3>
                    <ProbXObjectiveTable rows={pxo.dragons_4plus} />
                  </div>
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                    <h3 className="text-sm font-semibold text-gray-200 mb-3">First Baron</h3>
                    <ProbXObjectiveTable rows={pxo.first_baron} />
                  </div>
                </div>
              </section>
            )
          })()}

          <p className="text-xs text-gray-600">
            Updated {new Date(data.generated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
      )}
    </div>
  )
}
