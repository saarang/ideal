/**
 * POST — turn an approved document into inventory movements.
 *
 * Rules that matter here:
 *  • Only READY_TO_POST documents post, and only their postable lines.
 *  • One physical receipt, one stock entry: lines whose item+size were already
 *    posted by another member of the same receipt group are skipped; if every
 *    line is skipped the document becomes LINKED_NO_POSTING.
 *  • Customer challans and transfers move stock out and honour the negative
 *    stock policy (BLOCK by default) inside the same transaction.
 *  • Receipts are matched FIFO against open purchase-order lines afterwards.
 */
import { getPool, dq, dq1, withTx } from '../db';
import {
  postMovements, postTransfer, MovementInput, NegativeStockError,
} from '../domain/ledger';
import { raiseFinding, raiseTask } from '../domain/findings';
import { reconcileReceiptGroup, alreadyPostedKeysForGroup } from './recon';
import { audit } from '../audit';
import { fmtDate } from '../format';

const RECEIPT_TYPES = ['SUPPLIER_DELIVERY_CHALLAN', 'SUPPLIER_INVOICE', 'INWARD_BOOK'];

export interface PostOutcome {
  status: 'POSTED' | 'LINKED_NO_POSTING' | 'BLOCKED';
  movements: number;
  skippedAsLinked: number;
  message: string;
}

interface PostableLine {
  id: string; item_id: string; size_normalized: string; quantity: number; line_no: number; sub_no: number;
}

async function postableLines(db: import('pg').PoolClient, documentId: string): Promise<PostableLine[]> {
  return dq<PostableLine>(db,
    `SELECT id, item_id, size_normalized, quantity, line_no, sub_no
     FROM document_lines
     WHERE document_id=$1
       AND item_id IS NOT NULL AND size_normalized IS NOT NULL
       AND COALESCE(quantity,0) > 0
       AND review_status <> 'NEEDS_REVIEW'
       AND mapping_status IN ('USER_CONFIRMED','AI_SUGGESTED','NOT_REQUIRED')
     ORDER BY line_no, sub_no
     FOR UPDATE`, [documentId]);
}

