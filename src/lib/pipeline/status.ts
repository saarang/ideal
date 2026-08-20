/**
 * STATUS stage — after every pipeline pass or correction, decide whether the
 * document can be posted or still needs human eyes. Terminal states
 * (POSTED / DUPLICATE / LINKED_NO_POSTING / ARCHIVED / FAILED) are preserved.
 */
import { getPool, dq, dq1 } from '../db';

const STOCK_DOC_TYPES = [
  'SUPPLIER_DELIVERY_CHALLAN', 'SUPPLIER_INVOICE', 'INWARD_BOOK',
  'IDEAL_CUSTOMER_DELIVERY_CHALLAN', 'SHOP_TO_GODOWN_TRANSFER', 'GODOWN_TO_SHOP_TRANSFER',
];

export interface StatusResult {
  status: string;
  blockers: string[];
}

/** A line counts as postable when it is fully resolved. */
const POSTABLE_LINE_SQL = `
  item_id IS NOT NULL
  AND quantity IS NOT NULL AND quantity > 0
  AND size_normalized IS NOT NULL
  AND review_status <> 'NEEDS_REVIEW'
  AND mapping_status IN ('USER_CONFIRMED','AI_SUGGESTED','NOT_REQUIRED')`;

export async function refreshDocumentStatus(documentId: string): Promise<StatusResult> {
  const pool = getPool();
  const doc = await dq1<{
    id: string; doc_type: string; status: string; supplier_id: string | null;
    customer_id: string | null; document_date: string | null;
    receipt_location_id: string | null; dispatch_location_id: string | null;
    destination_location_id: string | null;
  }>(pool,
    `SELECT id, doc_type, status, supplier_id, customer_id, document_date,
            receipt_location_id, dispatch_location_id, destination_location_id
     FROM documents WHERE id=$1`, [documentId]);
  if (!doc) throw new Error(`Document ${documentId} not found`);

  if (['POSTED', 'DUPLICATE', 'LINKED_NO_POSTING', 'ARCHIVED', 'FAILED'].includes(doc.status)) {
    return { status: doc.status, blockers: [] };
  }

  const blockers: string[] = [];

  if (doc.doc_type === 'UNKNOWN') blockers.push('Document type has not been confirmed.');
  if (!doc.document_date) blockers.push('Document date is missing.');

  const isReceipt = ['SUPPLIER_DELIVERY_CHALLAN', 'SUPPLIER_INVOICE', 'INWARD_BOOK'].includes(doc.doc_type);
  if (isReceipt && !doc.supplier_id) blockers.push('Supplier is not identified.');
  if (isReceipt && !doc.receipt_location_id) blockers.push('Receiving location is missing.');
  if (doc.doc_type === 'IDEAL_CUSTOMER_DELIVERY_CHALLAN') {
    if (!doc.customer_id) blockers.push('Customer is not identified.');
    if (!doc.dispatch_location_id) blockers.push('Dispatch location is missing.');
  }
  if (doc.doc_type === 'SHOP_TO_GODOWN_TRANSFER' || doc.doc_type === 'GODOWN_TO_SHOP_TRANSFER') {
    if (!doc.dispatch_location_id || !doc.destination_location_id) blockers.push('Transfer locations are missing.');
  }

  if (STOCK_DOC_TYPES.includes(doc.doc_type)) {
    const counts = await dq1<{ total: number; postable: number; needs_review: number; unmapped: number }>(pool,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${POSTABLE_LINE_SQL})::int AS postable,
              count(*) FILTER (WHERE review_status='NEEDS_REVIEW')::int AS needs_review,
              count(*) FILTER (WHERE mapping_status IN ('UNMAPPED','REJECTED') AND COALESCE(quantity,0) > 0)::int AS unmapped
       FROM document_lines WHERE document_id=$1`, [documentId]);
    const c = counts!;
    if (c.total === 0) blockers.push('No line items were extracted.');
    if (c.needs_review > 0) {
      // Say WHICH lines and why, rather than a generic "needs review" —
      // the open task on each line already carries the exact reason.
      const why = await dq<{ title: string }>(pool,
        `SELECT t.title FROM workflow_tasks t
         JOIN document_lines dl ON dl.id = t.document_line_id
         WHERE dl.document_id=$1 AND t.status IN ('OPEN','IN_PROGRESS')
         ORDER BY dl.line_no, dl.sub_no LIMIT 3`, [documentId]);
      blockers.push(why.length
        ? `${c.needs_review} line(s) need review — ${why.map((w) => w.title).join('; ')}${c.needs_review > why.length ? '; …' : ''}`
        : `${c.needs_review} line(s) need review.`);
    }
    if (c.unmapped > 0) blockers.push(`${c.unmapped} line(s) are not mapped to items.`);
    if (c.total > 0 && c.postable === 0 && c.needs_review === 0 && c.unmapped === 0) {
      blockers.push('No postable lines (check quantities and sizes).');
    }
  } else if (doc.doc_type === 'ORDER_BOOK') {
    const c = await dq1<{ needs_review: number }>(pool,
      `SELECT count(*) FILTER (WHERE review_status='NEEDS_REVIEW')::int AS needs_review
       FROM document_lines WHERE document_id=$1`, [documentId]);
    if ((c?.needs_review ?? 0) > 0) blockers.push(`${c!.needs_review} order line(s) need review.`);
  }

  // Open blocking tasks tied to the document header also hold it back.
  const openTasks = await dq1<{ n: number }>(pool,
    `SELECT count(*)::int AS n FROM workflow_tasks
     WHERE document_id=$1 AND status IN ('OPEN','IN_PROGRESS')
       AND task_type IN ('CONFIRM_DOCUMENT_TYPE','CORRECT_HEADER')`, [documentId]);
  if ((openTasks?.n ?? 0) > 0) blockers.push('Open header task(s) must be completed first.');

  const status = blockers.length === 0 ? 'READY_TO_POST' : 'NEEDS_REVIEW';
  await dq(pool,
    `UPDATE documents SET status=$1,
       review_status = CASE WHEN $1='READY_TO_POST' THEN 'REVIEWED' ELSE 'PENDING' END
     WHERE id=$2 AND status NOT IN ('POSTED','DUPLICATE','LINKED_NO_POSTING','ARCHIVED','FAILED')`,
    [status, documentId]);
  return { status, blockers };
}
