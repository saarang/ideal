/**
 * Reconciliation.
 *
 * One physical delivery can appear as up to three papers: the supplier's
 * challan, the shop's inward-book entry, and later the invoice. These are
 * grouped into a RECEIPT_GROUP case (same supplier, dates within the
 * configured window, or explicit challan/invoice references). The group is
 * what prevents double counting: only the first-posted member moves stock,
 * and quantity differences between members become findings, not silent noise.
 */
import { PoolClient } from 'pg';
import { getPool, dq, dq1, Db } from '../db';
import { getSettings } from '../settings';
import { raiseFinding, raiseTask } from '../domain/findings';
import { fmtDate } from '../format';

export const RECEIPT_ROLES: Record<string, string> = {
  SUPPLIER_DELIVERY_CHALLAN: 'CHALLAN',
  INWARD_BOOK: 'INWARD',
  SUPPLIER_INVOICE: 'INVOICE',
};

/** Documents that plausibly describe the same physical receipt. */
export async function findReceiptGroupDocs(db: Db, documentId: string): Promise<string[]> {
  const doc = await dq1<{
    id: string; doc_type: string; supplier_id: string | null; document_date: string | null;
    document_number: string | null; challan_ref: string | null; invoice_ref: string | null;
  }>(db,
    `SELECT id, doc_type, supplier_id, document_date, document_number, challan_ref, invoice_ref
     FROM documents WHERE id=$1`, [documentId]);
  if (!doc || !RECEIPT_ROLES[doc.doc_type] || !doc.supplier_id) return [documentId];

  const settings = await getSettings(db);
  const windowDays = settings.recon_date_window_days ?? 7;

  const related = await dq<{ id: string }>(db,
    `SELECT d.id FROM documents d
     WHERE d.supplier_id = $1
       AND d.id <> $2
       AND d.doc_type IN ('SUPPLIER_DELIVERY_CHALLAN','INWARD_BOOK','SUPPLIER_INVOICE')
       AND d.status NOT IN ('DUPLICATE','ARCHIVED','FAILED')
       AND (
         ($3::date IS NOT NULL AND d.document_date IS NOT NULL
          AND abs(d.document_date - $3::date) <= $4)
         OR ($5::text IS NOT NULL AND (d.document_number = $5 OR d.challan_ref = $5))
         OR (d.document_number IS NOT NULL AND d.document_number IN ($6, $7))
       )`,
    [doc.supplier_id, doc.id, doc.document_date, windowDays,
     doc.document_number, doc.challan_ref ?? '', doc.invoice_ref ?? '']);
  return [documentId, ...related.map((r) => r.id)];
}

