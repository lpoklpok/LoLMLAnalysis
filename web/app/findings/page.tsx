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

interface FirstPickSummary {
  games:    number
  actual:   number | null
  expected: number | null
  outperf:  number | null
}

interface FirstPicksBlock {
  overall:         FirstPickSummary
  by_role_overall: Record<string, FirstPickSummary>
  by_position:     Record<string, ChampionRow[]>
}

interface FlexRow {
  champion:     string
  games:        number
  primary_role: string
  flex_pct:     number
  roles:        Record<string, number>
}

interface BlindPicksBlock {
  overall:         FirstPickSummary
  by_role_overall: Record<string, FirstPickSummary>
  by_position:     Record<string, ChampionRow[]>
  top_overall:     ChampionRow[]
}

interface CounterPickRow {
  champion:         string
  games_counter:    number
  actual_counter:   number
  expected_counter: number
  delta_counter:    number
  games_blind:      number
  delta_blind:      number | null
  lift:             number | null
}

interface CounterPicksBlock {
  overall:         FirstPickSummary
  by_role_overall: Record<string, FirstPickSummary>
  by_position:     Record<string, CounterPickRow[]>
  top_overall:     CounterPickRow[]
}

type VsChampionData = Record<string, Record<string, ChampionRow[]>>

interface FindingsData {
  generated:           string
  year:                number
  min_games:           number
  min_games_major:     number
  min_firstpick?:      number
  min_firstpick_major?: number
  by_position:         Record<string, ChampionRow[]>
  by_position_major:   Record<string, ChampionRow[]>
  matchups:            Record<string, MatchupRow[]>
  matchups_major:      Record<string, MatchupRow[]>
  synergies:           SynergyRow[]
  synergies_major:     SynergyRow[]
  first_picks?:        FirstPicksBlock
  first_picks_major?:  FirstPicksBlock
  min_flex?:           number
  min_flex_major?:     number
  flex_picks?:         FlexRow[]
  flex_picks_major?:   FlexRow[]
  min_blindpick?:      number
  min_blindpick_major?: number
  blind_picks?:        BlindPicksBlock
  blind_picks_major?:  BlindPicksBlock
  min_counterpick?:    number
  min_counterpick_major?: number
  counter_picks?:      CounterPicksBlock
  counter_picks_major?: CounterPicksBlock
  min_vs?:             number
  min_vs_major?:       number
  vs_champion?:        VsChampionData
  vs_champion_major?:  VsChampionData
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

// ---- Blind pick table ----
function BlindPickTable({ rows }: { rows: ChampionRow[] }) {
  const sorted = [...rows].sort((a, b) => b.games - a.games).slice(0, 15)
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-gray-500 border-b border-gray-800">
          <th className="text-left pb-2 font-normal">Champion</th>
          <th className="text-right pb-2 font-normal">Games</th>
          <th className="text-right pb-2 font-normal">Actual WR</th>
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
  )
}

