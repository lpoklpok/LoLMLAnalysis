'use client'
import Link from 'next/link'

// TEMPORARILY DISABLED (2026-05-28) — Supabase egress was over the included
// allotment, and this page's realtime subscription + bulk queries against
// poly_market_balance / poly_recent_trades were the biggest contributors.
// Re-enable by reverting this stub or pulling from a worker-cached endpoint.
export default function FlowPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <Link href="/" className="text-sm text-gray-400 hover:text-gray-200">← Dashboard</Link>
      <div className="max-w-xl mt-8">
        <h1 className="text-2xl font-bold">Order Flow — disabled</h1>
        <p className="text-sm text-gray-400 mt-3">
          This page was temporarily disabled to reduce Supabase egress.
          Its realtime subscription and bulk queries against{' '}
          <code className="text-amber-300">poly_market_balance</code> /{' '}
          <code className="text-amber-300">poly_recent_trades</code> were the
          biggest drain. Re-enable by reverting <code>app/flow/page.tsx</code>.
        </p>
      </div>
    </div>
  )
}
