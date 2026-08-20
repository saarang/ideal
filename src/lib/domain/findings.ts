import { Db, dq, dq1 } from '../db';

export type FindingType =
  | 'DOCUMENT_CLASSIFICATION_UNCERTAIN' | 'FIELD_EXTRACTION_UNCERTAIN' | 'ITEM_MAPPING_REQUIRED'
  | 'SIZE_INTERPRETATION_REQUIRED' | 'ORDER_OVERDUE' | 'ORDER_QUANTITY_MISMATCH'
  | 'RECEIPT_QUANTITY_MISMATCH' | 'RECEIPT_SIZE_MISMATCH' | 'MISSING_INWARD_ENTRY'
  | 'INWARD_WITHOUT_SUPPORTING_DOCUMENT' | 'CHALLAN_AWAITING_INVOICE' | 'POSSIBLE_DUPLICATE_DOCUMENT'
  | 'BILL_CALCULATION_ERROR' | 'TAX_CALCULATION_ERROR' | 'OUTWARD_INVOICE_CALCULATION_ERROR'
  | 'NEGATIVE_STOCK' | 'UNEXPLAINED_STOCK_VARIANCE' | 'TRANSFER_MISMATCH'
  | 'POS_IMPORT_FAILURE' | 'LEDGER_POSTING_FAILURE' | 'INVOICE_WITHOUT_KNOWN_CHALLAN'
  | 'TOTAL_QTY_MISMATCH';

export type Severity = 'INFO' | 'WARNING' | 'HIGH' | 'CRITICAL';

export interface FindingInput {
  type: FindingType;
  severity: Severity;
  title: string;
  explanation?: string;
  supplierId?: string | null;
  customerId?: string | null;
  documentId?: string | null;
  relatedDocumentIds?: string[];
  itemId?: string | null;
  size?: string | null;
  expected?: string | null;
  actual?: string | null;
  difference?: string | null;
  recommendedAction?: string | null;
  dedupKey?: string | null;   // same key: finding is not raised again while open
}

export async function raiseFinding(db: Db, f: FindingInput): Promise<string | null> {
  const row = await dq1<{ id: string }>(db,
    `INSERT INTO findings (type, severity, title, explanation, supplier_id, customer_id, document_id,
       related_document_ids, item_id, size, expected_value, actual_value, difference, recommended_action, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status <> 'CANCELLED'
     DO NOTHING
     RETURNING id`,
    [f.type, f.severity, f.title, f.explanation ?? null, f.supplierId ?? null, f.customerId ?? null,
     f.documentId ?? null, f.relatedDocumentIds ?? null, f.itemId ?? null, f.size ?? null,
     f.expected ?? null, f.actual ?? null, f.difference ?? null, f.recommendedAction ?? null,
     f.dedupKey ?? null]);
  return row?.id ?? null;
}

export interface TaskInput {
  taskType: string;
  title: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  documentId?: string | null;
  documentLineId?: string | null;
  findingId?: string | null;
  payload?: unknown;
  dedupKey?: string | null;
}

export async function raiseTask(db: Db, t: TaskInput): Promise<string | null> {
  const row = await dq1<{ id: string }>(db,
    `INSERT INTO workflow_tasks (task_type, title, priority, document_id, document_line_id, finding_id, payload, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('OPEN','IN_PROGRESS')
     DO NOTHING
     RETURNING id`,
    [t.taskType, t.title, t.priority ?? 'NORMAL', t.documentId ?? null, t.documentLineId ?? null,
     t.findingId ?? null, t.payload ? JSON.stringify(t.payload) : null, t.dedupKey ?? null]);
  return row?.id ?? null;
}

export async function resolveFinding(db: Db, id: string, userId: string, status: 'RESOLVED'|'ACCEPTED'|'FALSE_POSITIVE'|'CANCELLED', resolution: string) {
  await dq(db,
    `UPDATE findings SET status=$2, resolution=$3, resolved_by=$4, resolved_at=now() WHERE id=$1`,
    [id, status, resolution, userId]);
}

export async function completeTask(db: Db, id: string, userId: string, detail?: string) {
  await dq(db, `UPDATE workflow_tasks SET status='DONE', completed_by=$2, completed_at=now() WHERE id=$1`, [id, userId]);
  await dq(db, `INSERT INTO task_events (task_id, actor_id, action, detail) VALUES ($1,$2,'COMPLETED',$3)`, [id, userId, detail ?? null]);
}
