/**
 * MATCH stage — connect extracted lines to the item master.
 *
 * Supplier documents: apply USER_CONFIRMED supplier aliases automatically;
 * anything else becomes an ITEM_MAPPING_REQUIRED finding plus one task per
 * distinct description so staff can teach the system once.
 *
 * Customer challans use Ideal's own wording, so an exact/near item-name match
 * is prefilled as AI_SUGGESTED (staff confirm on the document screen).
 */
import { getPool, dq, dq1, Db } from '../db';
import { raiseFinding, raiseTask } from '../domain/findings';

const SUPPLIER_DOC_TYPES = ['SUPPLIER_DELIVERY_CHALLAN', 'SUPPLIER_INVOICE', 'INWARD_BOOK', 'ORDER_BOOK'];

function normDesc(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function matchDocument(documentId: string): Promise<void> {
  const pool = getPool();
  const doc = await dq1<{
    id: string; doc_type: string; supplier_id: string | null; is_demo: boolean;
  }>(pool, `SELECT id, doc_type, supplier_id, is_demo FROM documents WHERE id=$1`, [documentId]);
  if (!doc) throw new Error(`Document ${documentId} not found`);

  const lines = await dq<{
    id: string; line_no: number; sub_no: number; raw_description: string | null;
    normalized_description: string | null; size_normalized: string | null;
    item_id: string | null; mapping_status: string; quantity: number | null;
  }>(pool,
    `SELECT id, line_no, sub_no, raw_description, normalized_description, size_normalized,
            item_id, mapping_status, quantity
     FROM document_lines WHERE document_id=$1 ORDER BY line_no, sub_no`, [documentId]);
  if (lines.length === 0) return;

  const isSupplierDoc = SUPPLIER_DOC_TYPES.includes(doc.doc_type);
  const unmappedDescriptions = new Map<string, string>(); // norm -> raw sample

  for (const line of lines) {
    if (line.mapping_status === 'USER_CONFIRMED' || line.mapping_status === 'NOT_REQUIRED') continue;
    const desc = line.normalized_description || line.raw_description;
    if (!desc || !desc.trim()) {
      // Nothing to map against (e.g. a continuation row); leave for review.
      continue;
    }
    const key = normDesc(desc);

    let mapped = false;
    if (isSupplierDoc && doc.supplier_id) {
      // 1) Confirmed alias for this supplier — deterministic, auto-apply.
      const alias = await dq1<{ id: string; item_id: string }>(pool,
        `SELECT id, item_id FROM supplier_item_aliases
         WHERE supplier_id=$1 AND status='USER_CONFIRMED' AND item_id IS NOT NULL
           AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
           AND regexp_replace(lower(regexp_replace(supplier_description, '[^a-zA-Z0-9/ ]+', ' ', 'g')), '[[:space:]]+', ' ', 'g') =
               regexp_replace(lower(regexp_replace($2,                  '[^a-zA-Z0-9/ ]+', ' ', 'g')), '[[:space:]]+', ' ', 'g')
         ORDER BY effective_from DESC LIMIT 1`,
        [doc.supplier_id, key]);
      if (alias) {
        await dq(pool,
          `UPDATE document_lines SET item_id=$1, alias_id=$2, mapping_status='USER_CONFIRMED'
           WHERE id=$3 AND mapping_status <> 'USER_CONFIRMED'`,
          [alias.item_id, alias.id, line.id]);
        await dq(pool, `UPDATE supplier_item_aliases SET last_used_at=now() WHERE id=$1`, [alias.id]);
        mapped = true;
        await checkSizeAgainstMaster(pool, documentId, line.id, alias.item_id, line.size_normalized, line.line_no, line.sub_no);
      }
    }

    if (!mapped) {
      // 2) Item-master name match. For customer challans (our own wording) a
      //    strong match is prefilled; for supplier docs it is only a suggestion.
      const suggestion = await dq1<{ id: string; sim: number }>(pool,
        `SELECT id, similarity(lower(name), $1) AS sim FROM items
         WHERE is_active AND similarity(lower(name), $1) > 0.55
         ORDER BY sim DESC LIMIT 1`, [key]);
      if (suggestion) {
        const conf = doc.doc_type === 'IDEAL_CUSTOMER_DELIVERY_CHALLAN'
          ? Math.min(0.98, 0.6 + suggestion.sim * 0.4)
          : Math.min(0.9, suggestion.sim);
        await dq(pool,
          `UPDATE document_lines SET item_id=$1, mapping_status='AI_SUGGESTED',
             conf = jsonb_set(COALESCE(conf,'{}'::jsonb), '{mapping}', to_jsonb($2::numeric))
           WHERE id=$3 AND mapping_status IN ('UNMAPPED','AI_SUGGESTED')`,
          [suggestion.id, conf.toFixed(3), line.id]);
        await checkSizeAgainstMaster(pool, documentId, line.id, suggestion.id, line.size_normalized, line.line_no, line.sub_no);
        mapped = true; // suggested — user still confirms before posting
      }
    }

    if (!mapped && !unmappedDescriptions.has(key)) {
      unmappedDescriptions.set(key, desc.trim());
    }
  }

  if (unmappedDescriptions.size > 0) {
    await raiseFinding(pool, {
      type: 'ITEM_MAPPING_REQUIRED', severity: 'WARNING',
      title: `${unmappedDescriptions.size} item description(s) need mapping`,
      explanation: `These descriptions were not recognised: ${[...unmappedDescriptions.values()].slice(0, 6).join('; ')}${unmappedDescriptions.size > 6 ? '…' : ''}. Map each one to an item once and future documents from this supplier will map automatically.`,
      documentId, supplierId: doc.supplier_id,
      recommendedAction: 'Open the Mapping workbench and link each description to an item.',
      dedupKey: `map:${documentId}`,
    });
    for (const [key, sample] of unmappedDescriptions) {
      await raiseTask(pool, {
        taskType: 'MAP_ITEM',
        title: `Map "${sample}" to an item`,
        priority: 'NORMAL',
        documentId,
        payload: { description: sample, normalized: key, supplierId: doc.supplier_id },
        dedupKey: `mapitem:${doc.supplier_id ?? 'none'}:${key}`,
      });
    }
  }
}

/** Size printed on the paper but missing from the item's size list → review. */
async function checkSizeAgainstMaster(
  db: Db, documentId: string, lineId: string, itemId: string,
  size: string | null, lineNo: number, subNo: number,
) {
  if (!size || size === 'FREE') return;
  const known = await dq1<{ n: number }>(db,
    `SELECT count(*)::int AS n FROM item_sizes WHERE item_id=$1 AND size=$2`, [itemId, size]);
  if ((known?.n ?? 0) > 0) return;
  await dq(db, `UPDATE document_lines SET review_status='NEEDS_REVIEW' WHERE id=$1`, [lineId]);
  const item = await dq1<{ name: string }>(db, `SELECT name FROM items WHERE id=$1`, [itemId]);
  await raiseTask(db, {
    taskType: 'CONFIRM_SIZE_QTY',
    title: `Size ${size} is not in the size list for ${item?.name ?? 'item'} (line ${lineNo}.${subNo})`,
    priority: 'NORMAL', documentId, documentLineId: lineId,
    payload: { size, itemId },
    dedupKey: `sizemaster:${lineId}`,
  });
}
