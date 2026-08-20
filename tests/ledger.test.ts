/**
 * The stock ledger: append-only, idempotent per source line, transfers net to
 * zero, mistakes are reversed (never edited), and BLOCK policy refuses to go
 * below zero.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedCore, makeItem, closeDb, CoreIds } from './helpers/db';

let core: CoreIds;
let itemId: string;

beforeEach(async () => {
  await resetDb();
  core = await seedCore();
  itemId = await makeItem('IU-TEST', 'Test Half Pant', ['28', '30']);
});
afterAll(async () => { await closeDb(); });

async function withTx<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const { withTx } = await import('@/src/lib/db');
  return withTx(fn);
}
async function balance(size: string, locationId: string): Promise<number> {
  const { q1 } = await import('@/src/lib/db');
  const r = await q1<{ qty: number }>(
    `SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_movements WHERE item_id=$1 AND size=$2 AND location_id=$3`,
    [itemId, size, locationId]);
  return r?.qty ?? 0;
}

describe('postMovements', () => {
  it('posts a receipt and the balance shows it', async () => {
    const { postMovements } = await import('@/src/lib/domain/ledger');
    await withTx((c) => postMovements(c, [{
      movementType: 'SUPPLIER_RECEIPT', itemId, size: '28', locationId: core.shopId,
      qty: 10, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    expect(await balance('28', core.shopId)).toBe(10);
  });

  it('is idempotent per source line: re-posting the same document line inserts nothing', async () => {
    const { postMovements } = await import('@/src/lib/domain/ledger');
    const { q1 } = await import('@/src/lib/db');
    // A real document line id to satisfy the FK-free unique index semantics.
    const lineId = (await q1<{ id: string }>(`SELECT gen_random_uuid() AS id`))!.id;
    const move = {
      movementType: 'SUPPLIER_RECEIPT' as const, itemId, size: '28', locationId: core.shopId,
      qty: 10, businessDate: '2026-08-01', sourceType: 'DOCUMENT_LINE', sourceLineId: lineId,
    };
    const first = await withTx((c) => postMovements(c, [move]));
    const second = await withTx((c) => postMovements(c, [move]));
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicates).toBe(1);
    expect(await balance('28', core.shopId)).toBe(10);
  });

  it('BLOCK policy refuses to take stock below zero and rolls back', async () => {
    const { postMovements, NegativeStockError } = await import('@/src/lib/domain/ledger');
    await withTx((c) => postMovements(c, [{
      movementType: 'SUPPLIER_RECEIPT', itemId, size: '28', locationId: core.shopId,
      qty: 3, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    await expect(withTx((c) => postMovements(c, [{
      movementType: 'POS_SALE', itemId, size: '28', locationId: core.shopId,
      qty: -5, businessDate: '2026-08-02', sourceType: 'TEST',
    }]))).rejects.toThrowError(NegativeStockError);
    expect(await balance('28', core.shopId)).toBe(3); // the failed sale left no trace
  });

  it('WARN_ALLOW posts below zero but reports the warning', async () => {
    const { setSetting } = await import('@/src/lib/settings');
    const { getPool } = await import('@/src/lib/db');
    await setSetting(getPool(), 'negative_stock_policy', 'WARN_ALLOW');
    const { postMovements } = await import('@/src/lib/domain/ledger');
    const r = await withTx((c) => postMovements(c, [{
      movementType: 'POS_SALE', itemId, size: '30', locationId: core.shopId,
      qty: -2, businessDate: '2026-08-02', sourceType: 'TEST',
    }]));
    expect(r.negativeWarnings).toHaveLength(1);
    expect(r.negativeWarnings[0].resulting).toBe(-2);
    expect(await balance('30', core.shopId)).toBe(-2);
  });
});

describe('postTransfer', () => {
  it('moves stock shop → godown with two linked legs netting to zero', async () => {
    const { postMovements, postTransfer } = await import('@/src/lib/domain/ledger');
    const { q } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'OPENING', itemId, size: '28', locationId: core.shopId,
      qty: 8, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    await withTx((c) => postTransfer(c, {
      itemId, size: '28', qty: 5, businessDate: '2026-08-03',
      fromLocationId: core.shopId, toLocationId: core.godownId,
      sourceType: 'TRANSFER_LINE', reason: 'Test transfer',
    }));
    expect(await balance('28', core.shopId)).toBe(3);
    expect(await balance('28', core.godownId)).toBe(5);
    const legs = await q<{ qty: number; transfer_group_id: string }>(
      `SELECT qty, transfer_group_id FROM inventory_movements WHERE movement_type IN ('TRANSFER_OUT','TRANSFER_IN') ORDER BY qty`);
    expect(legs).toHaveLength(2);
    expect(legs[0].qty + legs[1].qty).toBe(0);
    expect(legs[0].transfer_group_id).toBe(legs[1].transfer_group_id);
  });

  it('cannot transfer more than the shop holds under BLOCK', async () => {
    const { postMovements, postTransfer, NegativeStockError } = await import('@/src/lib/domain/ledger');
    await withTx((c) => postMovements(c, [{
      movementType: 'OPENING', itemId, size: '28', locationId: core.shopId,
      qty: 2, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    await expect(withTx((c) => postTransfer(c, {
      itemId, size: '28', qty: 5, businessDate: '2026-08-03',
      fromLocationId: core.shopId, toLocationId: core.godownId,
      sourceType: 'TRANSFER_LINE',
    }))).rejects.toThrowError(NegativeStockError);
    expect(await balance('28', core.shopId)).toBe(2);
    expect(await balance('28', core.godownId)).toBe(0);
  });
});

describe('reverseMovement', () => {
  it('cancels a line with an opposite entry; both stay on the register', async () => {
    const { postMovements, reverseMovement } = await import('@/src/lib/domain/ledger');
    const { q, q1 } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'SUPPLIER_RECEIPT', itemId, size: '28', locationId: core.shopId,
      qty: 10, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    const orig = (await q1<{ id: string }>(`SELECT id FROM inventory_movements LIMIT 1`))!;
    await withTx((c) => reverseMovement(c, orig.id, core.userId, 'Wrong paper posted'));
    expect(await balance('28', core.shopId)).toBe(0);
    const rows = await q<{ movement_type: string; qty: number; reversal_of_id: string | null }>(
      `SELECT movement_type, qty, reversal_of_id FROM inventory_movements ORDER BY created_at`);
    expect(rows).toHaveLength(2);
    expect(rows[1].movement_type).toBe('REVERSAL');
    expect(rows[1].qty).toBe(-10);
    expect(rows[1].reversal_of_id).toBe(orig.id);
  });

  it('refuses to reverse the same movement twice', async () => {
    const { postMovements, reverseMovement } = await import('@/src/lib/domain/ledger');
    const { q1 } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'SUPPLIER_RECEIPT', itemId, size: '28', locationId: core.shopId,
      qty: 4, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    const orig = (await q1<{ id: string }>(`SELECT id FROM inventory_movements LIMIT 1`))!;
    await withTx((c) => reverseMovement(c, orig.id, core.userId, 'first'));
    await expect(withTx((c) => reverseMovement(c, orig.id, core.userId, 'second')))
      .rejects.toThrow(/already/i);
    expect(await balance('28', core.shopId)).toBe(0);
  });
});

describe('append-only guarantee', () => {
  it('UPDATE and DELETE on inventory_movements are refused by the database itself', async () => {
    const { postMovements } = await import('@/src/lib/domain/ledger');
    const { getPool } = await import('@/src/lib/db');
    await withTx((c) => postMovements(c, [{
      movementType: 'SUPPLIER_RECEIPT', itemId, size: '28', locationId: core.shopId,
      qty: 6, businessDate: '2026-08-01', sourceType: 'TEST',
    }]));
    const pool = getPool();
    await expect(pool.query(`UPDATE inventory_movements SET qty = 99`)).rejects.toThrow(/append-only|not allowed|forbid/i);
    await expect(pool.query(`DELETE FROM inventory_movements`)).rejects.toThrow(/append-only|not allowed|forbid/i);
    expect(await balance('28', core.shopId)).toBe(6);
  });
});