export async function postDocument(documentId: string, userId: string | null): Promise<PostOutcome> {
  const pool = getPool();

  let outcome: PostOutcome;
  try {
    outcome = await withTx(async (client) => {
      const doc = await dq1<{
        id: string; ref_no: string; doc_type: string; status: string;
        supplier_id: string | null; customer_id: string | null;
        document_date: string | null;
        receipt_location_id: string | null; dispatch_location_id: string | null;
        destination_location_id: string | null;
      }>(client,
        `SELECT id, ref_no, doc_type, status, supplier_id, customer_id, document_date,
                receipt_location_id, dispatch_location_id, destination_location_id
         FROM documents WHERE id=$1 FOR UPDATE`, [documentId]);
      if (!doc) throw new Error('Document not found');
      if (doc.status === 'POSTED') return { status: 'POSTED', movements: 0, skippedAsLinked: 0, message: 'Already posted.' } as PostOutcome;
      if (doc.status !== 'READY_TO_POST') throw new Error(`Document is ${doc.status}, not READY_TO_POST.`);
      const businessDate = doc.document_date ?? new Date().toISOString().slice(0, 10);
      const lines = await postableLines(client, documentId);
      if (lines.length === 0) throw new Error('No postable lines.');

      if (RECEIPT_TYPES.includes(doc.doc_type)) {
        if (!doc.receipt_location_id) throw new Error('Receiving location missing.');
        const posted = await alreadyPostedKeysForGroup(client, documentId);
        const toPost = lines.filter((l) => !posted.has(`${l.item_id}|${l.size_normalized}`));
        const skipped = lines.length - toPost.length;

        if (toPost.length === 0) {
          await dq(client,
            `UPDATE documents SET status='LINKED_NO_POSTING', review_status='REVIEWED' WHERE id=$1`, [documentId]);
          return {
            status: 'LINKED_NO_POSTING', movements: 0, skippedAsLinked: skipped,
            message: 'All quantities were already received via a linked document; nothing was added to stock again.',
          } as PostOutcome;
        }

        const movements: MovementInput[] = toPost.map((l) => ({
          movementType: 'SUPPLIER_RECEIPT',
          itemId: l.item_id, size: l.size_normalized, locationId: doc.receipt_location_id!,
          qty: l.quantity, businessDate,
          sourceType: 'DOCUMENT_LINE', sourceId: documentId, sourceLineId: l.id,
          reason: `${doc.doc_type} ${doc.ref_no}`, createdBy: userId,
        }));
        const res = await postMovements(client, movements);
        await dq(client, `UPDATE documents SET status='POSTED', review_status='REVIEWED' WHERE id=$1`, [documentId]);
        return {
          status: 'POSTED', movements: res.inserted, skippedAsLinked: skipped,
          message: skipped > 0
            ? `${res.inserted} line(s) added to stock; ${skipped} line(s) skipped because a linked document already covered them.`
            : `${res.inserted} line(s) added to stock.`,
        } as PostOutcome;
      }

      if (doc.doc_type === 'IDEAL_CUSTOMER_DELIVERY_CHALLAN') {
        if (!doc.dispatch_location_id) throw new Error('Dispatch location missing.');
        const movements: MovementInput[] = lines.map((l) => ({
          movementType: 'CUSTOMER_ISSUE',
          itemId: l.item_id, size: l.size_normalized, locationId: doc.dispatch_location_id!,
          qty: -l.quantity, businessDate,
          sourceType: 'DOCUMENT_LINE', sourceId: documentId, sourceLineId: l.id,
          reason: `Customer challan ${doc.ref_no}`, createdBy: userId,
        }));
        const res = await postMovements(client, movements);
        await dq(client, `UPDATE documents SET status='POSTED', review_status='REVIEWED' WHERE id=$1`, [documentId]);
        return {
          status: 'POSTED', movements: res.inserted, skippedAsLinked: 0,
          message: `${res.inserted} line(s) issued to customer.`,
        } as PostOutcome;
      }

      if (doc.doc_type === 'SHOP_TO_GODOWN_TRANSFER' || doc.doc_type === 'GODOWN_TO_SHOP_TRANSFER') {
        if (!doc.dispatch_location_id || !doc.destination_location_id) throw new Error('Transfer locations missing.');
        let n = 0;
        for (const l of lines) {
          await postTransfer(client, {
            itemId: l.item_id, size: l.size_normalized,
            fromLocationId: doc.dispatch_location_id, toLocationId: doc.destination_location_id,
            qty: l.quantity, businessDate,
            sourceType: 'DOCUMENT_LINE', sourceId: documentId, sourceLineId: l.id,
            reason: `Transfer ${doc.ref_no}`, createdBy: userId,
          });
          n += 2;
        }
        await dq(client, `UPDATE documents SET status='POSTED', review_status='REVIEWED' WHERE id=$1`, [documentId]);
        return {
          status: 'POSTED', movements: n, skippedAsLinked: 0,
          message: `${lines.length} line(s) transferred.`,
        } as PostOutcome;
      }

      throw new Error(`Documents of type ${doc.doc_type} do not post to stock.`);
    });
  } catch (err) {
    if (err instanceof NegativeStockError) {
      const d = err.detail;
      const item = await dq1<{ name: string }>(pool, `SELECT name FROM items WHERE id=$1`, [d.itemId]);
      const loc = await dq1<{ code: string }>(pool, `SELECT code FROM locations WHERE id=$1`, [d.locationId]);
      const fid = await raiseFinding(pool, {
        type: 'NEGATIVE_STOCK', severity: 'HIGH',
        title: `Posting blocked: ${item?.name ?? 'item'} size ${d.size} would go to ${d.resulting} at ${loc?.code ?? 'location'}`,
        explanation: 'The system does not carry negative stock (settings → negative stock policy). The book quantity is lower than what this document sends out — either some receipt was never recorded or the count is wrong. Record the missing receipt or adjust stock first.',
        documentId, itemId: d.itemId, size: d.size,
        expected: `≥ ${-d.attempted}`, actual: String(d.resulting - d.attempted),
        recommendedAction: 'Record the missing receipt or make a stock adjustment, then post again.',
        dedupKey: `negblock:${documentId}:${d.itemId}:${d.size}`,
      });
      if (fid) {
        await raiseTask(pool, {
          taskType: 'RESOLVE_NEGATIVE_STOCK',
          title: `Fix stock for ${item?.name ?? 'item'} size ${d.size} before posting`,
          priority: 'HIGH', documentId, findingId: fid,
          dedupKey: `negblocktask:${documentId}:${d.itemId}:${d.size}`,
        });
      }
      return {
        status: 'BLOCKED', movements: 0, skippedAsLinked: 0,
        message: `Blocked: ${item?.name ?? 'item'} size ${d.size} would go below zero. A task was created.`,
      };
    }
    throw err;
  }

  // Post-commit bookkeeping (safe to repeat).
  await audit(userId, 'DOCUMENT_POSTED', 'document', documentId, undefined, { outcome });
  const doc = await dq1<{ doc_type: string; document_date: string | null }>(pool,
    `SELECT doc_type, document_date FROM documents WHERE id=$1`, [documentId]);
  if (doc && RECEIPT_TYPES.includes(doc.doc_type)) {
    await reconcileReceiptGroup(documentId);
    if (outcome.status === 'POSTED') await matchReceiptToPurchaseOrders(documentId);
  }
  return outcome;
}

