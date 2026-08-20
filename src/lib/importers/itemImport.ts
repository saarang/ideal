/**
 * Item-master importers.
 *
 * importVasyErpProducts reads the "Stock Summary" style export where each row
 * is one item+size with a 7-digit Item Code whose last two digits are the
 * size. Rows are grouped into items by name-minus-trailing-size; the POS code
 * is stored per size so POS sales files map straight onto the ledger.
 *
 * importOpeningStock turns a quantity column of the same file (or a simple
 * CSV) into OPENING movements — once per location, idempotent per row.
 */
import crypto from 'crypto';
import { getPool, dq, dq1, withTx } from '../db';
import { parseTabular, parseIntStrict, parseMoney } from './csv';
import { postMovements } from '../domain/ledger';

export interface VasyImportResult {
  importId: string;
  itemsCreated: number;
  itemsReused: number;
  sizesCreated: number;
  rows: number;
  errors: { row: number; error: string }[];
}

function slugCode(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  const abbr = words.map((w) => w.slice(0, 4)).join('-').slice(0, 28);
  return `IU-${abbr || 'ITEM'}`;
}

/** "NH TRACK PANT GREEN 28" → { base:"NH TRACK PANT GREEN", size:"28" } */
export function splitTrailingSize(name: string): { base: string; size: string | null } {
  const m = name.trim().match(/^(.*?)[\s-]+(\d{1,2}(?:\/\d{1,2})?)$/);
  if (!m) return { base: name.trim(), size: null };
  return { base: m[1].trim(), size: m[2] };
}

