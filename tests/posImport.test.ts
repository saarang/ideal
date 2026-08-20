/**
 * POS sales import: the same file, and the same bill line inside two files,
 * must never reduce stock twice. Returns add stock back; rows whose item
 * cannot be matched are reported, not guessed.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedCore, makeItem, closeDb, CoreIds } from './helpers/db';

let core: CoreIds;
let itemId: string;

const HEADERS = 'Bill Date,Bill No,Item Code,Qty,Rate,Net Amount,Type';

function csv(rows: string[]): Buffer {
  return Buffer.from([HEADERS, ...rows].join('\n'), 'utf8');
}

beforeEach(async () => {
  await resetDb();
  core = await seedCore();
  itemId = await makeItem('IU-SHIRT', 'White School Shirt', ['28', '30']);
  const { getPool } = await import('@/src/lib/db');
  const pool = getPool();
  await pool.query(`UPDATE item_sizes SET pos_code='1000028' WHERE item_id=$1 AND size='28'`, [itemId]);
  await pool.query(`UPDATE item_sizes SET pos_code='1000030' WHERE item_id=$1 AND size='30'`, [itemId]);
  // Opening stock so sales do not hit the negative-stock block.
  const { postMovements } = await import('@/src/lib/domain/ledger');
  const { withTx } = await import('@/src/lib/db');
  await withTx((c) => postMovements(c, [
    { movementType: 'OPENING', itemId, size: '28', locationId: core.shopId, qty: 50, businessDate: '2026-08-01', sourceType: 'TEST' },
    { movementType: 'OPENING', itemId, size: '30', locationId: core.shopId, qty: 50, businessDate: '2026-08-01', sourceType: 'TEST' },
  ]));
});
afterAll(async () => { await closeDb(); });

const MAP = {
  date: 'Bill Date', receiptNo: 'Bill No', posCode: 'Item Code',
  quantity: 'Qty', rate: 'Rate', netAmount: 'Net Amount', type: 'Type',
};

async function stock(size: string): Promise<number> {
  const { q1 } = await import('@/src/lib/db');
  const r = await q1<{ qty: number }>(
    `SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_movements WHERE item_id=$1 AND size=$2`, [itemId, size]);
  return r?.qty ?? 0;
}

describe('POS import', () => {
  it('previews, posts sales as stock going out, and matches items by POS code', async () => {
    const { previewPosImport, commitPosImport } = await import('@/src/lib/importers/posImport');
    const file = csv([
      '05-08-2026,B-101,1000028,3,450,1350,SALE',
      '05-08-2026,B-102,1000030,2,470,940,SALE',
    ]);
    const preview = await previewPosImport(file, 'sales-05-08.csv', MAP, core.userId);
    expect(preview.totalRows).toBe(2);
    expect(preview.okRows).toBe(2);
    expect(preview.errorRows).toBe(0);
    expect(preview.rows[0].itemName).toBe('White School Shirt');

    const result = await commitPosImport(preview.importId, core.userId);
    expect(result.posted).toBe(2);
    expect(await stock('28')).toBe(47);
    expect(await stock('30')).toBe(48);
  });

  it('refuses to import the very same file twice', async () => {
    const { previewPosImport, commitPosImport } = await import('@/src/lib/importers/posImport');
    const file = csv(['05-08-2026,B-101,1000028,3,450,1350,SALE']);
    const first = await previewPosImport(file, 'sales.csv', MAP, core.userId);
    await commitPosImport(first.importId, core.userId);
    expect(await stock('28')).toBe(47);

    const again = await previewPosImport(file, 'sales-copy.csv', MAP, core.userId);
    expect(again.alreadyImportedFile).toBe(true);
    expect(await stock('28')).toBe(47);
  });

  it('skips a bill line that was already posted from an earlier, overlapping file', async () => {
    const { previewPosImport, commitPosImport } = await import('@/src/lib/importers/posImport');
    const day1 = csv(['05-08-2026,B-101,1000028,3,450,1350,SALE']);
    const p1 = await previewPosImport(day1, 'day1.csv', MAP, core.userId);
    await commitPosImport(p1.importId, core.userId);

    // Second export overlaps by one row and adds a new one.
    const overlap = csv([
      '05-08-2026,B-101,1000028,3,450,1350,SALE',   // already posted
      '06-08-2026,B-115,1000028,2,450,900,SALE',    // new
    ]);
    const p2 = await previewPosImport(overlap, 'day1-2.csv', MAP, core.userId);
    expect(p2.duplicateRows).toBe(1);
    const r2 = await commitPosImport(p2.importId, core.userId);
    expect(r2.posted).toBe(1);
    expect(r2.skippedDuplicates).toBe(1);
    expect(await stock('28')).toBe(50 - 3 - 2);
  });

  it('flags duplicate rows inside one file', async () => {
    const { previewPosImport } = await import('@/src/lib/importers/posImport');
    const file = csv([
      '05-08-2026,B-101,1000028,3,450,1350,SALE',
      '05-08-2026,B-101,1000028,3,450,1350,SALE',
    ]);
    const p = await previewPosImport(file, 'dupe.csv', MAP, core.userId);
    expect(p.duplicateRows).toBe(1);
    expect(p.okRows).toBe(1);
  });

  it('a return adds stock back', async () => {
    const { previewPosImport, commitPosImport } = await import('@/src/lib/importers/posImport');
    const file = csv([
      '05-08-2026,B-101,1000028,3,450,1350,SALE',
      '06-08-2026,CN-9,1000028,1,450,450,RETURN',
    ]);
    const p = await previewPosImport(file, 'with-return.csv', MAP, core.userId);
    expect(p.rows[1].isReturn).toBe(true);
    await commitPosImport(p.importId, core.userId);
    expect(await stock('28')).toBe(50 - 3 + 1);
  });

  it('reports rows whose item cannot be matched instead of guessing', async () => {
    const { previewPosImport, commitPosImport } = await import('@/src/lib/importers/posImport');
    const file = csv([
      '05-08-2026,B-101,9999999,3,450,1350,SALE',   // unknown POS code
      '05-08-2026,B-102,1000028,2,450,900,SALE',
    ]);
    const p = await previewPosImport(file, 'partial.csv', MAP, core.userId);
    expect(p.errorRows).toBe(1);
    expect(p.rows[0].problem).toBeTruthy();
    expect(p.rows[0].itemId).toBeNull();

    const r = await commitPosImport(p.importId, core.userId);
    expect(r.posted).toBe(1);          // the good row still posts
    expect(await stock('28')).toBe(48);
  });

  it('guessColumnMap recognises common VasyERP headers', async () => {
    const { guessColumnMap } = await import('@/src/lib/importers/posImport');
    const m = guessColumnMap(HEADERS.split(','));
    expect(m.quantity).toBe('Qty');
    expect(m.posCode).toBe('Item Code');
    expect(m.date).toBe('Bill Date');
    expect(m.receiptNo).toBe('Bill No');
  });
});
