import Link from 'next/link';
import { q } from '@/src/lib/db';
import { resolveFindingAction } from '@/app/actions';
import { ActionForm, Reveal } from '@/app/ui';
import { Stamp, fmtDateTime, Empty } from '../../format';

export const dynamic = 'force-dynamic';

interface FindingRow {
  id: string; ref_no: string; type: string; severity: string; status: string;
  title: string; explanation: string | null; expected_value: string | null; actual_value: string | null; recommended_action: string | null; created_at: string;
  document_id: string | null; doc_ref: string | null;
  item_id: string | null; item_name: string | null;
  supplier_name: string | null;
  resolved_at: string | null; resolution: string | null; resolved_by_name: string | null;
}

export default async function FindingsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { f = 'open' } = await searchParams;
  const open = f !== 'closed';
  const rows = await q<FindingRow>(
    `SELECT fi.id, fi.ref_no, fi.type, fi.severity, fi.status, fi.title, fi.explanation, fi.expected_value, fi.actual_value, fi.recommended_action, fi.created_at,
            fi.document_id, d.ref_no AS doc_ref, fi.item_id, i.name AS item_name, s.name AS supplier_name,
            fi.resolved_at, fi.resolution, u.name AS resolved_by_name
     FROM findings fi
     LEFT JOIN documents d ON d.id = fi.document_id
     LEFT JOIN items i ON i.id = fi.item_id
     LEFT JOIN suppliers s ON s.id = fi.supplier_id
     LEFT JOIN users u ON u.id = fi.resolved_by
     WHERE ${open ? `fi.status IN ('OPEN','IN_REVIEW')` : `fi.status NOT IN ('OPEN','IN_REVIEW')`}
     ORDER BY ${open
       ? `CASE fi.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, fi.created_at DESC`
       : `fi.resolved_at DESC NULLS LAST`}
     LIMIT 300`);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Findings</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            Things the system noticed and wrote down — mismatches, missing papers, arithmetic that does not agree.
            Nothing here changes stock by itself.
          </p>
        </div>
        <nav className="flex gap-1" aria-label="Filter">
          <Link href="/findings" className={`btn ${open ? 'btn-primary' : 'btn-secondary'}`}>Open</Link>
          <Link href="/findings?f=closed" className={`btn ${!open ? 'btn-primary' : 'btn-secondary'}`}>Closed</Link>
        </nav>
      </header>

      {rows.length === 0 && (
        <div className="card card-pad"><Empty>{open ? 'No open findings. The register is clean.' : 'Nothing closed yet.'}</Empty></div>
      )}

      <div className="space-y-3">
        {rows.map((fi) => (
          <div key={fi.id} className="card card-pad">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Stamp level={fi.severity} />
                  <span className="qty text-xs" style={{ color: 'var(--ink-soft)' }}>{fi.ref_no}</span>
                  <strong className="text-sm">{fi.title}</strong>
                </div>
                {fi.explanation && <p className="text-sm mt-1.5 whitespace-pre-line">{fi.explanation}</p>}
                {(fi.expected_value || fi.actual_value) && (
                  <p className="text-sm mt-1">
                    {fi.expected_value && <>Expected <span className="qty">{fi.expected_value}</span></>}
                    {fi.expected_value && fi.actual_value && ' · '}
                    {fi.actual_value && <>found <span className="qty">{fi.actual_value}</span></>}
                  </p>
                )}
                {fi.recommended_action && (
                  <p className="text-xs mt-1" style={{ color: 'var(--khaki)' }}>Suggested: {fi.recommended_action}</p>
                )}
                <p className="text-xs mt-1.5" style={{ color: 'var(--ink-soft)' }}>
                  {fmtDateTime(fi.created_at)} · {fi.type.replaceAll('_', ' ').toLowerCase()}
                  {fi.document_id && fi.doc_ref && <> · paper <Link className="link" href={`/documents/${fi.document_id}`}>{fi.doc_ref}</Link></>}
                  {fi.item_id && fi.item_name && <> · item <Link className="link" href={`/items/${fi.item_id}`}>{fi.item_name}</Link></>}
                  {fi.supplier_name && <> · {fi.supplier_name}</>}
                </p>
                {!open && (
                  <p className="text-xs mt-1.5">
                    <span className="chip">{fi.status.replaceAll('_', ' ')}</span>{' '}
                    {fi.resolution && <span style={{ color: 'var(--ink-soft)' }}>{fi.resolution}</span>}
                    {fi.resolved_by_name && <span style={{ color: 'var(--ink-soft)' }}> — {fi.resolved_by_name}, {fmtDateTime(fi.resolved_at)}</span>}
                  </p>
                )}
              </div>
              {open && (
                <Reveal label="Close this finding" className="w-full sm:w-80">
                  <ActionForm action={resolveFindingAction} className="space-y-2">
                    <input type="hidden" name="findingId" value={fi.id} />
                    <div>
                      <label className="lbl">How is it being closed?</label>
                      <select name="status" className="input" defaultValue="RESOLVED">
                        <option value="RESOLVED">Fixed — the underlying problem was corrected</option>
                        <option value="ACCEPTED">Accepted — it is correct as it is, no change needed</option>
                        <option value="FALSE_POSITIVE">False alarm — the system misread the situation</option>
                      </select>
                    </div>
                    <div>
                      <label className="lbl">What was decided (written note)</label>
                      <textarea name="resolution" className="input" rows={2} placeholder="e.g. Supplier confirmed only 8 pcs sent; challan corrected." />
                    </div>
                    <button className="btn btn-primary" type="submit">Close finding</button>
                  </ActionForm>
                </Reveal>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
