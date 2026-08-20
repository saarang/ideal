/**
 * Reconciliation: the challan, the aavak (inward book) entry and the bill for
 * the same delivery are compared item+size; differences become findings, and
 * stock is only ever counted once across the group.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedCore, makeItem, makeSupplier, closeDb, CoreIds } from './helpers/db';

let core: CoreIds;
let supplierId: string;
let itemA: string; // Bushirt
let itemB: string; // College Pant

beforeEach(async () => {
  await resetDb();
  core = await seedCore();
  supplierId = await makeSupplier('SARDA', 'Sarda Hosiery');
  itemA = await makeItem('IU-BUSH', 'Bushirt', ['36', '38']);
  itemB = await makeItem('IU-CLGP', 'College Pant', ['40', '42']);
});
afterAll(async () => { await closeDb(); });

interface LineSpec { itemId: string; size: string; qty: number }

async function makeDoc(docType: string, docDate: string, lines: LineSpec[], opts: { status?: string } = {}): Promise<string> {
  const { getPool } = await import('@/src/lib/db');
  const pool = getPool();
  const shop = await pool.query(`SELECT id FROM locations WHERE code='SHOP'`);
  const d = await pool.query(
    `INSERT INTO documents (doc_type, status, review_status, supplier_id, document_date, receipt_location_id, source)
     VALUES ($1,$2,'REVIEWED',$3,$4,$5,'WEB_UPLOAD') RETURNING id`,
    [docType, opts.status ?? 'READY_TO_POST', supplierId, docDate, shop.rows[0].id]);
  let n = 0;
  for (const l of lines) {
    n++;
    await pool.query(
      `INSERT INTO document_lines (document_id, line_no, item_id, size_normalized, quantity, mapping_status, review_status)
       VALUES ($1,$2,$3,$4,$5,'USER_CONFIRMED','REVIEWED')`,
      [d.rows[0].id, n, l.itemId, l.size, l.qty]);
  }
  await pool.query(`UPDATE documents SET calculated_total_qty=$2 WHERE id=$1`,
    [d.rows[0].id, lines.reduce((s, l) => s + l.qty, 0)]);
  return d.rows[0].id;
}

async function openFindings(): Promise<{ type: string; title: string }[]> {
  const { q } = await import('@/src/lib/db');
  return q(`SELECT type, title FROM findings WHERE status='OPEN' ORDER BY created_at`);
}
async function stockAtShop(itemId: string, size: string): Promise<number> {
  const { q1 } = await import('@/src/lib/db');
  const r = await q1<{ qty: number }>(
    `SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_movements im
     JOIN locations l ON l.id=im.location_id WHERE im.item_id=$1 AND im.size=$2 AND l.code='SHOP'`,
    [itemId, size]);
  return r?.qty ?? 0;
}

describe('reconcileReceiptGroup', () => {
  it('groups challan + inward entry and flags a 10 vs 8 quantity mismatch', async () => {
    const { reconcileReceiptGroup } = await import('@/src/lib/pipeline/recon');
    const challan = await makeDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', [
      { itemId: itemA, size: '36', qty: 10 },
      { itemId: itemB, size: '40', qty: 6 },
    ]);
    await makeDoc('INWARD_BOOK', '2026-08-05', [
      { itemId: itemA, size: '36', qty: 8 },   // 2 short
      { itemId: itemB, size: '40', qty: 6 },   // agrees
    ]);

    const caseId = await reconcileReceiptGroup(challan);
    expect(caseId).toBeTruthy();

    const { q1, q } = await import('@/src/lib/db');
    const kase = await q1<{ status: string }>(`SELECT status FROM reconciliation_cases WHERE id=$1`, [caseId]);
    expect(kase?.status).toBe('QUANTITY_MISMATCH');

    const members = await q<{ role: string }>(
      `SELECT role FROM reconciliation_case_documents WHERE case_id=$1 ORDER BY role`, [caseId]);
    expect(members.map((m) => m.role)).toEqual(['CHALLAN', 'INWARD']);

    const f = await openFindings();
    const mismatch = f.filter((x) => x.type === 'RECEIPT_QUANTITY_MISMATCH');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].title).toMatch(/10/);
    expect(mismatch[0].title).toMatch(/8/);
    expect(mismatch[0].title).toMatch(/Bushirt/);
  });

  it('a clean group settles as MATCHED with confirmed match rows and no findings', async () => {
    const { reconcileReceiptGroup } = await import('@/src/lib/pipeline/recon');
    const challan = await makeDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', [{ itemId: itemA, size: '36', qty: 10 }]);
    await makeDoc('INWARD_BOOK', '2026-08-06', [{ itemId: itemA, size: '36', qty: 10 }]);
    const caseId = await reconcileReceiptGroup(challan);
    const { q1 } = await import('@/src/lib/db');
    const kase = await q1<{ status: string }>(`SELECT status FROM reconciliation_cases WHERE id=$1`, [caseId]);
    expect(kase?.status).toBe('MATCHED');
    expect(await openFindings()).toHaveLength(0);
  });

  it('papers outside the date window form separate cases', async () => {
    const { reconcileReceiptGroup } = await import('@/src/lib/pipeline/recon');
    const challan = await makeDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-01', [{ itemId: itemA, size: '36', qty: 10 }]);
    await makeDoc('INWARD_BOOK', '2026-08-20', [{ itemId: itemA, size: '36', qty: 10 }]); // 19 days later
    const caseId = await reconcileReceiptGroup(challan);
    const { q } = await import('@/src/lib/db');
    const members = await q<{ role: string }>(
      `SELECT role FROM reconciliation_case_documents WHERE case_id=$1`, [caseId]);
    expect(members.map((m) => m.role)).toEqual(['CHALLAN']);
  });
});

describe('no double counting across a receipt group', () => {
  it('challan posts stock; the matching invoice links without posting again', async () => {
    const { postDocument } = await import('@/src/lib/pipeline/post');
    const challan = await makeDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', [
      { itemId: itemA, size: '36', qty: 10 },
    ]);
    const invoice = await makeDoc('SUPPLIER_INVOICE', '2026-08-07', [
      { itemId: itemA, size: '36', qty: 10 },
    ]);

    const first = await postDocument(challan, core.userId);
    expect(first.status).toBe('POSTED');
    expect(await stockAtShop(itemA, '36')).toBe(10);

    const second = await postDocument(invoice, core.userId);
    expect(second.status).toBe('LINKED_NO_POSTING');
    expect(second.movements).toBe(0);
    expect(await stockAtShop(itemA, '36')).toBe(10); // still 10, not 20
  });

  it('an invoice with MORE than the challan posts only the extra quantity lines', async () => {
    const { postDocument } = await import('@/src/lib/pipeline/post');
    const challan = await makeDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', [
      { itemId: itemA, size: '36', qty: 10 },
    ]);
    const invoice = await makeDoc('SUPPLIER_INVOICE', '2026-08-07', [
      { itemId: itemA, size: '36', qty: 10 },  // same key → skipped
      { itemId: itemB, size: '40', qty: 4 },   // new key → posts
    ]);
    await postDocument(challan, core.userId);
    const second = await postDocument(invoice, core.userId);
    expect(second.status).toBe('POSTED');
    expect(second.skippedAsLinked).toBe(1);
    expect(await stockAtShop(itemA, '36')).toBe(10);
    expect(await stockAtShop(itemB, '40')).toBe(4);
  });

  it('re-posting the same document is harmless (idempotent)', async () => {
    const { postDocument } = await import('@/src/lib/pipeline/post');
    const challan = await makeDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', [{ itemId: itemA, size: '36', qty: 10 }]);
    await postDocument(challan, core.userId);
    const again = await postDocument(challan, core.userId);
    expect(again.status).toBe('POSTED');
    expect(again.movements).toBe(0);
    expect(await stockAtShop(itemA, '36')).toBe(10);
  });
});

describe('periodic scans', () => {
  it('flags an overdue order, and cancelling clears the path', async () => {
    const { scanOverdueOrders } = await import('@/src/lib/pipeline/recon');
    const { getPool } = await import('@/src/lib/db');
    const pool = getPool();
    const po = await pool.query(
      `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, status)
       VALUES ($1, CURRENT_DATE-30, CURRENT_DATE-10, 'OPEN') RETURNING id`, [supplierId]);
    await pool.query(
      `INSERT INTO purchase_order_lines (po_id, line_no, item_id, description_raw, size, quantity_ordered)
       VALUES ($1,1,$2,'Bushirt','36',40)`, [po.rows[0].id, itemA]);

    const n = await scanOverdueOrders();
    expect(n).toBeGreaterThanOrEqual(1);
    const f = await openFindings();
    expect(f.some((x) => x.type === 'ORDER_OVERDUE')).toBe(true);
    const st = await pool.query(`SELECT status FROM purchase_orders WHERE id=$1`, [po.rows[0].id]);
    expect(st.rows[0].status).toBe('OVERDUE');
  });

  it('a posted challan with no invoice after the wait raises a reminder', async () => {
    const { scanChallanAwaitingInvoice } = await import('@/src/lib/pipeline/recon');
    const { getPool } = await import('@/src/lib/db');
    // Challan posted 20 days ago (wait is 10).
    const old = await makeDoc('SUPPLIER_DELIVERY_CHALLAN',
      new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10),
      [{ itemId: itemA, size: '36', qty: 5 }], { status: 'POSTED' });
    void old;
    const n = await scanChallanAwaitingInvoice();
    expect(n).toBeGreaterThanOrEqual(1);
    const f = await openFindings();
    expect(f.some((x) => x.type === 'CHALLAN_AWAITING_INVOICE')).toBe(true);
  });
});
