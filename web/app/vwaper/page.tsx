'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Side = 'BUY' | 'SELL'

type OutcomeOpt = { name: string; token_id: string }
type SubmarketOpt = { mtype: string; label: string; condition_id: string; outcomes: OutcomeOpt[]; volume: number }
type EventOpt = { slug: string; title: string; start_date: string; volume: number; submarkets: SubmarketOpt[] }

type SliceState = {
  idx:                number
  target_size:        number
  started_ts:         number
  passive_price:      number
  passive_order_id:   string
  passive_filled:     number
  taker_price:        number
  taker_order_id:     string
  taker_filled:       number
  posted_price:       number
  order_id:           string
  filled_size:        number
  avg_fill_price:     number
  error:              string
}

type Job = {
  job_id:         string
  machine_id:     string
  token_id:       string
  side:           Side
  total_size:     number
  horizon_sec:    number
  n_slices:       number
  max_price:      number | null
  status:         'pending' | 'running' | 'completed' | 'cancelled' | 'failed'
  created_ts:     number
  started_ts:     number
  ended_ts:       number
  error:          string
  filled_size:    number
  avg_fill_price: number
  slices:         SliceState[]
  log:            string[]
  cancel_requested: boolean
  dry_run:        boolean
}

const STORAGE_KEY = 'vwaper:form:v1'

type Persisted = {
  selectedSlug?:    string
  selectedMtype?:   string
  selectedOutcome?: string
  tokenIdInput?:    string
  side?:            Side
  size?:            number
  horizonMin?:      number
  slices?:          number
  maxPrice?:        string
  maxSpreadCross?:  number
  maxRecentMove?:   number
  recentMoveWindowSec?: number
  passiveWaitSec?:  string
  dryRun?:          boolean
}

