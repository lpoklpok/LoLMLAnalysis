'use client'
import Link from 'next/link'

// TEMPORARILY DISABLED (2026-05-28) to reduce Supabase egress.
// This dashboard polled mm_config + mm_state + mm_quotes_log every 15s.
// The systematic MM worker still runs on Fly — only the read-only dashboard is gated.
// Re-enable by reverting this stub.
export default function MmPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Dashboard</Link>
      <div className="max-w-xl mt-8">
        <h1 className="text-2xl font-bold">MM Dashboard — disabled</h1>
        <p className="text-sm text-gray-400 mt-3">
          Temporarily disabled to reduce Supabase egress. Polled
          {' '}<code className="text-amber-300">mm_config</code> and{' '}
          <code className="text-amber-300">mm_state</code> every 15s.
        </p>
        <p className="text-sm text-gray-400 mt-2">
          The MM worker itself is still running on Fly — this dashboard was just
          read-only. Use <Link href="/systematic" className="text-blue-400 underline">/systematic</Link> for the auto-rules controls (lower egress: 30s poll).
        </p>
        <p className="text-sm text-gray-500 mt-2">
          Re-enable by reverting <code>app/mm/page.tsx</code>.
        </p>
      </div>
    </div>
  )
}
