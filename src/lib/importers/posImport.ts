/**
 * POS sales import (VasyERP export or any CSV/Excel with the same facts).
 *
 * Flow: upload → column mapping (template remembered) → preview with row-level
 * checks → commit. Committing posts POS_SALE (−) / POS_RETURN (+) movements at
 * SHOP. Protection against double counting sits at three levels: the file hash
 * (same file can't be imported twice), a per-row dedup key (same bill line
 * can't post twice even from a different file), and the ledger's own
 * source-line uniqueness.
 */
import crypto from 'crypto';
import { getPool, dq, dq1, withTx } from '../db';
import { parseTabular, parseIntStrict, parseMoney, parseImportDate } from './csv';
import { postMovements, NegativeStockError } from '../domain/ledger';
import { raiseFinding } from '../domain/findings';

export interface PosColumnMap {
  date?: string;
  receiptNo?: string;
  posCode?: string;        // preferred: the 7-digit VasyERP item code (size embedded)
  itemCode?: string;       // alternative: Ideal item code column
  size?: string;
  quantity: string;
  rate?: string;
  discount?: string;
  tax?: string;
  netAmount?: string;
  type?: string;           // column containing SALE/RETURN markers
}

export interface PosPreviewRow {
  rowNo: number;
  saleDate: string | null;
  receiptNo: string | null;
  posCode: string | null;
  itemId: string | null;
  itemName: string | null;
  size: string | null;
  quantity: number | null;
  isReturn: boolean;
  netAmount: number | null;
  dedupKey: string;
  problem: string | null;   // null = importable
  duplicate: boolean;
}

export interface PosPreview {
  importId: string;
  filename: string;
  headers: string[];
  totalRows: number;
  okRows: number;
  errorRows: number;
  duplicateRows: number;
  rows: PosPreviewRow[];
  alreadyImportedFile: boolean;
}

const SETTINGS_TEMPLATE_KEY = 'pos_import_template';

export async function savedTemplate(): Promise<PosColumnMap | null> {
  const row = await dq1<{ value: PosColumnMap }>(getPool(),
    `SELECT value FROM system_settings WHERE key=$1`, [SETTINGS_TEMPLATE_KEY]);
  return row?.value ?? null;
}

/** Best-effort auto-mapping from common VasyERP header names. */
export function guessColumnMap(headers: string[]): PosColumnMap {
  const find = (...cands: string[]) =>
    headers.find((h) => cands.some((c) => h.toLowerCase().replace(/[^a-z]/g, '').includes(c))) ?? undefined;
  return {
    date: find('billdate', 'invoicedate', 'date'),
    receiptNo: find('billno', 'invoiceno', 'receiptno', 'voucherno'),
    posCode: find('itemcode', 'productcode', 'barcode'),
    size: find('size'),
    quantity: find('qty', 'quantity') ?? headers[0],
    rate: find('rate', 'price'),
    discount: find('discount', 'disc'),
    tax: find('gst', 'tax'),
    netAmount: find('netamount', 'total', 'amount'),
    type: find('type', 'transactiontype', 'saletype'),
  };
}

