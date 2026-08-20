import Link from 'next/link';
import { q } from '@/src/lib/db';
import { resolveCaseAction, rebuildReconAction } from '@/app/actions';
import { ActionForm } from '@/app/ui';
import { DOC_TYPE_LABEL, DocLink, Empty, StatusChip, fmtDateTime } from '../../format';

export const dynamic = 'force-dynamic';

interface CaseRow {
  id: string; case_type: string; status: string; supplier: string | null;
  created_at: string; resolved_at: string | null;
}
interface CaseDoc {
  case_id: string; role: string; document_id: string; ref_no: string; doc_type: string;
  status: string; total_qty: number | null;
}
interface MismatchRow { id: string; dedup_key: string; title: string; explanation: string | null }

const CASE_LABEL: Record<string, string> = {
  RECEIPT_GROUP: 'Goods received — papers compared',
  CHALLAN_INVOICE: 'Challan waiting for invoice',
  ORDER_DELIVERY: 'Order vs delivery',
};

export default async function ReconPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { f = 'open' } = await searchParams;
  const open = f !== 'closed';

  const [cases, caseDocs, mismatches] = await Promise.all([
    q<CaseRow>(
      `SELECT rc.id, rc.case_type, rc.status, s.name AS supplier, rc.created_at, rc.resolved_at
       FROM reconciliation_cases rc
       LEFT JOIN suppliers s ON s.id = rc.supplier_id
       WHERE ${open ? `rc.status <> 'RESOLVED'` : `rc.status = 'RESOLVED'`}
       ORDER BY rc.created_at DESC LIMIT 100`),
    q<CaseDoc>(
      `SELECT cd.case_id, cd.role, cd.document_id, d.ref_no, d.doc_type, d.status,
              d.calculated_total_qty AS total_qty
       FROM reconciliation_case_documents cd
       JOIN documents d ON d.id = cd.document_id
       ORDER BY cd.case_id, cd.role`),
    q<MismatchRow>(
      `SELECT id, dedup_key, title, explanation FROM findings
       WHERE status IN ('OPEN','IN_REVIEW') AND dedup_key LIKE 'recq:%'
       ORDER BY created_at`),
  ]);
  const docsByCase = new Map<string, CaseDoc[]>();
  for (const cd of caseDocs) {
    const arr = docsByCase.get(cd.case_id) ?? [];
    arr.push(cd); docsByCase.set(cd.case_id, arr);
  }
  const mismatchByCase = new Map<string, MismatchRow[]>();
  for (const m of mismatches) {
    const caseId = m.dedup_key.split(':')[1];
    const arr = mismatchByCase.get(caseId) ?? [];
    arr.push(m); mismatchByCase.set(caseId, arr);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Reconciliation</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            The same goods often appear on three papers — the supplier’s challan, the aavak register, and later the bill.
            Here they are compared line by line, and stock is counted only once.
          </p>
        </div>
        <nav className="flex gap-1" aria-label="Filter">
          <Link href="/recon" className={`btn ${open ? 'btn-primary' : 'btn-secondary'}`}>Open</Link>
          <Link href="/recon?f=closed" className={`btn ${!open ? 'btn-primary' : 'btn-secondary'}`}>Closed</Link>
        </nav>
      </header>

      {cases.length === 0 && (
        <div className="card card-pad"><Empty>{open ? 'No open cases — every receipt group agrees.' : 'Nothing closed yet.'}</Empty></div>
      )}

      <div className="space-y-3">
        {cases.map((c) => {
          const docs = docsByCase.get(c.id) ?? [];
          const firstDoc = docs[0]?.document_id;
          return (
            <div key={c.id} className="card card-pad">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <strong className="text-sm">{CASE_LABEL[c.case_type] ?? c.case_type}</strong>
                  {c.supplier && <span className="text-sm" style={{ color: 'var(--ink-soft)' }}>{c.supplier}</span>}
                  <StatusChip status={c.status} />
                </div>
                <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>{fmtDateTime(c.created_at)}</span>
              </div>

              {docs.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Role</th><th>Paper</th><th>Type</th><th className="num">Confirmed pcs</th><th>Status</th></tr></thead>
                    <tbody>
                      {docs.map((d) => (
                        <tr key={d.document_id}>
                          <td className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-soft)' }}>{d.role.replaceAll('_', ' ').toLowerCase()}</td>
                          <td><DocLink id={d.document_id} refNo={d.ref_no} /></td>
                          <td className="text-sm">{DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}</td>
                          <td className="qty">{d.total_qty ?? '—'}</td>
                          <td><StatusChip status={d.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(mismatchByCase.get(c.id) ?? []).length > 0 && (
                <ul className="mt-2 space-y-1">
                  {(mismatchByCase.get(c.id) ?? []).map((m) => (
                    <li key={m.id} className="text-sm" style={{ color: 'var(--warn)' }}>{m.title}</li>
                  ))}
                </ul>
              )}

              {open && (
                <div className="mt-3 flex gap-2 flex-wrap">
                  {firstDoc && (
                    <ActionForm action={rebuildReconAction} className="inline">
                      <input type="hidden" name="documentId" value={firstDoc} />
                      <button className="btn btn-secondary" type="submit">Compare again</button>
                    </ActionForm>
                  )}
                  <ActionForm action={resolveCaseAction} className="inline"
                              confirm="Close this case? Do this once the difference has been checked against the papers.">
                    <input type="hidden" name="caseId" value={c.id} />
                    <button className="btn btn-primary" type="submit">Mark checked &amp; close</button>
                  </ActionForm>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
