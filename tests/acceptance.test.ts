/**
 * ACCEPTANCE SUITE
 *
 * One test per acceptance scenario from the specification, in order, so the
 * suite doubles as a traceability list. Each test names the scenario it
 * covers; where a scenario is exercised in more depth elsewhere, the deeper
 * suite is named in a comment.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import sharp from 'sharp';
import { resetDb, seedCore, makeItem, makeSupplier, closeDb, CoreIds } from './helpers/db';

let core: CoreIds;

beforeEach(async () => {
  await resetDb();
  core = await seedCore();
});
afterAll(async () => { await closeDb(); });

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function jpeg(opts: { width?: number; height?: number; orientation?: number } = {}): Promise<Buffer> {
  const img = sharp({ create: { width: opts.width ?? 600, height: opts.height ?? 900, channels: 3, background: '#fff' } });
  if (opts.orientation) img.withMetadata({ orientation: opts.orientation });
  return img.jpeg().toBuffer();
}

async function intake(filename: string, captionTag?: string, buffer?: Buffer): Promise<string> {
  const { ingestImages } = await import('@/src/lib/pipeline/ingest');
  const { runPipeline } = await import('@/src/lib/pipeline/runner');
  const r = await ingestImages({
    files: [{ buffer: buffer ?? await jpeg(), filename }],
    captionTag: captionTag ?? null,
    source: 'TELEGRAM',
    telegram: { chatId: 'shop-group', messageId: String(Date.now() + Math.random()), uploader: 'Papa' },
  });
  await runPipeline(r.documentId, 'PREPARE');
  return r.documentId;
}

async function makeReceiptDoc(docType: string, date: string, supplierId: string,
                              lines: { itemId: string; size: string; qty: number }[],
                              status = 'READY_TO_POST'): Promise<string> {
  const { getPool } = await import('@/src/lib/db');
  const pool = getPool();
  const d = await pool.query(
    `INSERT INTO documents (doc_type, status, review_status, supplier_id, document_date, receipt_location_id, source)
     VALUES ($1,$2,'REVIEWED',$3,$4,$5,'WEB_UPLOAD') RETURNING id`,
    [docType, status, supplierId, date, core.shopId]);
  let n = 0;
  for (const l of lines) {
    n++;
    await pool.query(
      `INSERT INTO document_lines (document_id, line_no, item_id, size_normalized, quantity, mapping_status, review_status)
       VALUES ($1,$2,$3,$4,$5,'USER_CONFIRMED','REVIEWED')`, [d.rows[0].id, n, l.itemId, l.size, l.qty]);
  }
  return d.rows[0].id;
}

async function stock(itemId: string, size: string): Promise<number> {
  const { q1 } = await import('@/src/lib/db');
  const r = await q1<{ qty: number }>(
    `SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_movements WHERE item_id=$1 AND size=$2`, [itemId, size]);
  return r?.qty ?? 0;
}

/* ── scenarios ───────────────────────────────────────────────────────────── */