function rowDedupKey(r: { saleDate: string | null; receiptNo: string | null; posCode: string | null; size: string | null; quantity: number | null; isReturn: boolean }): string {
  const raw = [r.saleDate ?? '', r.receiptNo ?? '', r.posCode ?? '', r.size ?? '', r.quantity ?? '', r.isReturn ? 'R' : 'S'].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

async function resolveItem(posCode: string | null, itemCode: string | null, size: string | null):
  Promise<{ itemId: string; itemName: string; size: string } | null> {
  const pool = getPool();
  if (posCode) {
    const bySize = await dq1<{ item_id: string; size: string; name: string }>(pool,
      `SELECT isz.item_id, isz.size, i.name
       FROM item_sizes isz JOIN items i ON i.id = isz.item_id
       WHERE isz.pos_code = $1 LIMIT 1`, [posCode]);
    if (bySize) return { itemId: bySize.item_id, itemName: bySize.name, size: bySize.size };
  }
  if (itemCode && size) {
    const byCode = await dq1<{ id: string; name: string }>(pool,
      `SELECT id, name FROM items WHERE code = $1`, [itemCode]);
    if (byCode) {
      const s = await dq1<{ size: string }>(pool,
        `SELECT size FROM item_sizes WHERE item_id=$1 AND size=$2`, [byCode.id, size]);
      if (s) return { itemId: byCode.id, itemName: byCode.name, size: s.size };
    }
  }
  return null;
}

/** Parse + validate a POS file and store the preview. Nothing posts yet. */
export async function previewPosImport(
  buffer: Buffer, filename: string, map: PosColumnMap, userId: string | null, isDemo = false,
): Promise<PosPreview> {
  const pool = getPool();
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');

  const existingFile = await dq1<{ id: string; status: string }>(pool,
    `SELECT id, status FROM pos_imports WHERE file_sha256=$1`, [sha]);
  if (existingFile && existingFile.status === 'POSTED') {
    return {
      importId: existingFile.id, filename, headers: [], totalRows: 0, okRows: 0,
      errorRows: 0, duplicateRows: 0, rows: [], alreadyImportedFile: true,
    };
  }

  const table = parseTabular(buffer, filename);
  if (!map.quantity || !table.headers.includes(map.quantity)) {
    throw new Error('Choose which column holds the quantity before previewing.');
  }

  // Reuse a PREVIEW-state import for the same file, else create one.
  let importId = existingFile?.id;
  if (importId) {
    await dq(pool, `DELETE FROM pos_sales WHERE import_id=$1`, [importId]);
    await dq(pool, `UPDATE pos_imports SET template=$2, filename=$3, row_count=0, ok_count=0, error_count=0 WHERE id=$1`,
      [importId, JSON.stringify(map), filename]);
  } else {
    const created = await dq1<{ id: string }>(pool,
      `INSERT INTO pos_imports (filename, file_sha256, template, imported_by, is_demo)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [filename, sha, JSON.stringify(map), userId, isDemo]);
    importId = created!.id;
  }

  await dq(pool, `INSERT INTO system_settings (key, value, updated_by) VALUES ($1,$2,$3)
                  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [SETTINGS_TEMPLATE_KEY, JSON.stringify(map), userId]);

  const rows: PosPreviewRow[] = [];
  let ok = 0, errs = 0, dups = 0;
  const seenInFile = new Set<string>();

  for (let i = 0; i < table.rows.length; i++) {
    const src = table.rows[i];
    const get = (col?: string) => (col ? (src[col] ?? '').trim() : '');
    const qtyRaw = parseIntStrict(get(map.quantity));
    const typeVal = get(map.type).toUpperCase();
    const isReturn = typeVal.includes('RETURN') || typeVal.includes('CR') || (qtyRaw != null && qtyRaw < 0);
    const quantity = qtyRaw == null ? null : Math.abs(qtyRaw);
    const saleDate = parseImportDate(get(map.date)) ?? null;
    const posCode = get(map.posCode) || null;
    const itemCode = get(map.itemCode) || null;
    const sizeCol = get(map.size) || null;

    let problem: string | null = null;
    let itemId: string | null = null, itemName: string | null = null, size: string | null = sizeCol;

    if (quantity == null || quantity === 0) problem = 'Quantity is missing or zero.';
    else {
      const resolved = await resolveItem(posCode, itemCode, sizeCol);
      if (!resolved) {
        problem = posCode
          ? `POS code ${posCode} is not linked to any item size.`
          : 'Row has no POS code and no item code + size that matches the item master.';
      } else {
        itemId = resolved.itemId; itemName = resolved.itemName; size = resolved.size;
      }
    }
    if (!saleDate && !problem) problem = 'Sale date is missing or unreadable.';

    const dedupKey = rowDedupKey({ saleDate, receiptNo: get(map.receiptNo) || null, posCode, size, quantity, isReturn });
    let duplicate = false;
    if (!problem) {
      if (seenInFile.has(dedupKey)) duplicate = true;
      else {
        const prior = await dq1<{ n: number }>(pool,
          `SELECT count(*)::int AS n FROM pos_sales WHERE dedup_key=$1 AND status='POSTED'`, [dedupKey]);
        duplicate = (prior?.n ?? 0) > 0;
      }
      seenInFile.add(dedupKey);
    }

    if (problem) errs++; else if (duplicate) dups++; else ok++;

    await dq(pool,
      `INSERT INTO pos_sales (import_id, row_no, sale_date, receipt_no, pos_item_code, item_id, size,
         quantity, rate, discount, tax, net_amount, is_return, dedup_key, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [importId, i + 1, saleDate, get(map.receiptNo) || null, posCode, itemId, size,
       quantity, parseMoney(get(map.rate)), parseMoney(get(map.discount)), parseMoney(get(map.tax)),
       parseMoney(get(map.netAmount)), isReturn, dedupKey,
       problem ? 'ERROR' : duplicate ? 'SKIPPED_DUPLICATE' : 'PENDING', problem]);

    rows.push({
      rowNo: i + 1, saleDate, receiptNo: get(map.receiptNo) || null, posCode,
      itemId, itemName, size, quantity, isReturn, netAmount: parseMoney(get(map.netAmount)),
      dedupKey, problem, duplicate,
    });
  }

  await dq(pool, `UPDATE pos_imports SET row_count=$2, ok_count=$3, error_count=$4 WHERE id=$1`,
    [importId, table.rows.length, ok, errs]);

  return {
    importId: importId!, filename, headers: table.headers, totalRows: table.rows.length,
    okRows: ok, errorRows: errs, duplicateRows: dups, rows, alreadyImportedFile: false,
  };
}

export interface PosCommitResult {
  posted: number; blocked: number; skippedDuplicates: number; errors: number;
}

/** Post all PENDING rows of a previewed import to the ledger at SHOP. */
export async function commitPosImport(importId: string, userId: string | null): Promise<PosCommitResult> {
  const pool = getPool();
  const imp = await dq1<{ id: string; status: string; filename: string }>(pool,
    `SELECT id, status, filename FROM pos_imports WHERE id=$1`, [importId]);
  if (!imp) throw new Error('Import not found');
  if (imp.status === 'POSTED') {
    const c = await counts(importId);
    return c;
  }

  const shop = await dq1<{ id: string }>(pool, `SELECT id FROM locations WHERE code='SHOP'`);
  if (!shop) throw new Error('SHOP location missing — run the core seed.');

  const rows = await dq<{
    id: string; row_no: number; sale_date: string | null; item_id: string; size: string;
    quantity: number; is_return: boolean; pos_item_code: string | null;
  }>(pool,
    `SELECT id, row_no, sale_date, item_id, size, quantity, is_return, pos_item_code
     FROM pos_sales WHERE import_id=$1 AND status='PENDING' ORDER BY row_no`, [importId]);

  let posted = 0, blocked = 0;
  for (const r of rows) {
    try {
      await withTx(async (client) => {
        await postMovements(client, [{
          movementType: r.is_return ? 'POS_RETURN' : 'POS_SALE',
          itemId: r.item_id, size: r.size, locationId: shop.id,
          qty: r.is_return ? r.quantity : -r.quantity,
          businessDate: r.sale_date ?? new Date().toISOString().slice(0, 10),
          sourceType: 'POS_SALE', sourceId: importId, sourceLineId: r.id,
          reason: `POS import ${imp.filename} row ${r.row_no}`, createdBy: userId,
        }]);
        await dq(client, `UPDATE pos_sales SET status='POSTED' WHERE id=$1`, [r.id]);
      });
      posted++;
    } catch (err) {
      if (err instanceof NegativeStockError) {
        blocked++;
        const d = err.detail;
        await dq(pool, `UPDATE pos_sales SET status='BLOCKED', error=$2 WHERE id=$1`,
          [r.id, `Would make stock ${d.resulting} (below zero) at SHOP.`]);
        const item = await dq1<{ name: string }>(pool, `SELECT name FROM items WHERE id=$1`, [d.itemId]);
        await raiseFinding(pool, {
          type: 'NEGATIVE_STOCK', severity: 'HIGH',
          title: `POS sale blocked: ${item?.name ?? 'item'} size ${d.size} would go to ${d.resulting}`,
          explanation: `Row ${r.row_no} of ${imp.filename} sells more than the book stock at SHOP. A receipt or transfer is probably missing, or the opening stock is wrong.`,
          itemId: d.itemId, size: d.size,
          recommendedAction: 'Record the missing receipt/transfer or adjust stock, then re-run the import.',
          dedupKey: `posneg:${r.id}`,
        });
      } else {
        await dq(pool, `UPDATE pos_sales SET status='ERROR', error=$2 WHERE id=$1`,
          [r.id, err instanceof Error ? err.message : String(err)]);
      }
    }
  }

  const c = await counts(importId);
  await dq(pool, `UPDATE pos_imports SET status='POSTED', posted_at=now(), ok_count=$2, error_count=$3 WHERE id=$1`,
    [importId, c.posted, c.errors + c.blocked]);
  if (c.errors + c.blocked > 0) {
    await raiseFinding(pool, {
      type: 'POS_IMPORT_FAILURE', severity: c.blocked > 0 ? 'HIGH' : 'WARNING',
      title: `POS import ${imp.filename}: ${c.posted} row(s) posted, ${c.blocked} blocked, ${c.errors} with errors`,
      explanation: 'Open the import to see each failed row and its reason. Fixed rows can be re-imported — already-posted rows will be skipped automatically.',
      recommendedAction: 'Review the failed rows on the import screen.',
      dedupKey: `posimp:${importId}`,
    });
  }
  return c;
}

async function counts(importId: string): Promise<PosCommitResult> {
  const c = await dq1<{ posted: number; blocked: number; dups: number; errors: number }>(getPool(),
    `SELECT count(*) FILTER (WHERE status='POSTED')::int AS posted,
            count(*) FILTER (WHERE status='BLOCKED')::int AS blocked,
            count(*) FILTER (WHERE status='SKIPPED_DUPLICATE')::int AS dups,
            count(*) FILTER (WHERE status='ERROR')::int AS errors
     FROM pos_sales WHERE import_id=$1`, [importId]);
  return { posted: c!.posted, blocked: c!.blocked, skippedDuplicates: c!.dups, errors: c!.errors };
}