function BlindPosTabs({ pos, setPos }: { pos: 'overall' | typeof POSITIONS[number]; setPos: (p: 'overall' | typeof POSITIONS[number]) => void }) {
  const items: ('overall' | typeof POSITIONS[number])[] = ['overall', ...POSITIONS]
  const label: Record<string, string> = { overall: 'Overall', ...POS_LABEL }
  return (
    <div className="flex gap-2 mb-6 flex-wrap">
      {items.map(p => (
        <button key={p} onClick={() => setPos(p)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            pos === p
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
          }`}>
          {label[p]}
        </button>
      ))}
    </div>
  )
}

// ---- Counter pick table ----
function CounterPickTable({ rows }: { rows: CounterPickRow[] }) {
  const sorted = [...rows].sort((a, b) => b.games_counter - a.games_counter).slice(0, 15)
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-gray-500 border-b border-gray-800">
          <th className="text-left pb-2 font-normal">Champion</th>
          <th className="text-right pb-2 font-normal">Counter G</th>
          <th className="text-right pb-2 font-normal">Δ Counter</th>
          <th className="text-right pb-2 font-normal pl-3">Blind G</th>
          <th className="text-right pb-2 font-normal">Δ Blind</th>
          <th className="text-right pb-2 font-normal pl-3" title="Δ Counter − Δ Blind">Lift</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={r.champion} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
            <td className="py-1.5 pr-3 text-gray-200">{r.champion}</td>
            <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games_counter}</td>
            <td className={`py-1.5 text-right tabular-nums ${outperfColor(r.delta_counter)}`}>{sign(r.delta_counter)}</td>
            <td className="py-1.5 pl-3 text-right text-gray-600 tabular-nums">{r.games_blind}</td>
            <td className={`py-1.5 text-right tabular-nums ${r.delta_blind != null ? outperfColor(r.delta_blind) : 'text-gray-700'}`}>
              {r.delta_blind != null ? sign(r.delta_blind) : '—'}
            </td>
            <td className={`py-1.5 pl-3 text-right tabular-nums font-semibold ${r.lift != null ? outperfColor(r.lift) : 'text-gray-700'}`}>
              {r.lift != null ? sign(r.lift) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CounterPosTabs({ pos, setPos }: { pos: 'overall' | typeof POSITIONS[number]; setPos: (p: 'overall' | typeof POSITIONS[number]) => void }) {
  const items: ('overall' | typeof POSITIONS[number])[] = ['overall', ...POSITIONS]
  const label: Record<string, string> = { overall: 'Overall', ...POS_LABEL }
  return (
    <div className="flex gap-2 mb-6 flex-wrap">
      {items.map(p => (
        <button key={p} onClick={() => setPos(p)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            pos === p
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
          }`}>
          {label[p]}
        </button>
      ))}
    </div>
  )
}

// ---- Flex pick table ----
const ROLE_COLORS: Record<string, string> = {
  top: 'bg-rose-600',
  jng: 'bg-emerald-600',
  mid: 'bg-amber-500',
  bot: 'bg-sky-600',
  sup: 'bg-violet-600',
}

function FlexRoleBar({ roles, total }: { roles: Record<string, number>; total: number }) {
  return (
    <div className="flex h-4 w-full rounded overflow-hidden bg-gray-800">
      {POSITIONS.map(p => {
        const n = roles[p] ?? 0
        if (n === 0) return null
        const w = (n / total) * 100
        return (
          <div
            key={p}
            className={`${ROLE_COLORS[p]} h-full`}
            style={{ width: `${w}%` }}
            title={`${POS_LABEL[p]}: ${n} (${w.toFixed(0)}%)`}
          />
        )
      })}
    </div>
  )
}

function FlexLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-gray-500">
      {POSITIONS.map(p => (
        <div key={p} className="flex items-center gap-1.5">
          <div className={`w-2.5 h-2.5 rounded ${ROLE_COLORS[p]}`} />
          <span>{POS_LABEL[p]}</span>
        </div>
      ))}
    </div>
  )
}