/**
 * FIFO-match a posted receipt's lines against open PO lines of the same
 * supplier + item + size, and refresh PO statuses.
 */
export async function matchReceiptToPurchaseOrders(documentId: string): Promise<void> {
  const pool = getPool();
  const doc = await dq1<{ supplier_id: string | null; document_date: string | null; ref_no: string }>(pool,
    `SELECT supplier_id, document_date, ref_no FROM documents WHERE id=$1`, [documentId]);
  if (!doc?.supplier_id) return;

  const lines = await dq<{ id: string; item_id: string; size: string; quantity: number }>(pool,
    `SELECT dl.id, dl.item_id, dl.size_normalized AS size, dl.quantity
     FROM document_lines dl
     JOIN inventory_movements im ON im.source_line_id = dl.id AND im.source_type='DOCUMENT_LINE'
     WHERE dl.document_id=$1`, [documentId]);

  const touchedPOs = new Set<string>();
  for (const line of lines) {
    let remaining = line.quantity
      - ((await dq1<{ q: number }>(pool,
          `SELECT COALESCE(SUM(quantity),0)::int AS q FROM po_line_deliveries WHERE document_line_id=$1`,
          [line.id]))?.q ?? 0);
    if (remaining <= 0) continue;

    const open = await dq<{ pol_id: string; po_id: string; po_no: string; outstanding: number }>(pool,
      `SELECT pol.id AS pol_id, po.id AS po_id, po.po_no,
              (pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0))::int AS outstanding
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.po_id
       LEFT JOIN (SELECT po_line_id, SUM(quantity)::int AS qty FROM po_line_deliveries GROUP BY po_line_id) del
         ON del.po_line_id = pol.id
       WHERE po.supplier_id=$1 AND po.status NOT IN ('CANCELLED','DELIVERED')
         AND pol.item_id=$2 AND pol.size=$3
         AND (pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0)) > 0
       ORDER BY po.order_date, po.created_at`,
      [doc.supplier_id, line.item_id, line.size]);

    for (const o of open) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, o.outstanding);
      await dq(pool,
        `INSERT INTO po_line_deliveries (po_line_id, document_line_id, quantity, delivery_date, match_method, match_score)
         VALUES ($1,$2,$3,$4,'DETERMINISTIC',1.0)
         ON CONFLICT (po_line_id, document_line_id) DO NOTHING`,
        [o.pol_id, line.id, take, doc.document_date]);
      remaining -= take;
      touchedPOs.add(o.po_id);
    }

    if (remaining > 0 && open.length > 0) {
      // Delivered more than every open order combined — worth a look.
      const item = await dq1<{ name: string }>(pool, `SELECT name FROM items WHERE id=$1`, [line.item_id]);
      await raiseFinding(pool, {
        type: 'ORDER_QUANTITY_MISMATCH', severity: 'WARNING',
        title: `Received ${line.quantity} pc of ${item?.name ?? 'item'} size ${line.size} — more than was on order`,
        explanation: `${remaining} pc could not be matched to any open order line from this supplier. Either an order was not recorded or the supplier sent extra.`,
        supplierId: doc.supplier_id, documentId, itemId: line.item_id, size: line.size,
        difference: `+${remaining}`,
        recommendedAction: 'Check the order book; accept the excess or raise it with the supplier.',
        dedupKey: `overdeliv:${line.id}`,
      });
    }
  }

  for (const poId of touchedPOs) await refreshPoStatus(poId);
}

