import Link from 'next/link';
import { q } from '@/src/lib/db';
import { DOC_TYPE_LABEL, DocLink, Empty, StatusChip, fmtDate, fmtDateTime } from '../../format';

export const dynamic = 'force-dynamic';

const FILTERS: { key: string; label: string; where: string }[] = [
  { key: 'attention', label: 'Needs attention', where: `status IN ('NEEDS_REVIEW','FAILED')` },
  { key: 'ready', label: 'Ready to post', where: `status = 'READY_TO_POST'` },
  { key: 'posted', label: 'Posted', where: `status IN ('POSTED','LINKED_NO_POSTING')` },
  { key: 'all', label: 'All', where: `TRUE` },
];

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ f?: string; type?: string }> }) {
  const sp = await searchParams;
  const filter = FILTERS.find((x) => x.key === (sp.f ?? 'attention')) ?? FILTERS[0];
  const typeFilter = sp.type && DOC_TYPE_LABEL[sp.type] ? sp.type : null;

  const docs = await q<{
    id: string; ref_no: string; doc_type: string; status: string; document_date: string | null;
    uploaded_at: string; supplier: string | null; customer: string | null;
    telegram_uploader: string | null; source: string; total_qty: number | null; open_tasks: number;
  }>(
    `SELECT d.id, d.ref_no, d.doc_type, d.status, d.document_date, d.uploaded_at,
            s.name AS supplier, c.name AS customer, d.telegram_uploader, d.source,
            d.calculated_total_qty AS total_qty,
            (SELECT count(*) FROM workflow_tasks t WHERE t.document_id=d.id AND t.status IN ('OPEN','IN_PROGRESS'))::int AS open_tasks
     FROM documents d
     LEFT JOIN suppliers s ON s.id = d.supplier_id
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE ${filter.where} ${typeFilter ? 'AND d.doc_type = $1' : ''}
     ORDER BY d.uploaded_at DESC LIMIT 200`,
    typeFilter ? [typeFilter] : []);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Documents</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            Every photo sent on Telegram or uploaded lands here.
          </p>
        </div>
        <nav className="flex gap-1 flex-wrap" aria-label="Filter">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/documents?f=${f.key}`}
                  className={`btn ${f.key === filter.key ? 'btn-primary' : 'btn-secondary'}`}>{f.label}</Link>
          ))}
        </nav>
      </header>

      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr><th>Ref</th><th>Type</th><th>Party</th><th>Doc date</th><th className="num">Qty</th><th>Received</th><th>Status</th></tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  <DocLink id={d.id} refNo={d.ref_no} />
                  {d.open_tasks > 0 && <span className="ml-1.5 nav-count" title="open tasks">{d.open_tasks}</span>}
                </td>
                <td>{DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}</td>
                <td>{d.supplier ?? d.customer ?? '—'}</td>
                <td>{fmtDate(d.document_date)}</td>
                <td className="qty">{d.total_qty ?? '—'}</td>
                <td className="text-xs" style={{ color: 'var(--ink-soft)' }}>
                  {fmtDateTime(d.uploaded_at)}{d.telegram_uploader ? ` · ${d.telegram_uploader}` : ''}
                </td>
                <td><StatusChip status={d.status} /></td>
              </tr>
            ))}
            {docs.length === 0 && (
              <tr><td colSpan={7}>
                <Empty>
                  {filter.key === 'attention'
                    ? 'Nothing needs attention right now.'
                    : 'No documents match this filter yet.'}
                </Empty>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