function FlexTable({ rows }: { rows: FlexRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-gray-500 border-b border-gray-800">
          <th className="text-left pb-2 font-normal">Champion</th>
          <th className="text-right pb-2 font-normal">G</th>
          <th className="text-left pb-2 font-normal pl-3">Primary</th>
          <th className="text-right pb-2 font-normal">Flex %</th>
          <th className="text-left pb-2 font-normal pl-4 w-64">Role split</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.champion} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
            <td className="py-1.5 pr-3 text-gray-200">{r.champion}</td>
            <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
            <td className="py-1.5 pl-3 text-gray-400 tabular-nums">{POS_LABEL[r.primary_role]}</td>
            <td className="py-1.5 text-right text-gray-200 tabular-nums font-mono">{pct(r.flex_pct)}</td>
            <td className="py-1.5 pl-4">
              <FlexRoleBar roles={r.roles} total={r.games} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---- Most-common champion table (sorted by games desc) ----
function MostCommonHalf({ rows }: { rows: ChampionRow[] }) {
  const sorted = [...rows].sort((a, b) => b.games - a.games).slice(0, TOP_N)
  return (
    <div className="flex-1 min-w-0">
      <h3 className="text-sm font-semibold uppercase tracking-wide mb-3 text-gray-300">Most Common</h3>
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
  const [fpPos, setFpPos]     = useState<typeof POSITIONS[number]>('top')
  const [bpPos, setBpPos]     = useState<'overall' | typeof POSITIONS[number]>('overall')
  const [cpPos, setCpPos]     = useState<'overall' | typeof POSITIONS[number]>('overall')
  const [vsChamp, setVsChamp] = useState<string>('')
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

          {/* ── Section: First Picks ── */}
          {(() => {
            const fp = majorOnly ? data.first_picks_major : data.first_picks
            if (!fp) return null
            const overall = fp.overall
            const roleStats = fp.by_role_overall[fpPos]
            const roleRows = gFilter(fp.by_position[fpPos] ?? [])
            const stat = (label: string, sub: string, s: FirstPickSummary) => (
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-1">{label}</div>
                <div className="text-[10px] text-gray-600 mb-2">{sub}</div>
                <div className="flex items-baseline gap-3">
                  <div className={`text-2xl font-bold tabular-nums ${s.actual != null ? wrColor(s.actual) : 'text-gray-500'}`}>
                    {s.actual != null ? pct(s.actual) : '—'}
                  </div>
                  <div className="text-xs text-gray-500 tabular-nums">
                    vs {s.expected != null ? pct(s.expected) : '—'} model
                  </div>
                  <div className={`text-sm font-mono tabular-nums ${s.outperf != null ? outperfColor(s.outperf) : 'text-gray-500'}`}>
                    {s.outperf != null ? sign(s.outperf) : ''}
                  </div>
                </div>
                <div className="text-[10px] text-gray-600 mt-1">{s.games.toLocaleString()} games</div>
              </div>
            )
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">First Picks</h2>
                <p className="text-gray-500 text-sm mb-4">
                  When a team has first pick (B1 in draft order, or the team flagged with first-pick priority),
                  this is the win rate of the champion they opened with — and how it compares to the model&apos;s pre-game expectation
                  for that team. The first-picked role is inferred from the post-game role assignment.
                </p>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-4">
                  <div className="flex flex-col md:flex-row gap-6">
                    {stat('Overall first-pick team',  'Across all roles, this year',     overall)}
                    <div className="w-px bg-gray-800 shrink-0 hidden md:block" />
                    {stat(`${POS_LABEL[fpPos]} first picks`, 'Games where pick1 ended up in this role', roleStats)}
                  </div>
                </div>
                <PosTabs pos={fpPos} setPos={setFpPos} />
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-6">
                  {roleRows.length === 0 ? (
                    <div className="text-gray-500 text-sm">
                      No champions meet the minimum-games threshold for {POS_LABEL[fpPos]} first picks
                      {majorOnly ? ' in major leagues' : ''}.
                    </div>
                  ) : (
                    <>
                      <MostCommonHalf rows={roleRows} />
                      <div className="h-px bg-gray-800" />
                      <div className="flex gap-8">
                        <ChampionHalf rows={roleRows} direction="over" />
                        <div className="w-px bg-gray-800 shrink-0" />
                        <ChampionHalf rows={roleRows} direction="under" />
                      </div>
                    </>
                  )}
                </div>
              </section>
            )
          })()}

          {/* ── Section: Flex Picks ── */}
          {(() => {
            const flex = majorOnly ? data.flex_picks_major : data.flex_picks
            if (!flex || flex.length === 0) return null
            const minThreshold = majorOnly ? data.min_flex_major : data.min_flex
            const displayed = flex.slice(0, 25)
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Flex Picks</h2>
                <p className="text-gray-500 text-sm mb-4">
                  Champions played across multiple roles. <span className="text-gray-300 font-mono">Flex %</span> = share of
                  games played outside the champion&apos;s most-common role (higher = more genuinely flex). Useful for
                  identifying drafts where the opponent can&apos;t pin a champion to a role.
                  Min {minThreshold ?? 20} games.
                </p>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-3">
                  <FlexLegend />
                  <FlexTable rows={displayed} />
                </div>
              </section>
            )
          })()}

          {/* ── Section: Blind Picks ── */}
          {(() => {
            const bp = majorOnly ? data.blind_picks_major : data.blind_picks
            if (!bp) return null
            const minThreshold = majorOnly ? data.min_blindpick_major : data.min_blindpick
            const rows = bpPos === 'overall'
              ? bp.top_overall
              : (bp.by_position[bpPos] ?? [])
            const summarySelected = bpPos === 'overall' ? bp.overall : bp.by_role_overall[bpPos]
            const headerLabel = bpPos === 'overall' ? 'Across all roles' : `${POS_LABEL[bpPos]} role`
            const stat = (label: string, sub: string, s: FirstPickSummary) => (
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-1">{label}</div>
                <div className="text-[10px] text-gray-600 mb-2">{sub}</div>
                <div className="flex items-baseline gap-3">
                  <div className={`text-2xl font-bold tabular-nums ${s.actual != null ? wrColor(s.actual) : 'text-gray-500'}`}>
                    {s.actual != null ? pct(s.actual) : '—'}
                  </div>
                  <div className="text-xs text-gray-500 tabular-nums">
                    vs {s.expected != null ? pct(s.expected) : '—'} model
                  </div>
                  <div className={`text-sm font-mono tabular-nums ${s.outperf != null ? outperfColor(s.outperf) : 'text-gray-500'}`}>
                    {s.outperf != null ? sign(s.outperf) : ''}
                  </div>
                </div>
                <div className="text-[10px] text-gray-600 mt-1">{s.games.toLocaleString()} blind-pick instances</div>
              </div>
            )
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Blind Picks</h2>
                <p className="text-gray-500 text-sm mb-4">
                  In each role, the team that picked their role champion first overall (in draft order) is &quot;blind&quot; —
                  they committed before seeing the opposing role pick. This counts all blind-pick instances
                  (every game has 5 blind picks, one per role) and shows the most-popular blind picks with their
                  team&apos;s win rate vs the model&apos;s pre-game expectation. Min {minThreshold ?? 15} games.
                </p>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-4">
                  <div className="flex flex-col md:flex-row gap-6">
                    {stat('Overall blind-pick team', 'Pooled across all 5 roles', bp.overall)}
                    <div className="w-px bg-gray-800 shrink-0 hidden md:block" />
                    {stat(`${headerLabel} blind-pick team`, 'Currently selected tab', summarySelected ?? bp.overall)}
                  </div>
                </div>
                <BlindPosTabs pos={bpPos} setPos={setBpPos} />
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                  {rows.length === 0 ? (
                    <div className="text-gray-500 text-sm">
                      No champions meet the minimum-games threshold for this view.
                    </div>
                  ) : (
                    <BlindPickTable rows={rows} />
                  )}
                </div>
              </section>
            )
          })()}

          {/* ── Section: Counter Picks ── */}
          {(() => {
            const cp = majorOnly ? data.counter_picks_major : data.counter_picks
            if (!cp) return null
            const minThreshold = majorOnly ? data.min_counterpick_major : data.min_counterpick
            const rows = cpPos === 'overall'
              ? cp.top_overall
              : (cp.by_position[cpPos] ?? [])
            const summarySelected = cpPos === 'overall' ? cp.overall : cp.by_role_overall[cpPos]
            const headerLabel = cpPos === 'overall' ? 'Across all roles' : `${POS_LABEL[cpPos]} role`
            const stat = (label: string, sub: string, s: FirstPickSummary) => (
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-1">{label}</div>
                <div className="text-[10px] text-gray-600 mb-2">{sub}</div>
                <div className="flex items-baseline gap-3">
                  <div className={`text-2xl font-bold tabular-nums ${s.actual != null ? wrColor(s.actual) : 'text-gray-500'}`}>
                    {s.actual != null ? pct(s.actual) : '—'}
                  </div>
                  <div className="text-xs text-gray-500 tabular-nums">
                    vs {s.expected != null ? pct(s.expected) : '—'} model
                  </div>
                  <div className={`text-sm font-mono tabular-nums ${s.outperf != null ? outperfColor(s.outperf) : 'text-gray-500'}`}>
                    {s.outperf != null ? sign(s.outperf) : ''}
                  </div>
                </div>
                <div className="text-[10px] text-gray-600 mt-1">{s.games.toLocaleString()} counter-pick instances</div>
              </div>
            )
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Counter Picks</h2>
                <p className="text-gray-500 text-sm mb-4">
                  Champions picked <span className="text-gray-300">second</span> in their role pair — the team
                  knew what they were facing. Most popular counter picks per role, with each champion&apos;s
                  delta when counter-picked, their delta when <span className="text-gray-300">blind</span>-picked
                  for comparison, and the <span className="text-gray-300 font-mono">Lift</span> column =
                  Δ counter − Δ blind. Positive lift means the champion benefits from being counter-picked.
                  Min {minThreshold ?? 15} counter-pick games.
                </p>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-4">
                  <div className="flex flex-col md:flex-row gap-6">
                    {stat('Overall counter-pick team', 'Pooled across all 5 roles', cp.overall)}
                    <div className="w-px bg-gray-800 shrink-0 hidden md:block" />
                    {stat(`${headerLabel} counter-pick team`, 'Currently selected tab', summarySelected ?? cp.overall)}
                  </div>
                </div>
                <CounterPosTabs pos={cpPos} setPos={setCpPos} />
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                  {rows.length === 0 ? (
                    <div className="text-gray-500 text-sm">
                      No champions meet the minimum-games threshold for this view.
                    </div>
                  ) : (
                    <CounterPickTable rows={rows} />
                  )}
                </div>
              </section>
            )
          })()}

          {/* ── Section: Counters vs Specific Champion ── */}
          {(() => {
            const vs = majorOnly ? data.vs_champion_major : data.vs_champion
            if (!vs) return null
            const minThreshold = majorOnly ? data.min_vs_major : data.min_vs
            const champions = Object.keys(vs).sort()
            if (champions.length === 0) return null
            const selected = vsChamp && vs[vsChamp] ? vsChamp : champions[0]
            const byRole = vs[selected] ?? {}
            const rolesPresent = POSITIONS.filter(p => (byRole[p]?.length ?? 0) > 0)
            return (
              <section>
                <h2 className="text-lg font-semibold text-gray-100 mb-1">Counters Against a Champion</h2>
                <p className="text-gray-500 text-sm mb-4">
                  Pick a champion to see the most-common counter picks against them — i.e. champions picked
                  <span className="text-gray-300"> second </span>in the role pair when this champion was
                  blind-picked. <span className="text-gray-300">Actual WR</span> is from the counter
                  champion&apos;s perspective. Min {minThreshold ?? 3} games per matchup.
                </p>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mb-4 flex items-center gap-3 flex-wrap">
                  <label htmlFor="vs-champ" className="text-sm text-gray-400">Show counters against</label>
                  <select
                    id="vs-champ"
                    value={selected}
                    onChange={e => setVsChamp(e.target.value)}
                    className="bg-gray-800 text-gray-100 text-sm rounded-md px-3 py-1.5 border border-gray-700 focus:outline-none focus:border-blue-500"
                  >
                    {champions.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <span className="text-xs text-gray-600 ml-auto">
                    {champions.length} champions with blind-pick data{majorOnly ? ' (major leagues)' : ''}
                  </span>
                </div>
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-6">
                  {rolesPresent.length === 0 ? (
                    <div className="text-gray-500 text-sm">No counter data for {selected}.</div>
                  ) : rolesPresent.map(role => {
                    const rows = byRole[role] ?? []
                    return (
                      <div key={role}>
                        <h3 className="text-sm font-semibold text-gray-200 mb-3">
                          {POS_LABEL[role]} <span className="text-gray-600 font-normal text-xs ml-1">{rows.length} counters</span>
                        </h3>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-gray-500 border-b border-gray-800">
                              <th className="text-left pb-2 font-normal">Counter</th>
                              <th className="text-right pb-2 font-normal">Games</th>
                              <th className="text-right pb-2 font-normal">Actual WR</th>
                              <th className="text-right pb-2 font-normal">Model</th>
                              <th className="text-right pb-2 font-normal">Δ</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.slice(0, 12).map((r, i) => (
                              <tr key={r.champion} className={i % 2 === 0 ? 'bg-gray-900/40' : ''}>
                                <td className="py-1.5 pr-3 text-gray-200">{r.champion}</td>
                                <td className="py-1.5 text-right text-gray-500 tabular-nums">{r.games}</td>
                                <td className={`py-1.5 text-right tabular-nums ${wrColor(r.actual)}`}>{pct(r.actual)}</td>
                                <td className="py-1.5 text-right text-gray-500 tabular-nums">{pct(r.expected)}</td>
                                <td className={`py-1.5 text-right tabular-nums ${outperfColor(r.outperf)}`}>{sign(r.outperf)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })()}

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
