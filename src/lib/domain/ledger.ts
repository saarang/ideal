/**
 * Inventory ledger — the source of truth for stock.
 *
 * Movements are append-only (enforced by a DB trigger). One source line can
 * post at most once per location (unique index). Negative stock follows the
 * configured policy inside the same transaction as the insert, serialised by
 * advisory locks per (item, size, location).
 */
import crypto from 'crypto';
import { PoolClient } from 'pg';
import { dq, dq1 } from '../db';
import { getSettings } from '../settings';

export type MovementType =
  | 'OPENING' | 'SUPPLIER_RECEIPT' | 'POS_SALE' | 'POS_RETURN'
  | 'CUSTOMER_ISSUE' | 'CUSTOMER_RETURN' | 'TRANSFER_OUT' | 'TRANSFER_IN'
  | 'SUPPLIER_RETURN' | 'ADJUSTMENT' | 'REVERSAL';

export interface MovementInput {
  movementType: MovementType;
  itemId: string;
  size: string;
  locationId: string;
  qty: number;                 // signed; + into location, − out
  businessDate: string;        // YYYY-MM-DD
  sourceType: string;          // DOCUMENT_LINE / POS_SALE / TRANSFER_LINE / IMPORT / MANUAL / REVERSAL
  sourceId?: string | null;
  sourceLineId?: string | null;
  transferGroupId?: string | null;
  reversalOfId?: string | null;
  reason?: string | null;
  createdBy?: string | null;
}

export class NegativeStockError extends Error {
  constructor(
    public readonly detail: { itemId: string; size: string; locationId: string; resulting: number; attempted: number },
  ) {
    super(`Posting would make stock negative (${detail.resulting}) for item ${detail.itemId} size ${detail.size}`);
    this.name = 'NegativeStockError';
  }
}

function lockKey(itemId: string, size: string, locationId: string): bigint {
  const h = crypto.createHash('sha256').update(`${itemId}|${size}|${locationId}`).digest();
  return h.readBigInt64BE(0);
}

export interface PostResult {
  inserted: number;
  skippedDuplicates: number;
  negativeWarnings: { itemId: string; size: string; locationId: string; resulting: number }[];
}

/**
 * Post movements atomically. Must be called inside a transaction (client).
 * Throws NegativeStockError (rolling back) when policy is BLOCK and any
 * outgoing movement would push a balance below zero.
 */
export async function postMovements(client: PoolClient, movements: MovementInput[]): Promise<PostResult> {
  const settings = await getSettings(client);
  const policy = settings.negative_stock_policy ?? 'BLOCK';
  let inserted = 0;
  let skipped = 0;
  const negativeWarnings: PostResult['negativeWarnings'] = [];

  // Deterministic lock order avoids deadlocks between concurrent posters.
  const keys = [...new Set(movements.map((m) => `${m.itemId}|${m.size}|${m.locationId}`))].sort();
  for (const k of keys) {
    const [i, s, l] = k.split('|');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(i, s, l).toString()]);
  }

  for (const m of movements) {
    if (!Number.isInteger(m.qty) || m.qty === 0) throw new Error(`Invalid movement qty ${m.qty}`);
    const res = await client.query(
      `INSERT INTO inventory_movements
        (movement_type, item_id, size, location_id, qty, business_date,
         source_type, source_id, source_line_id, transfer_group_id, reversal_of_id, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (source_type, source_line_id, location_id) WHERE source_line_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [m.movementType, m.itemId, m.size, m.locationId, m.qty, m.businessDate,
       m.sourceType, m.sourceId ?? null, m.sourceLineId ?? null,
       m.transferGroupId ?? null, m.reversalOfId ?? null, m.reason ?? null, m.createdBy ?? null]);
    if (res.rowCount === 0) { skipped++; continue; }
    inserted++;

    if (m.qty < 0) {
      const bal = await dq1<{ qty: number }>(client,
        `SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_movements
         WHERE item_id=$1 AND size=$2 AND location_id=$3`,
        [m.itemId, m.size, m.locationId]);
      const resulting = bal?.qty ?? 0;
      if (resulting < 0) {
        if (policy === 'BLOCK') {
          throw new NegativeStockError({ itemId: m.itemId, size: m.size, locationId: m.locationId, resulting, attempted: m.qty });
        }
        negativeWarnings.push({ itemId: m.itemId, size: m.size, locationId: m.locationId, resulting });
      }
    }
  }
  return { inserted, skippedDuplicates: skipped, negativeWarnings };
}

/** Two linked legs, net zero across the business. Call inside a transaction. */
export async function postTransfer(
  client: PoolClient,
  args: {
    itemId: string; size: string; qty: number; businessDate: string;
    fromLocationId: string; toLocationId: string;
    sourceType: string; sourceId?: string | null; sourceLineId?: string | null;
    createdBy?: string | null; reason?: string | null;
  },
): Promise<PostResult> {
  if (args.qty <= 0) throw new Error('Transfer quantity must be positive');
  const groupId = crypto.randomUUID();
  return postMovements(client, [
    {
      movementType: 'TRANSFER_OUT', itemId: args.itemId, size: args.size,
      locationId: args.fromLocationId, qty: -args.qty, businessDate: args.businessDate,
      sourceType: args.sourceType, sourceId: args.sourceId, sourceLineId: args.sourceLineId,
      transferGroupId: groupId, createdBy: args.createdBy, reason: args.reason,
    },
    {
      movementType: 'TRANSFER_IN', itemId: args.itemId, size: args.size,
      locationId: args.toLocationId, qty: args.qty, businessDate: args.businessDate,
      sourceType: args.sourceType, sourceId: args.sourceId, sourceLineId: args.sourceLineId,
      transferGroupId: groupId, createdBy: args.createdBy, reason: args.reason,
    },
  ]);
}

/**
 * Reverse a posted movement by creating an equal-and-opposite entry.
 * The original is never edited (append-only trigger enforces this).
 */
export async function reverseMovement(
  client: PoolClient,
  movementId: string,
  userId: string | null,
  reason: string,
): Promise<string> {
  const orig = await dq1<any>(client, 'SELECT * FROM inventory_movements WHERE id=$1', [movementId]);
  if (!orig) throw new Error('Movement not found');
  const already = await dq1(client, 'SELECT id FROM inventory_movements WHERE reversal_of_id=$1', [movementId]);
  if (already) throw new Error('Movement already reversed');
  const res = await postMovements(client, [{
    movementType: 'REVERSAL',
    itemId: orig.item_id, size: orig.size, locationId: orig.location_id,
    qty: -orig.qty,
    businessDate: new Date().toISOString().slice(0, 10),
    sourceType: 'REVERSAL', sourceId: orig.id, sourceLineId: orig.id,
    reversalOfId: orig.id, reason, createdBy: userId,
  }]);
  if (res.inserted !== 1) throw new Error('Reversal was not inserted (duplicate?)');
  const row = await dq1<{ id: string }>(client, 'SELECT id FROM inventory_movements WHERE reversal_of_id=$1', [movementId]);
  return row!.id;
}

export async function stockFor(client: PoolClient | import('pg').Pool, itemId: string, size?: string) {
  return dq<{ size: string; location_code: string; qty: number }>(client,
    `SELECT m.size, l.code AS location_code, SUM(m.qty)::int AS qty
     FROM inventory_movements m JOIN locations l ON l.id = m.location_id
     WHERE m.item_id = $1 ${size ? 'AND m.size = $2' : ''}
     GROUP BY m.size, l.code ORDER BY m.size, l.code`,
    size ? [itemId, size] : [itemId]);
}