describe('Acceptance', () => {
  it('1. A photo sent on Telegram becomes a document and the sender gets an acknowledgement', async () => {
    const { handleTelegramUpdate } = await import('@/src/lib/telegram/webhookHandler');
    const fs = await import('fs/promises');
    const path = await import('path');
    const dir = path.resolve(process.env.DATA_DIR || './data-test', 'tg');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'sanjay_invoice_1873.jpg');
    await fs.writeFile(file, await jpeg());

    const res = await handleTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 11, date: Math.floor(Date.now() / 1000),
        chat: { id: 'shop-group', type: 'group' },
        from: { id: 5, first_name: 'Papa' },
        photo: [{ file_id: file, file_unique_id: 'u1', width: 900, height: 1200 }],
      },
    } as never);

    expect(res.handled).toBe(true);
    expect(res.refNo).toMatch(/^DOC-/);
    const { q1 } = await import('@/src/lib/db');
    const doc = await q1<{ source: string; telegram_uploader: string }>(
      `SELECT source, telegram_uploader FROM documents WHERE id=$1`, [res.documentId!]);
    expect(doc?.source).toBe('TELEGRAM');
    expect(doc?.telegram_uploader).toBe('Papa');
    const out = await q1<{ text: string }>(`SELECT text FROM telegram_outbox ORDER BY created_at DESC LIMIT 1`);
    expect(out?.text).toContain(res.refNo!);
  });

  it('2. A sideways photo is straightened before reading (EXIF orientation honoured)', async () => {
    const rotated = await jpeg({ width: 400, height: 800, orientation: 6 }); // 90° CW flag
    const id = await intake('sarda_challan.jpg', undefined, rotated);
    const { q1 } = await import('@/src/lib/db');
    const page = await q1<{ width: number; height: number; rotation_applied: number; processed_path: string }>(
      `SELECT width, height, rotation_applied, processed_path FROM document_pages WHERE document_id=$1`, [id]);
    expect(page?.processed_path).toBeTruthy();
    expect(page?.rotation_applied).toBe(90);
    expect(page!.width).toBeGreaterThan(page!.height); // 400×800 became 800×400
  });

  it('3. "28/5" is read as size 28 × 5 pieces, never as a division', async () => {
    const { parseToken } = await import('@/src/lib/domain/sizeNotation');
    const p = parseToken('28/5', { plausibleSizeMin: 16, plausibleSizeMax: 44 });
    expect(p.kind).toBe('SIZE_OVER_QTY');
    expect([p.size, p.quantity]).toEqual(['28', 5]);
    // Deeper cases: tests/sizeNotation.test.ts
  });

  it('4. Composite sizes such as 12/14 and 28/32 stay one size', async () => {
    const { parseToken } = await import('@/src/lib/domain/sizeNotation');
    const ctx = { knownComposites: ['12/14', '28/32'], plausibleSizeMin: 16, plausibleSizeMax: 44 };
    expect(parseToken('12/14', ctx).kind).toBe('COMPOSITE_SIZE');
    expect(parseToken('28/32', ctx).size).toBe('28/32');
  });

  it('5. An uncertain size/quantity is kept raw, proposed with a confidence, and queued for a person', async () => {
    const id = await intake('aavak_vahi_aarena.jpg', '#inward');
    const { q } = await import('@/src/lib/db');
    const flagged = await q<{ size_raw: string; notes: string | null; review_status: string }>(
      `SELECT size_raw, notes, review_status FROM document_lines
       WHERE document_id=$1 AND review_status='NEEDS_REVIEW'`, [id]);
    expect(flagged.length).toBeGreaterThan(0);
    const tasks = await q<{ task_type: string }>(
      `SELECT task_type FROM workflow_tasks WHERE document_id=$1`, [id]);
    expect(tasks.length).toBeGreaterThan(0);
    // Nothing uncertain may reach the ledger.
    const moves = await q(`SELECT 1 FROM inventory_movements`);
    expect(moves).toHaveLength(0);
  });

  it('6. Bill arithmetic is recomputed and a ₹60 line error is caught', async () => {
    const { checkInvoice } = await import('@/src/lib/domain/arithmetic');
    const r = checkInvoice({
      lines: [{ lineRef: '1', quantity: 12, rate: 130, amountShown: 1500 }], // should be 1560
      taxes: [{ kind: 'CGST', ratePct: 2.5, amountShown: 37.50 }, { kind: 'SGST', ratePct: 2.5, amountShown: 37.50 }],
      subtotalShown: 1500, grandTotalShown: 1575, handwrittenTotalQty: 12,
    }, { toleranceINR: 1 });
    expect(r.lineChecks[0].status).toBe('MISMATCH');
    expect(r.lineChecks[0].differenceAbs).toBe('60.00');
    expect(r.hasErrors).toBe(true);
    // Full Sanjay bill: tests/arithmetic.test.ts
  });

  it('7. Rounding inside the ₹1 tolerance is not treated as an error', async () => {
    const { checkInvoice } = await import('@/src/lib/domain/arithmetic');
    const r = checkInvoice({
      lines: [{ lineRef: '1', quantity: 3, rate: 33.33, amountShown: 100 }],
      taxes: [], subtotalShown: 100, grandTotalShown: 100, handwrittenTotalQty: 3,
    }, { toleranceINR: 1 });
    expect(r.hasErrors).toBe(false);
  });

  it('8. The handwritten total is checked against the sum of the lines', async () => {
    const { checkInvoice } = await import('@/src/lib/domain/arithmetic');
    const r = checkInvoice({
      lines: [{ lineRef: '1', quantity: 10, rate: 100, amountShown: 1000 },
              { lineRef: '2', quantity: 5, rate: 100, amountShown: 500 }],
      taxes: [], subtotalShown: 1500, grandTotalShown: 1500, handwrittenTotalQty: 14,
    }, { toleranceINR: 1 });
    expect(r.calculatedTotalQty).toBe(15);
    expect(r.totalQtyCheck.status).toBe('MISMATCH');
  });

  it('9. Stock only moves when a document is posted, and the ledger is append-only', async () => {
    const supplierId = await makeSupplier('S1', 'Supplier One');
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const docId = await makeReceiptDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', supplierId, [{ itemId, size: '28', qty: 10 }]);
    expect(await stock(itemId, '28')).toBe(0);

    const { postDocument } = await import('@/src/lib/pipeline/post');
    await postDocument(docId, core.userId);
    expect(await stock(itemId, '28')).toBe(10);

    const { getPool } = await import('@/src/lib/db');
    await expect(getPool().query(`DELETE FROM inventory_movements`)).rejects.toThrow();
  });

  it('10. The same goods on a challan and its invoice are counted once', async () => {
    const supplierId = await makeSupplier('S1', 'Supplier One');
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const challan = await makeReceiptDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', supplierId, [{ itemId, size: '28', qty: 10 }]);
    const invoice = await makeReceiptDoc('SUPPLIER_INVOICE', '2026-08-07', supplierId, [{ itemId, size: '28', qty: 10 }]);
    const { postDocument } = await import('@/src/lib/pipeline/post');
    await postDocument(challan, core.userId);
    const second = await postDocument(invoice, core.userId);
    expect(second.status).toBe('LINKED_NO_POSTING');
    expect(await stock(itemId, '28')).toBe(10);
  });

  it('11. A challan saying 10 and an inward entry saying 8 raises a mismatch finding', async () => {
    const supplierId = await makeSupplier('S1', 'Supplier One');
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const challan = await makeReceiptDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', supplierId, [{ itemId, size: '28', qty: 10 }]);
    await makeReceiptDoc('INWARD_BOOK', '2026-08-05', supplierId, [{ itemId, size: '28', qty: 8 }]);
    const { reconcileReceiptGroup } = await import('@/src/lib/pipeline/recon');
    await reconcileReceiptGroup(challan);
    const { q } = await import('@/src/lib/db');
    const f = await q<{ type: string; expected_value: string; actual_value: string }>(
      `SELECT type, expected_value, actual_value FROM findings WHERE status='OPEN'`);
    expect(f.some((x) => x.type === 'RECEIPT_QUANTITY_MISMATCH')).toBe(true);
  });

  it('12. A delivery to a school reduces shop stock', async () => {
    const itemId = await makeItem('IU-JKT', 'Maroon Jacket', ['26', '28']);
    const { getPool } = await import('@/src/lib/db');
    const pool = getPool();
    const cust = await pool.query(`INSERT INTO customers (code, name) VALUES ('JAAN','The Jaan Foundation') RETURNING id`);
    const { postMovements } = await import('@/src/lib/domain/ledger');
    const { withTx } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'OPENING', itemId, size: '26', locationId: core.shopId, qty: 20,
      businessDate: '2026-08-01', sourceType: 'TEST',
    }]));

    const d = await pool.query(
      `INSERT INTO documents (doc_type, status, review_status, customer_id, document_date, dispatch_location_id, source)
       VALUES ('IDEAL_CUSTOMER_DELIVERY_CHALLAN','READY_TO_POST','REVIEWED',$1,'2026-08-13',$2,'WEB_UPLOAD') RETURNING id`,
      [cust.rows[0].id, core.shopId]);
    await pool.query(
      `INSERT INTO document_lines (document_id, line_no, item_id, size_normalized, quantity, mapping_status, review_status)
       VALUES ($1,1,$2,'26',5,'USER_CONFIRMED','REVIEWED')`, [d.rows[0].id, itemId]);

    const { postDocument } = await import('@/src/lib/pipeline/post');
    const out = await postDocument(d.rows[0].id, core.userId);
    expect(out.status).toBe('POSTED');
    expect(await stock(itemId, '26')).toBe(15);
  });

  it('13. A sale that would take stock below zero is blocked, with the reason recorded', async () => {
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const { postMovements, NegativeStockError } = await import('@/src/lib/domain/ledger');
    const { withTx } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'OPENING', itemId, size: '28', locationId: core.shopId, qty: 2,
      businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    await expect(withTx((c) => postMovements(c, [{
      movementType: 'POS_SALE', itemId, size: '28', locationId: core.shopId, qty: -5,
      businessDate: '2026-08-02', sourceType: 'TEST',
    }]))).rejects.toThrowError(NegativeStockError);
    expect(await stock(itemId, '28')).toBe(2);
  });

  it('14. A godown → shop transfer nets to zero across the business', async () => {
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const { postMovements, postTransfer } = await import('@/src/lib/domain/ledger');
    const { withTx, q1 } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'OPENING', itemId, size: '28', locationId: core.godownId, qty: 30,
      businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    await withTx((c) => postTransfer(c, {
      itemId, size: '28', qty: 10, businessDate: '2026-08-04',
      fromLocationId: core.godownId, toLocationId: core.shopId, sourceType: 'TRANSFER_LINE',
    }));
    const shop = await q1<{ qty: number }>(
      `SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_movements WHERE item_id=$1 AND location_id=$2`, [itemId, core.shopId]);
    expect(shop?.qty).toBe(10);
    expect(await stock(itemId, '28')).toBe(30); // total unchanged
  });

  it('15. A mistaken posting is undone by a reversal, and both entries remain visible', async () => {
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const { postMovements, reverseMovement } = await import('@/src/lib/domain/ledger');
    const { withTx, q, q1 } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'SUPPLIER_RECEIPT', itemId, size: '28', locationId: core.shopId, qty: 10,
      businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    const orig = (await q1<{ id: string }>(`SELECT id FROM inventory_movements LIMIT 1`))!;
    await withTx((c) => reverseMovement(c, orig.id, core.userId, 'Posted the wrong paper'));
    expect(await stock(itemId, '28')).toBe(0);
    expect(await q(`SELECT id FROM inventory_movements`)).toHaveLength(2);
  });

  it('16. POS sales import once; a re-import of the same file changes nothing', async () => {
    const itemId = await makeItem('IU-A', 'Item A', ['28']);
    const { getPool, withTx } = await import('@/src/lib/db');
    await getPool().query(`UPDATE item_sizes SET pos_code='7000028' WHERE item_id=$1`, [itemId]);
    const { postMovements } = await import('@/src/lib/domain/ledger');
    await withTx((c) => postMovements(c, [{
      movementType: 'OPENING', itemId, size: '28', locationId: core.shopId, qty: 20,
      businessDate: '2026-08-01', sourceType: 'TEST',
    }]));

    const { previewPosImport, commitPosImport } = await import('@/src/lib/importers/posImport');
    const file = Buffer.from('Bill Date,Bill No,Item Code,Qty\n05-08-2026,B-1,7000028,4\n', 'utf8');
    const map = { date: 'Bill Date', receiptNo: 'Bill No', posCode: 'Item Code', quantity: 'Qty' };
    const p = await previewPosImport(file, 'pos.csv', map, core.userId);
    await commitPosImport(p.importId, core.userId);
    expect(await stock(itemId, '28')).toBe(16);

    const again = await previewPosImport(file, 'pos-again.csv', map, core.userId);
    expect(again.alreadyImportedFile).toBe(true);
    expect(await stock(itemId, '28')).toBe(16);
    // Row-level overlap and returns: tests/posImport.test.ts
  });

  it('17. The same photo sent twice is flagged as a duplicate, not counted twice', async () => {
    const { ingestImages } = await import('@/src/lib/pipeline/ingest');
    const buffer = await jpeg();
    const a = await ingestImages({ files: [{ buffer, filename: 'sarda_challan.jpg' }], source: 'TELEGRAM',
      telegram: { chatId: 'g', messageId: '1', uploader: 'Papa' } });
    const b = await ingestImages({ files: [{ buffer, filename: 'sarda_challan.jpg' }], source: 'TELEGRAM',
      telegram: { chatId: 'g', messageId: '2', uploader: 'Mummy' } });
    expect(b.duplicate).toBe(true);
    expect(b.duplicateOfRef).toBe(a.refNo);
  });

  it('18. A supplier wording learned once maps itself on the next paper', async () => {
    const supplierId = await makeSupplier('SANJAY', 'Sanjay Dresses');
    const itemId = await makeItem('IU-NB-HPTC', 'Navy Blue Half Pant T.C.', ['12/14', '15', '16', '17']);
    const { getPool, q } = await import('@/src/lib/db');
    await getPool().query(
      `INSERT INTO supplier_item_aliases (supplier_id, supplier_description, item_id, status, mapping_confidence)
       VALUES ($1,'N.BLUE H.P.T.C. BHARI',$2,'USER_CONFIRMED',1.0)`, [supplierId, itemId]);
    const id = await intake('sanjay_invoice_1873.jpg');
    const mapped = await q(
      `SELECT id FROM document_lines WHERE document_id=$1 AND item_id=$2 AND mapping_status='USER_CONFIRMED'`,
      [id, itemId]);
    expect(mapped.length).toBeGreaterThan(0);
  });

  it('19. An order not delivered by its expected date is flagged as overdue', async () => {
    const supplierId = await makeSupplier('GMK', 'GMK');
    const itemId = await makeItem('IU-KITE', 'Scout Kite Kit', ['FREE']);
    const { getPool, q } = await import('@/src/lib/db');
    const po = await getPool().query(
      `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, status)
       VALUES ($1, CURRENT_DATE-40, CURRENT_DATE-20, 'OPEN') RETURNING id`, [supplierId]);
    await getPool().query(
      `INSERT INTO purchase_order_lines (po_id, line_no, item_id, description_raw, size, quantity_ordered)
       VALUES ($1,1,$2,'Scout Kite','FREE',40)`, [po.rows[0].id, itemId]);
    const { scanOverdueOrders } = await import('@/src/lib/pipeline/recon');
    await scanOverdueOrders();
    const f = await q<{ type: string }>(`SELECT type FROM findings WHERE status='OPEN'`);
    expect(f.some((x) => x.type === 'ORDER_OVERDUE')).toBe(true);
  });

  it('20. Item 360 shows one item’s stock, orders, papers and history together', async () => {
    const supplierId = await makeSupplier('S1', 'Supplier One');
    const itemId = await makeItem('IU-A', 'Item A', ['28', '30']);
    const docId = await makeReceiptDoc('SUPPLIER_DELIVERY_CHALLAN', '2026-08-05', supplierId, [{ itemId, size: '28', qty: 10 }]);
    const { postDocument } = await import('@/src/lib/pipeline/post');
    await postDocument(docId, core.userId);
    const { getPool } = await import('@/src/lib/db');
    const po = await getPool().query(
      `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, status)
       VALUES ($1, CURRENT_DATE-5, CURRENT_DATE+5, 'OPEN') RETURNING id`, [supplierId]);
    await getPool().query(
      `INSERT INTO purchase_order_lines (po_id, line_no, item_id, description_raw, size, quantity_ordered)
       VALUES ($1,1,$2,'Item A','30',25)`, [po.rows[0].id, itemId]);

    const { getItem360 } = await import('@/src/lib/item360');
    const view = (await getItem360(itemId))!;
    expect(view.item.code).toBe('IU-A');
    expect(view.stock.find((s) => s.size === '28')?.SHOP).toBe(10);
    expect(view.onOrder.find((o) => o.size === '30')?.qty).toBe(25);
    expect(view.documents.length).toBe(1);
    expect(view.movements.length).toBe(1);
  });
});