/** Get or create the RECEIPT_GROUP case covering these documents. */
async function upsertReceiptCase(db: Db, supplierId: string, docIds: string[]): Promise<string> {
  const existing = await dq1<{ case_id: string }>(db,
    `SELECT rcd.case_id FROM reconciliation_case_documents rcd
     JOIN reconciliation_cases rc ON rc.id = rcd.case_id
     WHERE rc.case_type='RECEIPT_GROUP' AND rc.status <> 'RESOLVED'
       AND rcd.document_id = ANY($1::uuid[])
     LIMIT 1`, [docIds]);
  let caseId = existing?.case_id;
  if (!caseId) {
    const created = await dq1<{ id: string }>(db,
      `INSERT INTO reconciliation_cases (case_type, supplier_id) VALUES ('RECEIPT_GROUP', $1) RETURNING id`,
      [supplierId]);
    caseId = created!.id;
  }
  for (const id of docIds) {
    const role = await dq1<{ doc_type: string }>(db, `SELECT doc_type FROM documents WHERE id=$1`, [id]);
    await dq(db,
      `INSERT INTO reconciliation_case_documents (case_id, document_id, role)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [caseId, id, RECEIPT_ROLES[role?.doc_type ?? ''] ?? 'OTHER']);
  }
  return caseId;
}

interface QtyByKey { [itemSize: string]: number }

async function quantitiesByRole(db: Db, caseId: string): Promise<Record<string, { docIds: string[]; qty: QtyByKey }>> {
  const rows = await dq<{ role: string; document_id: string; item_id: string | null; size: string | null; qty: number }>(db,
    `SELECT rcd.role, rcd.document_id, dl.item_id, dl.size_normalized AS size,
            COALESCE(SUM(dl.quantity),0)::int AS qty
     FROM reconciliation_case_documents rcd
     JOIN documents d ON d.id = rcd.document_id AND d.status NOT IN ('DUPLICATE','ARCHIVED','FAILED')
     LEFT JOIN document_lines dl ON dl.document_id = rcd.document_id
       AND dl.item_id IS NOT NULL AND dl.size_normalized IS NOT NULL AND COALESCE(dl.quantity,0) > 0
     WHERE rcd.case_id = $1
     GROUP BY rcd.role, rcd.document_id, dl.item_id, dl.size_normalized`, [caseId]);
  const out: Record<string, { docIds: string[]; qty: QtyByKey }> = {};
  for (const r of rows) {
    const bucket = (out[r.role] ??= { docIds: [], qty: {} });
    if (!bucket.docIds.includes(r.document_id)) bucket.docIds.push(r.document_id);
    if (r.item_id && r.size) {
      const key = `${r.item_id}|${r.size}`;
      bucket.qty[key] = (bucket.qty[key] ?? 0) + r.qty;
    }
  }
  return out;
}

/**
 * Compare the members of a receipt group pairwise per item+size and raise
 * findings for differences. Returns the case id.
 */
export async function reconcileReceiptGroup(documentId: string): Promise<string | null> {
  const pool = getPool();
  const doc = await dq1<{ doc_type: string; supplier_id: string | null }>(pool,
    `SELECT doc_type, supplier_id FROM documents WHERE id=$1`, [documentId]);
  if (!doc || !RECEIPT_ROLES[doc.doc_type] || !doc.supplier_id) return null;

  const docIds = await findReceiptGroupDocs(pool, documentId);
  const caseId = await upsertReceiptCase(pool, doc.supplier_id, docIds);
  const byRole = await quantitiesByRole(pool, caseId);

  const pairs: [string, string, 'RECEIPT_QUANTITY_MISMATCH' | 'RECEIPT_QUANTITY_MISMATCH'][] = [
    ['CHALLAN', 'INWARD', 'RECEIPT_QUANTITY_MISMATCH'],
    ['CHALLAN', 'INVOICE', 'RECEIPT_QUANTITY_MISMATCH'],
    ['INWARD', 'INVOICE', 'RECEIPT_QUANTITY_MISMATCH'],
  ];

  let anyMismatch = false;
  const supplier = await dq1<{ name: string }>(pool, `SELECT name FROM suppliers WHERE id=$1`, [doc.supplier_id]);

  for (const [leftRole, rightRole, findingType] of pairs) {
    const left = byRole[leftRole];
    const right = byRole[rightRole];
    if (!left || !right) continue;
    const keys = new Set([...Object.keys(left.qty), ...Object.keys(right.qty)]);
    for (const key of keys) {
      const [itemId, size] = key.split('|');
      const lq = left.qty[key] ?? 0;
      const rq = right.qty[key] ?? 0;
      if (lq === rq) {
        if (lq > 0) {
          await dq(pool,
            `INSERT INTO reconciliation_matches (case_id, matched_qty, method, score, status, explanation)
             SELECT $1, $2, 'DETERMINISTIC', 1.0, 'CONFIRMED', $3
             WHERE NOT EXISTS (
               SELECT 1 FROM reconciliation_matches WHERE case_id=$1 AND explanation=$3)`,
            [caseId, lq, `${leftRole} and ${rightRole} agree on ${key}: ${lq}`]);
        }
        continue;
      }
      anyMismatch = true;
      const item = await dq1<{ name: string }>(pool, `SELECT name FROM items WHERE id=$1`, [itemId]);
      await raiseFinding(pool, {
        type: findingType, severity: 'WARNING',
        title: `${supplier?.name ?? 'Supplier'}: ${leftRole.toLowerCase()} says ${lq}, ${rightRole.toLowerCase()} says ${rq} for ${item?.name ?? 'item'} size ${size}`,
        explanation: `Within the same receipt group the ${leftRole.toLowerCase()} and the ${rightRole.toLowerCase()} disagree by ${Math.abs(lq - rq)} pc. Check both papers; correct the wrong one or record the shortage/excess with the supplier.`,
        supplierId: doc.supplier_id, itemId, size,
        expected: String(lq), actual: String(rq), difference: String(rq - lq),
        relatedDocumentIds: [...left.docIds, ...right.docIds],
        recommendedAction: 'Open the reconciliation case and confirm which paper is right.',
        dedupKey: `recq:${caseId}:${leftRole}:${rightRole}:${key}`,
      });
    }
  }

  await dq(pool,
    `UPDATE reconciliation_cases SET status=$2, summary=$3 WHERE id=$1 AND status <> 'RESOLVED'`,
    [caseId, anyMismatch ? 'QUANTITY_MISMATCH' : (Object.keys(byRole).length >= 2 ? 'MATCHED' : 'OPEN'),
     JSON.stringify({ roles: Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, v.docIds])) })]);
  return caseId;
}

/**
 * For the double-count guard at posting time: item|size keys already moved
 * into stock by another member of the same receipt group.
 */
export async function alreadyPostedKeysForGroup(client: PoolClient, documentId: string): Promise<Set<string>> {
  const docIds = await findReceiptGroupDocs(client, documentId);
  const others = docIds.filter((d) => d !== documentId);
  if (others.length === 0) return new Set();
  const rows = await dq<{ item_id: string; size: string }>(client,
    `SELECT DISTINCT im.item_id, im.size
     FROM inventory_movements im
     JOIN document_lines dl ON dl.id = im.source_line_id
     WHERE im.source_type = 'DOCUMENT_LINE'
       AND im.movement_type = 'SUPPLIER_RECEIPT'
       AND dl.document_id = ANY($1::uuid[])`, [others]);
  return new Set(rows.map((r) => `${r.item_id}|${r.size}`));
}

// ── Periodic scans (run by the worker / tick) ────────────────────────────────

/** Challans posted long ago with no invoice from the same supplier yet. */
export async function scanChallanAwaitingInvoice(): Promise<number> {
  const pool = getPool();
  const settings = await getSettings(pool);
  const waitDays = settings.challan_invoice_wait_days ?? 10;
  const rows = await dq<{ id: string; ref_no: string; document_date: string; supplier_id: string; supplier: string }>(pool,
    `SELECT d.id, d.ref_no, d.document_date, d.supplier_id, s.name AS supplier
     FROM documents d JOIN suppliers s ON s.id = d.supplier_id
     WHERE d.doc_type = 'SUPPLIER_DELIVERY_CHALLAN'
       AND d.status IN ('POSTED','LINKED_NO_POSTING')
       AND d.document_date < CURRENT_DATE - $1::int
       AND NOT EXISTS (
         SELECT 1 FROM reconciliation_case_documents me
         JOIN reconciliation_case_documents inv ON inv.case_id = me.case_id AND inv.role = 'INVOICE'
         WHERE me.document_id = d.id)`,
    [waitDays]);
  for (const r of rows) {
    await raiseFinding(pool, {
      type: 'CHALLAN_AWAITING_INVOICE', severity: 'WARNING',
      title: `No invoice yet for challan ${r.ref_no} (${r.supplier}, ${fmtDate(r.document_date)})`,
      explanation: `The delivery challan was received more than ${waitDays} days ago and no matching invoice has arrived. Ask ${r.supplier} for the bill so purchases and GST records stay complete.`,
      supplierId: r.supplier_id, documentId: r.id,
      recommendedAction: `Request the invoice from ${r.supplier}.`,
      dedupKey: `awaitinv:${r.id}`,
    });
  }
  return rows.length;
}

/** Invoices that arrived with no challan/inward in their receipt group. */
export async function scanInvoiceWithoutChallan(): Promise<number> {
  const pool = getPool();
  const rows = await dq<{ id: string; ref_no: string; supplier_id: string; supplier: string }>(pool,
    `SELECT d.id, d.ref_no, d.supplier_id, s.name AS supplier
     FROM documents d JOIN suppliers s ON s.id = d.supplier_id
     WHERE d.doc_type = 'SUPPLIER_INVOICE'
       AND d.status IN ('POSTED','READY_TO_POST','NEEDS_REVIEW')
       AND d.document_date IS NOT NULL AND d.document_date < CURRENT_DATE - 2
       AND NOT EXISTS (
         SELECT 1 FROM reconciliation_case_documents me
         JOIN reconciliation_case_documents oth ON oth.case_id = me.case_id AND oth.role IN ('CHALLAN','INWARD')
         WHERE me.document_id = d.id)`);
  for (const r of rows) {
    await raiseFinding(pool, {
      type: 'INVOICE_WITHOUT_KNOWN_CHALLAN', severity: 'INFO',
      title: `Invoice ${r.ref_no} from ${r.supplier} has no matching challan or inward entry`,
      explanation: 'Goods normally arrive with a challan or get written in the inward book before the bill comes. If the goods for this invoice were received, record the inward entry; if not, hold the bill.',
      supplierId: r.supplier_id, documentId: r.id,
      recommendedAction: 'Confirm the goods were actually received.',
      dedupKey: `invnochallan:${r.id}`,
    });
  }
  return rows.length;
}

/** Purchase orders past their expected date with quantity still outstanding. */
export async function scanOverdueOrders(): Promise<number> {
  const pool = getPool();
  const settings = await getSettings(pool);
  const overdueDays = settings.overdue_delivery_days ?? 14;
  const rows = await dq<{
    id: string; po_no: string; supplier_id: string; supplier: string;
    order_date: string; expected_date: string | null; outstanding: number;
  }>(pool,
    `SELECT po.id, po.po_no, po.supplier_id, s.name AS supplier, po.order_date, po.expected_date,
            SUM(pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0))::int AS outstanding
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN purchase_order_lines pol ON pol.po_id = po.id
     LEFT JOIN (
       SELECT po_line_id, SUM(quantity)::int AS qty FROM po_line_deliveries GROUP BY po_line_id
     ) del ON del.po_line_id = pol.id
     WHERE po.status IN ('OPEN','PARTIALLY_DELIVERED','OVERDUE')
       AND COALESCE(po.expected_date, po.order_date + $1::int) < CURRENT_DATE
     GROUP BY po.id, po.po_no, po.supplier_id, s.name, po.order_date, po.expected_date
     HAVING SUM(pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0)) > 0`,
    [overdueDays]);
  for (const r of rows) {
    await dq(pool, `UPDATE purchase_orders SET status='OVERDUE' WHERE id=$1 AND status IN ('OPEN','PARTIALLY_DELIVERED')`, [r.id]);
    const fid = await raiseFinding(pool, {
      type: 'ORDER_OVERDUE', severity: 'WARNING',
      title: `${r.po_no}: ${r.outstanding} pc still not delivered by ${r.supplier}`,
      explanation: `Ordered on ${fmtDate(r.order_date)}${r.expected_date ? `, expected by ${fmtDate(r.expected_date)}` : ''}. ${r.outstanding} pc remain outstanding past the allowed ${overdueDays} days.`,
      supplierId: r.supplier_id,
      expected: 'Delivery complete', actual: `${r.outstanding} pc outstanding`,
      recommendedAction: `Follow up with ${r.supplier} about ${r.po_no}.`,
      dedupKey: `overdue:${r.id}`,
    });
    if (fid) {
      await raiseTask(pool, {
        taskType: 'FOLLOW_UP_SUPPLIER',
        title: `Follow up: ${r.po_no} overdue at ${r.supplier} (${r.outstanding} pc outstanding)`,
        priority: 'HIGH', findingId: fid,
        payload: { poId: r.id },
        dedupKey: `overduetask:${r.id}`,
      });
    }
  }
  return rows.length;
}

/** Inward-book pages whose receipt group has no challan and no invoice. */
export async function scanInwardWithoutSource(): Promise<number> {
  const pool = getPool();
  const rows = await dq<{ id: string; ref_no: string; supplier_id: string; supplier: string }>(pool,
    `SELECT d.id, d.ref_no, d.supplier_id, s.name AS supplier
     FROM documents d JOIN suppliers s ON s.id = d.supplier_id
     WHERE d.doc_type = 'INWARD_BOOK'
       AND d.status IN ('POSTED','LINKED_NO_POSTING')
       AND d.document_date IS NOT NULL AND d.document_date < CURRENT_DATE - 3
       AND NOT EXISTS (
         SELECT 1 FROM reconciliation_case_documents me
         JOIN reconciliation_case_documents oth ON oth.case_id = me.case_id AND oth.role IN ('CHALLAN','INVOICE')
         WHERE me.document_id = d.id)`);
  for (const r of rows) {
    await raiseFinding(pool, {
      type: 'INWARD_WITHOUT_SUPPORTING_DOCUMENT', severity: 'INFO',
      title: `Inward entry ${r.ref_no} (${r.supplier}) has no challan or invoice yet`,
      explanation: 'Goods were written into the inward book but no supplier paper has been photographed. If the supplier gave a challan or bill, send its photo on Telegram.',
      supplierId: r.supplier_id, documentId: r.id,
      recommendedAction: 'Photograph the supplier challan/bill if it exists.',
      dedupKey: `inwnosrc:${r.id}`,
    });
  }
  return rows.length;
}

export async function runPeriodicScans(): Promise<Record<string, number>> {
  return {
    challanAwaitingInvoice: await scanChallanAwaitingInvoice(),
    invoiceWithoutChallan: await scanInvoiceWithoutChallan(),
    overdueOrders: await scanOverdueOrders(),
    inwardWithoutSource: await scanInwardWithoutSource(),
  };
}
