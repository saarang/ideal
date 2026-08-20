import Link from 'next/link';
import { q } from '@/src/lib/db';
import { completeTaskAction } from '@/app/actions';
import { ActionForm } from '@/app/ui';
import { Stamp, fmtDateTime, Empty } from '../../format';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string; ref_no: string; task_type: string; priority: string; status: string;
  title: string; document_id: string | null; doc_ref: string | null;
  created_at: string; completed_at: string | null; completed_by_name: string | null;
}

const TYPE_HINT: Record<string, string> = {
  CONFIRM_DOCUMENT_TYPE: 'Open the paper and confirm what kind of document it is.',
  CORRECT_HEADER: 'Fill in the missing header details (party, number or date).',
  MAP_ITEM: 'Tell the system which stock item this wording belongs to.',
  SIZE_INTERPRETATION: 'The size/quantity notation was unclear — set the correct sizes and counts.',
  VERIFY_LINE: 'The photo was hard to read — check this line against the paper.',
  VERIFY_TOTAL: 'The totals do not add up — check the arithmetic on the paper.',
  RESOLVE_DUPLICATE: 'This looks like a paper that was already sent — keep one, mark the other.',
  REVIEW_RECONCILIATION: 'Quantities across challan / inward book / invoice do not agree.',
};

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { f = 'open' } = await searchParams;
  const open = f !== 'done';
  const tasks = await q<TaskRow>(
    `SELECT t.id, t.ref_no, t.task_type, t.priority, t.status, t.title,
            t.document_id, d.ref_no AS doc_ref, t.created_at, t.completed_at, u.name AS completed_by_name
     FROM workflow_tasks t
     LEFT JOIN documents d ON d.id = t.document_id
     LEFT JOIN users u ON u.id = t.completed_by
     WHERE ${open ? `t.status IN ('OPEN','IN_PROGRESS')` : `t.status IN ('DONE','CANCELLED')`}
     ORDER BY ${open
       ? `CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, t.created_at`
       : `t.completed_at DESC NULLS LAST`}
     LIMIT 200`);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Tasks</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            Small jobs that need a person — one decision each. Most are finished on the paper itself.
          </p>
        </div>
        <nav className="flex gap-1" aria-label="Filter">
          <Link href="/tasks" className={`btn ${open ? 'btn-primary' : 'btn-secondary'}`}>To do</Link>
          <Link href="/tasks?f=done" className={`btn ${!open ? 'btn-primary' : 'btn-secondary'}`}>Finished</Link>
        </nav>
      </header>

      {tasks.length === 0 && (
        <div className="card card-pad"><Empty>{open ? 'Nothing waiting. All caught up.' : 'Nothing finished yet.'}</Empty></div>
      )}

      <div className="space-y-3">
        {tasks.map((t) => (
          <div key={t.id} className="card card-pad flex flex-wrap gap-3 items-start justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Stamp level={t.priority} />
                <span className="qty text-xs" style={{ color: 'var(--ink-soft)' }}>{t.ref_no}</span>
                <strong className="text-sm">{t.title}</strong>
              </div>
              {open && TYPE_HINT[t.task_type] && (
                <p className="text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>{TYPE_HINT[t.task_type]}</p>
              )}
              <p className="text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>
                Raised {fmtDateTime(t.created_at)}
                {t.document_id && t.doc_ref && <> · paper <Link className="link" href={`/documents/${t.document_id}`}>{t.doc_ref}</Link></>}
                {!open && t.completed_at && <> · done {fmtDateTime(t.completed_at)}{t.completed_by_name ? ` by ${t.completed_by_name}` : ''}</>}
              </p>
            </div>
            {open && (
              <div className="flex items-center gap-2 flex-wrap">
                {t.document_id && (
                  <Link className="btn btn-secondary" href={`/documents/${t.document_id}`}>Open paper</Link>
                )}
                <ActionForm action={completeTaskAction} resetOnSuccess className="flex items-center gap-2">
                  <input type="hidden" name="taskId" value={t.id} />
                  <input className="input !w-44" name="detail" placeholder="Note (optional)" />
                  <button className="btn btn-primary" type="submit">Mark done</button>
                </ActionForm>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