export async function importVasyErpProducts(
  buffer: Buffer, filename: string, userId: string | null, opts?: { markDemo?: boolean },
): Promise<VasyImportResult> {
  const pool = getPool();
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const table = parseTabular(buffer, filename);

  const col = (cands: string[]) =>
    table.headers.find((h) => cands.some((c) => h.toLowerCase().replace(/[^a-z]/g, '').includes(c)));
  const cCode = col(['itemcode', 'productcode']);
  const cName = col(['itemname', 'productname', 'name']);
  const cCategory = col(['category']);
  const cMrp = col(['mrp']);
  const cSelling = col(['sellingprice', 'salerate', 'saleprice']);
  if (!cName) throw new Error('Could not find an item-name column in the file.');

  const imp = await dq1<{ id: string }>(pool,
    `INSERT INTO imports (kind, filename, file_sha256, status, created_by)
     VALUES ('VASYERP_PRODUCTS', $1, $2, 'PREVIEW', $3) RETURNING id`, [filename, sha, userId]);
  const importId = imp!.id;

  let itemsCreated = 0, itemsReused = 0, sizesCreated = 0;
  const errors: { row: number; error: string }[] = [];
  const itemCache = new Map<string, string>(); // base-name(+category) → item id

  for (let i = 0; i < table.rows.length; i++) {
    const r = table.rows[i];
    try {
      const rawName = (r[cName] ?? '').trim();
      if (!rawName) { errors.push({ row: i + 1, error: 'Missing item name' }); continue; }
      const posCode = cCode ? (r[cCode] ?? '').trim() : '';
      let { base, size } = splitTrailingSize(rawName);
      if (!size && /^\d{7}$/.test(posCode)) size = String(parseInt(posCode.slice(-2), 10));
      if (!size) size = 'FREE';

      const categoryName = (cCategory ? (r[cCategory] ?? '').trim() : '') || 'General';
      const cacheKey = `${categoryName}|${base.toUpperCase()}`;
      let itemId = itemCache.get(cacheKey);
      if (!itemId) {
        let cat = await dq1<{ id: string }>(pool, `SELECT id FROM item_categories WHERE lower(name)=lower($1)`, [categoryName]);
        if (!cat) cat = await dq1<{ id: string }>(pool,
          `INSERT INTO item_categories (name) VALUES ($1) RETURNING id`, [categoryName]);
        const existing = await dq1<{ id: string }>(pool,
          `SELECT id FROM items WHERE lower(name)=lower($1) AND category_id=$2`, [base, cat!.id]);
        if (existing) { itemId = existing.id; itemsReused++; }
        else {
          let code = slugCode(base);
          const clash = await dq1<{ n: number }>(pool, `SELECT count(*)::int AS n FROM items WHERE code=$1`, [code]);
          if ((clash?.n ?? 0) > 0) code = `${code}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
          const created = await dq1<{ id: string }>(pool,
            `INSERT INTO items (code, name, category_id, is_demo) VALUES ($1,$2,$3,$4) RETURNING id`,
            [code, base, cat!.id, opts?.markDemo ?? false]);
          itemId = created!.id; itemsCreated++;
        }
        itemCache.set(cacheKey, itemId);
      }

      const mrp = cMrp ? parseMoney(r[cMrp] ?? '') : null;
      const selling = cSelling ? parseMoney(r[cSelling] ?? '') : null;
      const ins = await dq1<{ inserted: boolean }>(pool,
        `INSERT INTO item_sizes (item_id, size, pos_code, mrp, selling_price, sort_order)
         VALUES ($1,$2,NULLIF($3,''),$4,$5,
                 CASE WHEN $2 ~ '^\\d+' THEN (regexp_match($2, '^\\d+'))[1]::int ELSE 999 END)
         ON CONFLICT (item_id, size) DO UPDATE
           SET pos_code = COALESCE(EXCLUDED.pos_code, item_sizes.pos_code),
               mrp = COALESCE(EXCLUDED.mrp, item_sizes.mrp),
               selling_price = COALESCE(EXCLUDED.selling_price, item_sizes.selling_price)
         RETURNING (xmax = 0) AS inserted`,
        [itemId, size, posCode, mrp, selling]);
      if (ins?.inserted) sizesCreated++;
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await dq(pool,
    `UPDATE imports SET status='DONE', ok_count=$2, error_count=$3, errors=$4 WHERE id=$1`,
    [importId, table.rows.length - errors.length, errors.length, JSON.stringify(errors.slice(0, 200))]);
  return { importId, itemsCreated, itemsReused, sizesCreated, rows: table.rows.length, errors };
}

export interface OpeningStockResult {
  importId: string; posted: number; skipped: number; errors: { row: number; error: string }[];
}

/**
 * Opening stock from a CSV/XLSX with pos_code or item code+size, a quantity
 * column and optionally a location column (defaults to SHOP). Negative
 * source quantities are recorded as zero-skip with an error note — an opening
 * balance below zero is a data problem to fix at source, not a ledger entry.
 */
export async function importOpeningStock(
  buffer: Buffer, filename: string, args: { asOfDate: string; defaultLocation?: 'SHOP' | 'GODOWN'; userId: string | null; markDemo?: boolean },
): Promise<OpeningStockResult> {
  const pool = getPool();
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const table = parseTabular(buffer, filename);
  const col = (cands: string[]) =>
    table.headers.find((h) => cands.some((c) => h.toLowerCase().replace(/[^a-z]/g, '').includes(c)));
  const cPos = col(['itemcode', 'productcode', 'poscode', 'barcode']);
  const cQty = col(['currentstock', 'qty', 'quantity', 'stock']);
  const cLoc = col(['location', 'godown', 'warehouse']);
  if (!cQty) throw new Error('Could not find a quantity/stock column.');

  const imp = await dq1<{ id: string }>(pool,
    `INSERT INTO imports (kind, filename, file_sha256, status, created_by)
     VALUES ('OPENING_STOCK', $1, $2, 'PREVIEW', $3) RETURNING id`, [filename, sha, args.userId]);
  const importId = imp!.id;

  const locations = Object.fromEntries(
    (await dq<{ code: string; id: string }>(pool, `SELECT code, id FROM locations`)).map((l) => [l.code, l.id]));
  const defaultLoc = locations[args.defaultLocation ?? 'SHOP'];
  if (!defaultLoc) throw new Error('Locations missing — run the core seed.');

  let posted = 0, skipped = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < table.rows.length; i++) {
    const r = table.rows[i];
    const posCode = cPos ? (r[cPos] ?? '').trim() : '';
    const qty = parseIntStrict(r[cQty] ?? '');
    const locCode = (cLoc ? (r[cLoc] ?? '').trim().toUpperCase() : '') || (args.defaultLocation ?? 'SHOP');
    const locId = locations[locCode] ?? defaultLoc;

    if (qty == null) { errors.push({ row: i + 1, error: 'Quantity unreadable' }); continue; }
    if (qty <= 0) { skipped++; continue; }  // zero/negative: nothing to open with

    const found = await dq1<{ item_id: string; size: string }>(pool,
      `SELECT item_id, size FROM item_sizes WHERE pos_code=$1 LIMIT 1`, [posCode]);
    if (!found) { errors.push({ row: i + 1, error: `POS code ${posCode || '(blank)'} not found` }); continue; }

    // source_line_id is a UUID column; derive a stable one from the row's identity
    // so re-running the same file skips instead of double-opening.
    const h = crypto.createHash('sha256')
      .update(`opening|${found.item_id}|${found.size}|${locCode}`).digest('hex');
    const sourceLineId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    try {
      await withTx(async (client) => {
        await postMovements(client, [{
          movementType: 'OPENING', itemId: found.item_id, size: found.size, locationId: locId,
          qty, businessDate: args.asOfDate,
          sourceType: 'IMPORT', sourceId: importId,
          sourceLineId,
          reason: `Opening stock from ${filename}`, createdBy: args.userId,
        }]);
      });
      posted++;
    } catch (err) {
      errors.push({ row: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await dq(pool, `UPDATE imports SET status='DONE', ok_count=$2, error_count=$3, errors=$4 WHERE id=$1`,
    [importId, posted, errors.length, JSON.stringify(errors.slice(0, 200))]);
  return { importId, posted, skipped, errors };
}
