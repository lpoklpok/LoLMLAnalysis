'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function LoginForm() {
  const router = useRouter()
  const sp = useSearchParams()
  const next = sp.get('next') || '/'
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!r.ok) {
        setErr(r.status === 401 ? 'Wrong password.' : `Login failed (${r.status})`)
        setBusy(false)
        return
      }
      router.replace(next)
    } catch (e) {
      setErr(`Network error: ${String(e)}`)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-3">
      <input
        type="password"
        autoFocus
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Password"
        className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-zinc-100 focus:outline-none focus:border-blue-500"
      />
      {err && <div className="text-sm text-rose-400">{err}</div>}
      <button
        type="submit"
        disabled={busy || !password}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-medium rounded px-3 py-2 transition"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="text-center space-y-6">
        <h1 className="text-2xl font-semibold text-zinc-100">LoL Esports Analytics</h1>
        <Suspense fallback={<div className="text-zinc-500">Loading…</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
