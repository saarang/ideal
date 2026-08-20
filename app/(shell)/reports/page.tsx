import Link from 'next/link';
import { REPORTS } from '@/src/lib/reports';

export const dynamic = 'force-dynamic';

export default function ReportsPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl">Reports</h1>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          Each report can be read on screen or downloaded as CSV for Excel.
        </p>
      </header>
      <div className="grid sm:grid-cols-2 gap-3">
        {REPORTS.map((r) => (
          <Link key={r.key} href={`/reports/${r.key}`} className="card card-pad block hover:shadow-sm">
            <strong className="text-sm">{r.title}</strong>
            <p className="text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>{r.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
