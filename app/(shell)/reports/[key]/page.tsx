import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getReport } from '@/src/lib/reports';
import { Empty } from '../../../format';

export const dynamic = 'force-dynamic';

const DATED = new Set(['movement-register', 'receipts-by-supplier', 'pos-sales-summary', 'customer-issues']);

export default async function ReportPage(props: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { key } = await props.params;
  const sp = await props.searchParams;
  const def = getReport(key);
  if (!def) notFound();

  const result = await def.run(sp);
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v)).toString();

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs" style={{ color: 'var(--ink-soft)' }}><Link href="/reports" className="link">Reports</Link></p>
          <h1 className="text-2xl">{def.title}</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>{def.description}</p>
        </div>
        <a className="btn btn-secondary" href={`/api/reports/${def.key}/csv${qs ? `?${qs}` : ''}`}>Download CSV</a>
      </header>

      {DATED.has(def.key) && (
        <form method="GET" className="card card-pad flex flex-wrap items-end gap-2">
          <div>
            <label className="lbl">From</label>
            <input type="date" name="from" defaultValue={sp.from ?? ''} className="input !w-40" />
          </div>
          <div>
            <label className="lbl">To</label>
            <input type="date" name="to" defaultValue={sp.to ?? ''} className="input !w-40" />
          </div>
          <button className="btn btn-primary" type="submit">Apply</button>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>{result.headers.map((h) => <th key={h} className={/qty|pieces|pcs|total|shop|godown|days|amount|rows|documents/i.test(h) ? 'num' : undefined}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className={typeof cell === 'number' ? 'qty' : undefined}
                      style={typeof cell === 'number' && cell < 0 ? { color: 'var(--bad)' } : undefined}>
                    {cell ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
            {result.rows.length === 0 && <tr><td colSpan={result.headers.length}><Empty>Nothing to report for this selection.</Empty></td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs" style={{ color: 'var(--ink-soft)' }}>{result.rows.length} row(s).</p>
    </div>
  );
}
