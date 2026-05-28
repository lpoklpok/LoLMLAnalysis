'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Side = 'BUY' | 'SELL'

type SliceState = {
  idx:            number
  target_size:    number
  posted_price:   number
  order_id:       string
  filled_size:    number
  avg_fill_price: number
  repriced:       boolean
  error:          string
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

export default function VwaperPage() {
  // ── Form state ────────────────────────────────────────────────────────────
  const [tokenIdInput, setTokenIdInput] = useState('')
  const [slug, setSlug]                 = useState('')
  const [outcome, setOutcome]           = useState('')
  const [marketType, setMarketType]     = useState('match_winner')
  const [side, setSide]                 = useState<Side>('BUY')
  const [size, setSize]                 = useState(100)
  const [horizonMin, setHorizonMin]     = useState(10)
  const [slices, setSlices]             = useState(10)
  const [maxPrice, setMaxPrice]         = useState<string>('')
  const [dryRun, setDryRun]             = useState(true)

  const [resolveResult, setResolveResult] = useState<{ title?: string; token_id?: string; outcomes?: string[]; error?: string } | null>(null)
  const [resolving, setResolving]         = useState(false)

  // ── Active job state ─────────────────────────────────────────────────────
  const [job, setJob]                 = useState<Job | null>(null)
  const [machineId, setMachineId]     = useState('')
  const [starting, setStarting]       = useState(false)
  const [cancelling, setCancelling]   = useState(false)
  const [pollErr, setPollErr]         = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Resolvers ────────────────────────────────────────────────────────────
  const resolveToken = useCallback(async () => {
    if (!slug || !outcome) { setResolveResult({ error: 'slug + outcome required' }); return }
    setResolving(true)
    setResolveResult(null)
    try {
      const r = await fetch(`/api/vwap/resolve?slug=${encodeURIComponent(slug)}&outcome=${encodeURIComponent(outcome)}&market_type=${encodeURIComponent(marketType)}`)
      const j = await r.json()
      setResolveResult(j)
      if (j.token_id) setTokenIdInput(j.token_id)
    } catch (e) {
      setResolveResult({ error: `network: ${e}` })
    } finally {
      setResolving(false)
    }
  }, [slug, outcome, marketType])

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
  }, [tokenIdInput, side, size, horizonMin, slices, maxPrice, dryRun])

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
        Slices a Polymarket order over time. Each slice posts a passive resting
        order at best bid +1 tick (BUY) or best ask −1 tick (SELL), repriced
        once if unfilled. Unfilled size rolls to the next slice.
      </p>

      <section style={cardStyle}>
        <h2 style={h2Style}>1. Pick a market</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
          <Field label="Polymarket slug">
            <input style={inputStyle} placeholder="lol-kt-t1-2026-05-28"
              value={slug} onChange={e => setSlug(e.target.value)} />
          </Field>
          <Field label="Outcome">
            <input style={inputStyle} placeholder="T1"
              value={outcome} onChange={e => setOutcome(e.target.value)} />
          </Field>
          <Field label="Market type">
            <select style={inputStyle} value={marketType} onChange={e => setMarketType(e.target.value)}>
              <option value="match_winner">match_winner</option>
              <option value="game_1_winner">game_1_winner</option>
              <option value="game_2_winner">game_2_winner</option>
              <option value="game_3_winner">game_3_winner</option>
              <option value="game_handicap">game_handicap</option>
            </select>
          </Field>
          <button style={btnStyle} disabled={resolving || !slug || !outcome} onClick={resolveToken}>
            {resolving ? 'Resolving…' : 'Resolve →'}
          </button>
        </div>
        {resolveResult && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {resolveResult.error
              ? <span style={{ color: '#c00' }}>{resolveResult.error}{resolveResult.outcomes && ` — outcomes: ${resolveResult.outcomes.join(' / ')}`}</span>
              : <span style={{ color: '#080' }}>✓ {resolveResult.title} → token_id <code>{resolveResult.token_id?.slice(0, 18)}…</code></span>
            }
          </div>
        )}
        <Field label="…or paste token_id directly">
          <input style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }}
            placeholder="123456789..." value={tokenIdInput}
            onChange={e => setTokenIdInput(e.target.value)} />
        </Field>
      </section>

      <section style={cardStyle}>
        <h2 style={h2Style}>2. Execution params</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
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
          <Field label={side === 'BUY' ? 'Max price' : 'Min price'}>
            <input style={inputStyle} type="number" step="0.001" value={maxPrice}
              onChange={e => setMaxPrice(e.target.value)} placeholder="optional" />
          </Field>
          <Field label="Dry run">
            <label style={{ display: 'flex', alignItems: 'center', height: 32 }}>
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              <span style={{ marginLeft: 6 }}>simulate, no orders</span>
            </label>
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
                <th style={thStyle}>target</th>
                <th style={thStyle}>posted px</th>
                <th style={thStyle}>filled</th>
                <th style={thStyle}>avg px</th>
                <th style={thStyle}>reprice</th>
                <th style={thStyle}>order</th>
              </tr>
            </thead>
            <tbody>
              {job.slices.map(s => (
                <tr key={s.idx}>
                  <td style={tdStyle}>{s.idx}</td>
                  <td style={tdStyle}>{s.target_size.toFixed(2)}</td>
                  <td style={tdStyle}>{s.posted_price > 0 ? s.posted_price.toFixed(4) : '—'}</td>
                  <td style={tdStyle}>{s.filled_size.toFixed(2)}</td>
                  <td style={tdStyle}>{s.avg_fill_price > 0 ? s.avg_fill_price.toFixed(4) : '—'}</td>
                  <td style={tdStyle}>{s.repriced ? 'yes' : ''}</td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 11 }}>{s.order_id ? s.order_id.slice(0, 16) : ''}</td>
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
