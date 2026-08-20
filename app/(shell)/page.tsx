import Link from 'next/link';
import { q, q1 } from '@/src/lib/db';
import { DOC_TYPE_LABEL, DocLink, Empty, Stamp, StatusChip, fmtDate } from '../format';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const [findings, tasks, docs, stock, moves] = await Promise.all([
    q<{ id: string; severity: string; title: string; ref_no: string; document_id: string | null; doc_ref: string | null }>(
      `SELECT f.id, f.severity, f.title, f.ref_no, f.document_id, d.ref_no AS doc_ref
       FROM findings f LEFT JOIN documents d ON d.id = f.document_id
       WHERE f.status='OPEN'
       ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, f.created_at DESC
       LIMIT 8`),
    q<{ id: string; priority: string; title: string; ref_no: string; document_id: string | null }>(
      `SELECT id, priority, title, ref_no, document_id FROM workflow_tasks
       WHERE status IN ('OPEN','IN_PROGRESS')
       ORDER BY CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, created_at
       LIMIT 8`),
    q<{ id: string; ref_no: string; doc_type: string; status: string; supplier: string | null; customer: string | null; document_date: string | null; uploaded_at: string }>(
      `SELECT d.id, d.ref_no, d.doc_type, d.status, s.name AS supplier, c.name AS customer, d.document_date, d.uploaded_at
       FROM documents d LEFT JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN customers c ON c.id=d.customer_id
       ORDER BY d.uploaded_at DESC LIMIT 8`),
    q1<{ pieces: number; items: number; negatives: number }>(
      `SELECT COALESCE(SUM(qty),0)::int AS pieces,
              COUNT(DISTINCT item_id)::int AS items,
              (SELECT count(*) FROM (
                 SELECT 1 FROM inventory_movements GROUP BY item_id, size, location_id HAVING SUM(qty) < 0
               ) x)::int AS negatives
       FROM inventory_movements`),
    q1<{ today: number; week: number }>(
      `SELECT COALESCE(SUM(qty) FILTER (WHERE movement_type IN ('SUPPLIER_RECEIPT') AND business_date=CURRENT_DATE),0)::int AS today,
              COALESCE(ABS(SUM(qty) FILTER (WHERE movement_type IN ('POS_SALE','CUSTOMER_ISSUE') AND business_date > CURRENT_DATE-7)),0)::int AS week
       FROM inventory_movements`),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl">Today at the shop</h1>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          What needs a decision, then the numbers.
        </p>
      </header>

      <div className="grid sm:grid-cols-4 gap-3">
        {[
          { n: stock?.pieces ?? 0, l: 'pieces in stock' },
          { n: stock?.items ?? 0, l: 'items with stock' },
          { n: moves?.today ?? 0, l: 'pieces received today' },
          { n: moves?.week ?? 0, l: 'pieces out this week' },
        ].map((s) => (
          <div key={s.l} className="card card-pad">
            <div className="qty text-2xl font-semibold">{s.n.toLocaleString('en-IN')}</div>
            <div className="text-xs" style={{ color: 'var(--ink-soft)' }}>{s.l}</div>
          </div>
        ))}
      </div>
      {stock && stock.negatives > 0 && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--bad)' }}>
          <span className="font-medium">{stock.negatives} item-size(s) show negative stock.</span>{' '}
          <span className="text-sm">The book says more went out than came in — a receipt or opening balance is missing.
          See <Link href="/reports/low-stock" className="link">the low / negative stock report</Link>.</span>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card card-pad">
          <div className="section-title">Needs a decision</div>
          {findings.length === 0 ? <Empty>Nothing is waiting. All findings are closed.</Empty> : (
            <ul className="space-y-2.5">
              {findings.map((f) => (
                <li key={f.id} className="flex gap-2 items-start text-sm">
                  <Stamp level={f.severity} />
                  <span className="flex-1">
                    {f.title}{' '}
                    {f.document_id && f.doc_ref && <DocLink id={f.document_id} refNo={f.doc_ref} />}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/findings" className="link text-sm inline-block mt-3">All findings →</Link>
        </section>

        <section className="card card-pad">
          <div className="section-title">Open tasks</div>
          {tasks.length === 0 ? <Empty>No open tasks.</Empty> : (
            <ul className="space-y-2.5">
              {tasks.map((t) => (
                <li key={t.id} className="flex gap-2 items-start text-sm">
                  <Stamp level={t.priority} />
                  <span className="flex-1">
                    {t.document_id ? <Link href={`/documents/${t.document_id}`} className="hover:underline">{t.title}</Link> : t.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/tasks" className="link text-sm inline-block mt-3">All tasks →</Link>
        </section>
      </div>

      <section className="card">
        <div className="card-pad pb-0 flex items-center justify-between">
          <div className="section-title mb-0">Latest documents</div>
          <Link href="/documents" className="link text-sm">All documents →</Link>
        </div>
        <div className="overflow-x-auto p-2">
          <table className="tbl">
            <thead><tr><th>Ref</th><th>Type</th><th>Party</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><DocLink id={d.id} refNo={d.ref_no} /></td>
                  <td>{DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}</td>
                  <td>{d.supplier ?? d.customer ?? '—'}</td>
                  <td>{fmtDate(d.document_date)}</td>
                  <td><StatusChip status={d.status} /></td>
                </tr>
              ))}
              {docs.length === 0 && <tr><td colSpan={5}><Empty>No documents yet. Send a photo on Telegram or run the demo seed.</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