export async function refreshPoStatus(poId: string): Promise<void> {
  const pool = getPool();
  const s = await dq1<{ ordered: number; delivered: number }>(pool,
    `SELECT SUM(pol.quantity_ordered - pol.quantity_cancelled)::int AS ordered,
            COALESCE(SUM(del.qty),0)::int AS delivered
     FROM purchase_order_lines pol
     LEFT JOIN (SELECT po_line_id, SUM(quantity)::int AS qty FROM po_line_deliveries GROUP BY po_line_id) del
       ON del.po_line_id = pol.id
     WHERE pol.po_id=$1`, [poId]);
  if (!s) return;
  const status =
    s.delivered === 0 ? 'OPEN'
    : s.delivered < s.ordered ? 'PARTIALLY_DELIVERED'
    : s.delivered === s.ordered ? 'DELIVERED'
    : 'OVER_DELIVERED';
  await dq(pool,
    `UPDATE purchase_orders SET status=$2 WHERE id=$1 AND status NOT IN ('CANCELLED')`,
    [poId, status]);
}

/** Human-readable summary for Telegram acks and the document screen. */
export async function documentSummaryText(documentId: string): Promise<string> {
  const pool = getPool();
  const doc = await dq1<{
    ref_no: string; doc_type: string; status: string; document_date: string | null;
    supplier: string | null; customer: string | null; calculated_total_qty: number | null;
  }>(pool,
    `SELECT d.ref_no, d.doc_type, d.status, d.document_date, s.name AS supplier, c.name AS customer,
            d.calculated_total_qty
     FROM documents d
     LEFT JOIN suppliers s ON s.id = d.supplier_id
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.id=$1`, [documentId]);
  if (!doc) return 'Document not found.';
  const findings = await dq<{ severity: string; title: string }>(pool,
    `SELECT severity, title FROM findings WHERE document_id=$1 AND status='OPEN'
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END
     LIMIT 5`, [documentId]);
  const typeLabel: Record<string, string> = {
    SUPPLIER_DELIVERY_CHALLAN: 'Supplier challan', SUPPLIER_INVOICE: 'Supplier bill',
    INWARD_BOOK: 'Inward book page', IDEAL_CUSTOMER_DELIVERY_CHALLAN: 'Ideal delivery challan',
    ORDER_BOOK: 'Order book page', SHOP_TO_GODOWN_TRANSFER: 'Shop → Godown transfer',
    GODOWN_TO_SHOP_TRANSFER: 'Godown → Shop transfer', UNKNOWN: 'Document',
  };
  const parts = [
    `${typeLabel[doc.doc_type] ?? doc.doc_type} ${doc.ref_no}`,
    doc.supplier ? `from ${doc.supplier}` : doc.customer ? `to ${doc.customer}` : '',
    doc.document_date ? `dated ${fmtDate(doc.document_date)}` : '',
    doc.calculated_total_qty != null ? `— ${doc.calculated_total_qty} pc` : '',
  ].filter(Boolean);
  let text = parts.join(' ') + `\nStatus: ${doc.status.replace(/_/g, ' ').toLowerCase()}`;
  if (findings.length > 0) {
    text += `\nNeeds attention:`;
    for (const f of findings) text += `\n• [${f.severity}] ${f.title}`;
  }
  return text;
}