export default function VwaperPage() {
  // ── Event tree ────────────────────────────────────────────────────────────
  const [events, setEvents]           = useState<EventOpt[]>([])
  const [eventsErr, setEventsErr]     = useState('')
  const [eventsLoading, setEventsLoading] = useState(false)
  const [selectedSlug, setSelectedSlug]   = useState('')
  const [selectedMtype, setSelectedMtype] = useState('')
  const [selectedOutcome, setSelectedOutcome] = useState('')
  const [tokenIdInput, setTokenIdInput]   = useState('')

  // ── Form state ────────────────────────────────────────────────────────────
  const [side, setSide]                 = useState<Side>('BUY')
  const [size, setSize]                 = useState(100)
  const [horizonMin, setHorizonMin]     = useState(10)
  const [slices, setSlices]             = useState(10)
  const [maxPrice, setMaxPrice]         = useState<string>('')
  const [maxSpreadCross, setMaxSpreadCross] = useState(0.03)
  const [maxRecentMove, setMaxRecentMove]   = useState(0.03)
  const [recentMoveWindowSec, setRecentMoveWindowSec] = useState(1.0)
  const [passiveWaitSec, setPassiveWaitSec] = useState<string>('')  // '' = auto (slice/2)
  const [dryRun, setDryRun]             = useState(true)

  // ── localStorage persistence ────────────────────────────────────────────
  const [loaded, setLoaded] = useState(false)
  // Set true during the restore so cascade-clear effects don't blow away
  // the just-restored picks.
  const restoringRef = useRef(false)

  // Load saved form values on mount
  useEffect(() => {
    if (typeof window === 'undefined') { setLoaded(true); return }
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const v = JSON.parse(raw) as Persisted
        restoringRef.current = true
        if (v.selectedSlug    !== undefined) setSelectedSlug(v.selectedSlug)
        if (v.selectedMtype   !== undefined) setSelectedMtype(v.selectedMtype)
        if (v.selectedOutcome !== undefined) setSelectedOutcome(v.selectedOutcome)
        if (v.tokenIdInput    !== undefined) setTokenIdInput(v.tokenIdInput)
        if (v.side            !== undefined) setSide(v.side)
        if (v.size            !== undefined) setSize(v.size)
        if (v.horizonMin      !== undefined) setHorizonMin(v.horizonMin)
        if (v.slices          !== undefined) setSlices(v.slices)
        if (v.maxPrice        !== undefined) setMaxPrice(v.maxPrice)
        if (v.maxSpreadCross  !== undefined) setMaxSpreadCross(v.maxSpreadCross)
        if (v.maxRecentMove   !== undefined) setMaxRecentMove(v.maxRecentMove)
        if (v.recentMoveWindowSec !== undefined) setRecentMoveWindowSec(v.recentMoveWindowSec)
        if (v.passiveWaitSec  !== undefined) setPassiveWaitSec(v.passiveWaitSec)
        if (v.dryRun          !== undefined) setDryRun(v.dryRun)
      }
    } catch { /* ignore */ }
    setLoaded(true)
    // Clear the restoring flag after this paint cycle so subsequent user
    // edits trigger the cascade-clear effects normally.
    queueMicrotask(() => { restoringRef.current = false })
  }, [])

  // Save to localStorage on every change (skipped until restore completes)
  useEffect(() => {
    if (!loaded || typeof window === 'undefined') return
    const all: Persisted = {
      selectedSlug, selectedMtype, selectedOutcome, tokenIdInput,
      side, size, horizonMin, slices, maxPrice, maxSpreadCross,
      maxRecentMove, recentMoveWindowSec, passiveWaitSec, dryRun,
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch { /* quota */ }
  }, [loaded, selectedSlug, selectedMtype, selectedOutcome, tokenIdInput,
      side, size, horizonMin, slices, maxPrice, maxSpreadCross,
      maxRecentMove, recentMoveWindowSec, passiveWaitSec, dryRun])

  // Load events on mount
  useEffect(() => {
    setEventsLoading(true)
    fetch('/api/vwap/events').then(r => r.json()).then(j => {
      if (j.events) setEvents(j.events as EventOpt[])
      else setEventsErr(j.error || 'no events returned')
    }).catch(e => setEventsErr(`${e}`)).finally(() => setEventsLoading(false))
  }, [])

  // Derived: current event, submarket, outcome
  const currentEvent = useMemo(() => events.find(e => e.slug === selectedSlug), [events, selectedSlug])
  const currentSub   = useMemo(() => currentEvent?.submarkets.find(s => s.mtype === selectedMtype), [currentEvent, selectedMtype])
  const currentOutcome = useMemo(() => currentSub?.outcomes.find(o => o.name === selectedOutcome), [currentSub, selectedOutcome])

  // When picks change, push the resolved token_id into the input (overrides manual paste)
  useEffect(() => {
    if (currentOutcome) setTokenIdInput(currentOutcome.token_id)
  }, [currentOutcome])

  // When the user picks a new event, reset downstream picks (skip during restore)
  useEffect(() => {
    if (restoringRef.current) return
    setSelectedMtype('')
    setSelectedOutcome('')
  }, [selectedSlug])
  useEffect(() => {
    if (restoringRef.current) return
    setSelectedOutcome('')
  }, [selectedMtype])

  // ── Active job state ─────────────────────────────────────────────────────
  const [job, setJob]                 = useState<Job | null>(null)
  const [machineId, setMachineId]     = useState('')
  const [starting, setStarting]       = useState(false)
  const [cancelling, setCancelling]   = useState(false)
  const [pollErr, setPollErr]         = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Start + poll ─────────────────────────────────────────────────────────
  const startJob = useCallback(async () => {
    if (!tokenIdInput) { alert('Need a token_id (resolve a market first or paste one)'); return }
    setStarting(true)
    try {
      const body = {
        token_id: tokenIdInput,
        side,
        total_size: size,
        horizon_sec: Math.max(60, Math.round(horizonMin * 60)),
        n_slices: slices,
        max_price: maxPrice ? Number(maxPrice) : null,
        max_spread_cross: maxSpreadCross,
        max_recent_move: maxRecentMove,
        recent_move_window_sec: recentMoveWindowSec,
        passive_wait_sec: passiveWaitSec === '' ? null : Number(passiveWaitSec),
        dry_run: dryRun,
      }
      const r = await fetch('/api/vwap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) { alert(`Start failed: ${JSON.stringify(j)}`); return }
      setMachineId(j.machine_id || '')
      // Immediately fetch status
      await pollOnce(j.job_id, j.machine_id || '')
    } finally {
      setStarting(false)
    }
  }, [tokenIdInput, side, size, horizonMin, slices, maxPrice, maxSpreadCross,
      maxRecentMove, recentMoveWindowSec, passiveWaitSec, dryRun])

  const pollOnce = useCallback(async (jobId: string, machine: string) => {
    setPollErr('')
    try {
      const url = `/api/vwap/${jobId}${machine ? `?machine=${encodeURIComponent(machine)}` : ''}`
      const r = await fetch(url)
      const j = await r.json()
      if (r.ok && j.job) {
        setJob(j.job)
        if (j.machine_id && !machine) setMachineId(j.machine_id)
      } else {
        setPollErr(j.error || `status ${r.status}`)
      }
    } catch (e) {
      setPollErr(`network: ${e}`)
    }
  }, [])

  // Poll the active job every 2s while it's in a non-terminal state
  useEffect(() => {
    if (!job) return
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(() => { pollOnce(job.job_id, machineId) }, 2000)
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [job, machineId, pollOnce])

  const cancelJob = useCallback(async () => {
    if (!job) return
    setCancelling(true)
    try {
      const url = `/api/vwap/${job.job_id}${machineId ? `?machine=${encodeURIComponent(machineId)}` : ''}`
      await fetch(url, { method: 'DELETE' })
      await pollOnce(job.job_id, machineId)
    } finally {
      setCancelling(false)
    }
  }, [job, machineId, pollOnce])

  // ── Render ───────────────────────────────────────────────────────────────
  const fillPct = job ? (100 * job.filled_size / Math.max(job.total_size, 1)) : 0
  const isTerminal = job && (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed')

  return (
    <div style={{ padding: '24px', maxWidth: 1100, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>VWAPer</h1>
      <p style={{ color: '#666' }}>
        Splits a Polymarket order into N slices over a time horizon. Each
        slice runs two phases: <b>passive</b> first (rests inside the spread
        at best_bid + 1¢ / best_ask − 1¢ for <code>passive_wait_sec</code>
        seconds), then <b>taker</b> (FAK at top of book, gated by{' '}
        <code>max_spread_cross</code>). Unfilled rolls forward. Set{' '}
        <code>passive_wait_sec = 0</code> for pure-taker.
      </p>

      <section style={cardStyle}>
        <h2 style={h2Style}>1. Pick a market</h2>
        {eventsLoading && <div style={{ color: '#888', fontSize: 13 }}>Loading events…</div>}
        {eventsErr && <div style={{ color: '#c00', fontSize: 13 }}>events error: {eventsErr}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
          <Field label={`Event (${events.length})`}>
            <select style={inputStyle} value={selectedSlug} onChange={e => setSelectedSlug(e.target.value)}>
              <option value="">— select event —</option>
              {events.map(ev => (
                <option key={ev.slug} value={ev.slug}>
                  {ev.title.length > 70 ? ev.title.slice(0, 70) + '…' : ev.title}
                  {ev.volume > 0 ? `  ($${ev.volume.toLocaleString(undefined, {maximumFractionDigits: 0})})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Submarket">
            <select style={inputStyle} value={selectedMtype} onChange={e => setSelectedMtype(e.target.value)}
                    disabled={!currentEvent}>
              <option value="">{currentEvent ? '— select —' : '(pick event first)'}</option>
              {currentEvent?.submarkets.map(s => (
                <option key={s.mtype} value={s.mtype}>
                  {s.label}{s.volume > 0 ? `  ($${s.volume.toLocaleString(undefined, {maximumFractionDigits: 0})})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Outcome">
            <select style={inputStyle} value={selectedOutcome} onChange={e => setSelectedOutcome(e.target.value)}
                    disabled={!currentSub}>
              <option value="">{currentSub ? '— select —' : '(pick submarket first)'}</option>
              {currentSub?.outcomes.map(o => (
                <option key={o.token_id} value={o.name}>{o.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="token_id (auto-filled from dropdowns; paste directly to override)">
            <input style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }}
              placeholder="123456789..." value={tokenIdInput}
              onChange={e => setTokenIdInput(e.target.value)} />
          </Field>
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={h2Style}>2. Execution params</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <Field label="Side">
            <select style={inputStyle} value={side} onChange={e => setSide(e.target.value as Side)}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </Field>
          <Field label="Total shares">
            <input style={inputStyle} type="number" value={size} min={1}
              onChange={e => setSize(Number(e.target.value))} />
          </Field>
          <Field label="Horizon (min)">
            <input style={inputStyle} type="number" value={horizonMin} min={1} step={1}
              onChange={e => setHorizonMin(Number(e.target.value))} />
          </Field>
          <Field label="Slices">
            <input style={inputStyle} type="number" value={slices} min={1} max={60}
              onChange={e => setSlices(Number(e.target.value))} />
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 8 }}>
          <Field label={side === 'BUY' ? 'Max price (cap)' : 'Min price (floor)'}>
            <input style={inputStyle} type="number" step="0.001" value={maxPrice}
              onChange={e => setMaxPrice(e.target.value)} placeholder="optional" />
          </Field>
          <Field label="Passive wait (sec)">
            <input style={inputStyle} type="number" step="1" value={passiveWaitSec}
              onChange={e => setPassiveWaitSec(e.target.value)} placeholder="auto (slice/2)" />
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              How long to rest passive at best_bid + 1¢ before escalating to taker. 0 = pure taker.
            </div>
          </Field>
          <Field label="Max spread to take (¢)">
            <input style={inputStyle} type="number" step="0.001" value={maxSpreadCross}
              onChange={e => setMaxSpreadCross(Number(e.target.value))} placeholder="0.03" />
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              In taker phase, fire FAK only if spread ≤ this. Else wait / roll.
            </div>
          </Field>
          <Field label="Dry run">
            <label style={{ display: 'flex', alignItems: 'center', height: 32 }}>
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              <span style={{ marginLeft: 6 }}>simulate, no orders</span>
            </label>
          </Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 8 }}>
          <Field label="Vol guard: max move (¢)">
            <input style={inputStyle} type="number" step="0.001" value={maxRecentMove}
              onChange={e => setMaxRecentMove(Number(e.target.value))} placeholder="0.03" />
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              Skip FAK if bid/ask moved more than this within the window. Set high (e.g. 1) to disable.
            </div>
          </Field>
          <Field label="Vol guard: window (sec)">
            <input style={inputStyle} type="number" step="0.1" min={0} value={recentMoveWindowSec}
              onChange={e => setRecentMoveWindowSec(Number(e.target.value))} placeholder="1.0" />
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              Seconds between vol-check snapshots before firing. 0 = disable guard.
            </div>
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <button style={{ ...btnStyle, background: dryRun ? '#456' : '#085', color: 'white' }}
            onClick={startJob} disabled={starting || !tokenIdInput}>
            {starting ? 'Starting…' : (dryRun ? 'Start DRY RUN' : `Start ${side} ${size} over ${horizonMin}m`)}
          </button>
          {!dryRun && (
            <span style={{ marginLeft: 12, color: '#c70', fontSize: 13 }}>
              ⚠ Live mode — orders will hit Polymarket.
            </span>
          )}
        </div>
      </section>

      {job && (
        <section style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={h2Style}>3. Job {job.job_id}</h2>
            <div>
              <StatusBadge status={job.status} />
              {!isTerminal && (
                <button style={{ ...btnStyle, marginLeft: 10, background: '#c33', color: 'white' }}
                  onClick={cancelJob} disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 12 }}>
            <Stat label="Filled" value={`${job.filled_size.toFixed(2)} / ${job.total_size.toFixed(2)}`} sub={`${fillPct.toFixed(1)}%`} />
            <Stat label="Avg fill" value={job.avg_fill_price > 0 ? job.avg_fill_price.toFixed(4) : '—'} />
            <Stat label="Notional" value={`$${(job.filled_size * job.avg_fill_price).toFixed(2)}`} />
            <Stat label="Machine" value={job.machine_id?.slice(0, 8) || '—'} />
          </div>
          {pollErr && <div style={{ color: '#c00', marginTop: 8 }}>poll error: {pollErr}</div>}

          <h3 style={h3Style}>Slices</h3>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>#</th>
                <th style={thStyle}>started</th>
                <th style={thStyle}>target</th>
                <th style={thStyle}>passive px</th>
                <th style={thStyle}>P1 filled</th>
                <th style={thStyle}>taker px</th>
                <th style={thStyle}>P2 filled</th>
                <th style={thStyle}>total filled</th>
                <th style={thStyle}>avg fill</th>
                <th style={thStyle}>note</th>
              </tr>
            </thead>
            <tbody>
              {job.slices.map(s => (
                <tr key={s.idx}>
                  <td style={tdStyle}>{s.idx}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: '#666' }}>{fmtTime(s.started_ts)}</td>
                  <td style={tdStyle}>{s.target_size.toFixed(2)}</td>
                  <td style={tdStyle}>{s.passive_price > 0 ? s.passive_price.toFixed(4) : '—'}</td>
                  <td style={tdStyle}>{s.passive_filled.toFixed(2)}</td>
                  <td style={tdStyle}>{s.taker_price > 0 ? s.taker_price.toFixed(4) : '—'}</td>
                  <td style={tdStyle}>{s.taker_filled.toFixed(2)}</td>
                  <td style={tdStyle}>{s.filled_size.toFixed(2)}</td>
                  <td style={tdStyle}>{s.avg_fill_price > 0 ? s.avg_fill_price.toFixed(4) : '—'}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: '#888' }}>{s.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={h3Style}>Log</h3>
          <pre style={logStyle}>
            {job.log.slice(-40).join('\n')}
          </pre>
        </section>
      )}
    </div>
  )
}

// ── small UI helpers ─────────────────────────────────────────────────────────

function fmtTime(unixTs: number): string {
  if (!unixTs || unixTs <= 0) return '—'
  const d = new Date(unixTs * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6, padding: '8px 12px' }}>
      <div style={{ fontSize: 11, color: '#888' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#666' }}>{sub}</div>}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const color = ({
    running:   '#085',
    completed: '#06c',
    cancelled: '#888',
    failed:    '#c33',
    pending:   '#888',
  } as Record<string, string>)[status] || '#666'
  return <span style={{ background: color, color: 'white', padding: '4px 10px', borderRadius: 4, fontSize: 13 }}>{status}</span>
}

const cardStyle: React.CSSProperties = {
  background: 'white',
  border: '1px solid #eee',
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
}
const h2Style: React.CSSProperties = { margin: '0 0 12px 0', fontSize: 16 }
const h3Style: React.CSSProperties = { margin: '16px 0 8px 0', fontSize: 14 }
const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13, height: 32, boxSizing: 'border-box' }
const btnStyle: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ccc', borderRadius: 4, background: '#f4f4f4', cursor: 'pointer', fontSize: 13 }
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ddd', background: '#fafafa', fontWeight: 600 }
const tdStyle: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f0f0f0' }
const logStyle: React.CSSProperties = { background: '#111', color: '#0f0', padding: 12, borderRadius: 4, fontSize: 12, fontFamily: 'monospace', maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }
