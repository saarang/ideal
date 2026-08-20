'use server';
/**
 * Server actions. Every mutation the UI performs lives here so pages stay
 * plain server components. Actions re-run VALIDATE→MATCH→STATUS after edits so
 * the document's blockers list is always current, and audit corrections.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { q, q1, withTx, getPool } from '@/src/lib/db';
import {
  createSession, setSessionCookie, clearSession, verifyPassword, apiUser, hashPassword,
} from '@/src/lib/auth';
import { audit } from '@/src/lib/audit';
import { validateDocument } from '@/src/lib/pipeline/validate';
import { matchDocument } from '@/src/lib/pipeline/match';
import { refreshDocumentStatus } from '@/src/lib/pipeline/status';
import { runPipeline } from '@/src/lib/pipeline/runner';
import { postDocument } from '@/src/lib/pipeline/post';
import { reconcileReceiptGroup } from '@/src/lib/pipeline/recon';
import { resolveFinding as domainResolveFinding, completeTask as domainCompleteTask } from '@/src/lib/domain/findings';
import { postMovements, postTransfer, reverseMovement } from '@/src/lib/domain/ledger';
import { setSetting } from '@/src/lib/settings';

/** Manual size entry: keep digits/composites as typed, everything else upper-cased. */
function cleanSize(raw: string): string {
  const t = raw.trim().toUpperCase().replace(/\s+/g, '');
  return t === '' ? t : t;
}

export interface ActionResult { ok: boolean; message: string }
const ok = (message = 'Done'): ActionResult => ({ ok: true, message });
const fail = (message: string): ActionResult => ({ ok: false, message });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Auth ─────────────────────────────────────────────────────────────────────
export async function loginAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const userId = await verifyPassword(email, password);
  if (!userId) return fail('Email or password is wrong.');
  const token = await createSession(userId);
  await setSessionCookie(token);
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/login');
}

// ── Document review ──────────────────────────────────────────────────────────
async function rerunChecks(documentId: string) {
  await validateDocument(documentId);
  await matchDocument(documentId);
  await refreshDocumentStatus(documentId);
  revalidatePath(`/documents/${documentId}`);
  revalidatePath('/documents');
  revalidatePath('/');
}

export async function confirmDocTypeAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const id = String(form.get('documentId'));
  const docType = String(form.get('docType'));
  try {
    const before = await q1<{ doc_type: string }>(`SELECT doc_type FROM documents WHERE id=$1`, [id]);
    await q(`UPDATE documents SET doc_type=$2, classification_source='USER' WHERE id=$1`, [id, docType]);
    await q(`UPDATE workflow_tasks SET status='DONE', completed_by=$2, completed_at=now()
             WHERE document_id=$1 AND task_type='CONFIRM_DOCUMENT_TYPE' AND status IN ('OPEN','IN_PROGRESS')`, [id, user.id]);
    await audit(user.id, 'DOC_TYPE_CONFIRMED', 'document', id, before, { doc_type: docType });
    // Type decides extraction guidance → run the whole pipeline again from extract.
    await runPipeline(id, 'EXTRACT');
    revalidatePath(`/documents/${id}`); revalidatePath('/documents'); revalidatePath('/');
    return ok('Type confirmed — the page has been re-read with the right rules.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function updateHeaderAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const id = String(form.get('documentId'));
  const field = String(form.get('field'));
  const value = String(form.get('value') ?? '').trim() || null;
  const allowed: Record<string, string> = {
    document_number: 'document_number', document_date: 'document_date',
    supplier_id: 'supplier_id', customer_id: 'customer_id',
    receipt_location_id: 'receipt_location_id', dispatch_location_id: 'dispatch_location_id',
    destination_location_id: 'destination_location_id',
    grand_total: 'grand_total', handwritten_total_qty: 'handwritten_total_qty', notes: 'notes',
  };
  const col = allowed[field];
  if (!col) return fail('This field cannot be edited.');
  try {
    const before = await q1<any>(`SELECT ${col} AS v FROM documents WHERE id=$1`, [id]);
    await q(`UPDATE documents SET ${col}=$2 WHERE id=$1`, [id, value]);
    await q(`INSERT INTO field_corrections (entity_type, entity_id, field, old_value, new_value, corrected_by)
             VALUES ('document',$1,$2,$3,$4,$5)`, [id, field, before?.v != null ? String(before.v) : null, value, user.id]);
    if (['supplier_id', 'customer_id'].includes(field)) {
      await q(`UPDATE documents SET ${field === 'supplier_id' ? 'supplier_confidence' : 'overall_confidence'} = COALESCE(${field === 'supplier_id' ? 'supplier_confidence' : 'overall_confidence'}, 0.99) WHERE id=$1`, [id]);
      await q(`UPDATE workflow_tasks SET status='DONE', completed_by=$2, completed_at=now()
               WHERE document_id=$1 AND task_type='CORRECT_HEADER' AND status IN ('OPEN','IN_PROGRESS')`, [id, user.id]);
    }
    await rerunChecks(id);
    return ok('Saved.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function updateLineAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const lineId = String(form.get('lineId'));
  const sizeRaw = form.get('size') != null ? String(form.get('size')).trim() : null;
  const qtyRaw = form.get('quantity') != null ? String(form.get('quantity')).trim() : null;
  try {
    const line = await q1<{ document_id: string; size_normalized: string | null; quantity: number | null }>(
      `SELECT document_id, size_normalized, quantity FROM document_lines WHERE id=$1`, [lineId]);
    if (!line) return fail('Line not found.');
    const updates: string[] = []; const params: unknown[] = [lineId]; let p = 1;
    if (sizeRaw !== null && sizeRaw !== '') {
      updates.push(`size_raw=$${++p}`); params.push(sizeRaw);
      updates.push(`size_normalized=$${++p}`); params.push(cleanSize(sizeRaw));
      updates.push(`notation='PLAIN'`);
    }
    if (qtyRaw !== null && qtyRaw !== '') {
      const n = parseInt(qtyRaw, 10);
      if (!Number.isInteger(n) || n <= 0) return fail('Quantity must be a whole number above zero.');
      updates.push(`quantity=$${++p}`); params.push(n);
    }
    if (!updates.length) return fail('Nothing to save.');
    updates.push(`review_status='REVIEWED'`);
    await q(`UPDATE document_lines SET ${updates.join(', ')} WHERE id=$1`, params);
    await q(`UPDATE workflow_tasks SET status='DONE', completed_by=$2, completed_at=now()
             WHERE document_line_id=$1 AND status IN ('OPEN','IN_PROGRESS')`, [lineId, user.id]);
    await q(`INSERT INTO field_corrections (entity_type, entity_id, field, old_value, new_value, corrected_by)
             VALUES ('document_line',$1,'size_qty',$2,$3,$4)`,
      [lineId, `${line.size_normalized ?? '?'} × ${line.quantity ?? '?'}`, `${sizeRaw ?? line.size_normalized} × ${qtyRaw ?? line.quantity}`, user.id]);
    await rerunChecks(line.document_id);
    return ok('Line updated.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function markLineNotStockAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const lineId = String(form.get('lineId'));
  try {
    const line = await q1<{ document_id: string }>(`SELECT document_id FROM document_lines WHERE id=$1`, [lineId]);
    if (!line) return fail('Line not found.');
    await q(`UPDATE document_lines SET mapping_status='NOT_REQUIRED', review_status='REVIEWED', item_id=NULL, quantity=NULL WHERE id=$1`, [lineId]);
    await q(`UPDATE workflow_tasks SET status='DONE', completed_by=$2, completed_at=now()
             WHERE document_line_id=$1 AND status IN ('OPEN','IN_PROGRESS')`, [lineId, user.id]);
    await rerunChecks(line.document_id);
    return ok('Line marked as not a stock line.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function mapLineAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const lineId = String(form.get('lineId'));
  const itemId = String(form.get('itemId') ?? '');
  const saveAlias = form.get('saveAlias') === 'on' || form.get('saveAlias') === 'true';
  if (!itemId) return fail('Pick an item first.');
  try {
    const line = await q1<{ document_id: string; raw_description: string | null; normalized_description: string | null; supplier_id: string | null }>(
      `SELECT dl.document_id, dl.raw_description, dl.normalized_description, d.supplier_id
       FROM document_lines dl JOIN documents d ON d.id = dl.document_id WHERE dl.id=$1`, [lineId]);
    if (!line) return fail('Line not found.');

    let aliasId: string | null = null;
    const desc = line.normalized_description || line.raw_description;
    if (saveAlias && line.supplier_id && desc) {
      const a = await q1<{ id: string }>(
        `INSERT INTO supplier_item_aliases (supplier_id, supplier_description, item_id, status, mapping_confidence, approved_by, source_document_id)
         VALUES ($1,$2,$3,'USER_CONFIRMED',1.0,$4,$5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [line.supplier_id, desc, itemId, user.id, line.document_id]);
      aliasId = a?.id ?? null;
      if (!aliasId) {
        const existing = await q1<{ id: string }>(
          `SELECT id FROM supplier_item_aliases WHERE supplier_id=$1 AND lower(supplier_description)=lower($2) LIMIT 1`,
          [line.supplier_id, desc]);
        if (existing) {
          await q(`UPDATE supplier_item_aliases SET item_id=$2, status='USER_CONFIRMED', approved_by=$3 WHERE id=$1`,
            [existing.id, itemId, user.id]);
          aliasId = existing.id;
        }
      }
      // Apply to every unmapped line with the same wording from this supplier.
      await q(
        `UPDATE document_lines dl SET item_id=$1, alias_id=$2, mapping_status='USER_CONFIRMED'
         FROM documents d
         WHERE d.id = dl.document_id AND d.supplier_id=$3
           AND dl.mapping_status IN ('UNMAPPED','AI_SUGGESTED')
           AND lower(COALESCE(dl.normalized_description, dl.raw_description)) = lower($4)`,
        [itemId, aliasId, line.supplier_id, desc]);
    }
    await q(`UPDATE document_lines SET item_id=$2, alias_id=COALESCE($3, alias_id), mapping_status='USER_CONFIRMED' WHERE id=$1`,
      [lineId, itemId, aliasId]);
    await q(`UPDATE workflow_tasks SET status='DONE', completed_by=$2, completed_at=now()
             WHERE (document_line_id=$1 OR (task_type='MAP_ITEM' AND payload->>'description' = $3)) AND status IN ('OPEN','IN_PROGRESS')`,
      [lineId, user.id, desc]);
    await audit(user.id, 'LINE_MAPPED', 'document_line', lineId, null, { itemId, saveAlias });
    await rerunChecks(line.document_id);
    return ok(saveAlias ? 'Mapped — this supplier wording will map automatically from now on.' : 'Mapped for this document.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function confirmSuggestionsAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const documentId = String(form.get('documentId'));
  try {
    const r = await q(`UPDATE document_lines SET mapping_status='USER_CONFIRMED'
                       WHERE document_id=$1 AND mapping_status='AI_SUGGESTED' RETURNING id`, [documentId]);
    await audit(user.id, 'SUGGESTIONS_CONFIRMED', 'document', documentId, null, { lines: r.length });
    await rerunChecks(documentId);
    return ok(`${r.length} suggested mapping(s) confirmed.`);
  } catch (e) { return fail(errMsg(e)); }
}

export async function postDocumentAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const documentId = String(form.get('documentId'));
  try {
    const out = await postDocument(documentId, user.id);
    revalidatePath(`/documents/${documentId}`); revalidatePath('/documents'); revalidatePath('/'); revalidatePath('/stock');
    return out.status === 'BLOCKED' ? fail(out.message) : ok(out.message);
  } catch (e) { return fail(errMsg(e)); }
}

export async function reprocessAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const documentId = String(form.get('documentId'));
  const from = (String(form.get('from') ?? 'PREPARE') as any);
  try {
    await q(`UPDATE documents SET status='PROCESSING' WHERE id=$1 AND status NOT IN ('POSTED','DUPLICATE','LINKED_NO_POSTING')`, [documentId]);
    const r = await runPipeline(documentId, from);
    await audit(user.id, 'DOCUMENT_REPROCESSED', 'document', documentId, null, { from, ok: r.ok });
    revalidatePath(`/documents/${documentId}`); revalidatePath('/documents');
    return r.ok ? ok('Re-processed.') : fail(`Failed at ${r.failedStage}: ${r.error}`);
  } catch (e) { return fail(errMsg(e)); }
}

export async function markDuplicateAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const documentId = String(form.get('documentId'));
  const ofRef = String(form.get('ofRef') ?? '').trim();
  try {
    let ofId: string | null = null;
    if (ofRef) {
      const d = await q1<{ id: string }>(`SELECT id FROM documents WHERE ref_no=$1`, [ofRef]);
      if (!d) return fail(`No document with reference ${ofRef}.`);
      ofId = d.id;
    }
    await q(`UPDATE documents SET status='DUPLICATE', duplicate_of_id=$2 WHERE id=$1`, [documentId, ofId]);
    await q(`UPDATE workflow_tasks SET status='CANCELLED' WHERE document_id=$1 AND status IN ('OPEN','IN_PROGRESS')`, [documentId]);
    await q(`UPDATE findings SET status='CANCELLED', resolved_at=now(), resolved_by=$2, resolution='Document marked duplicate'
             WHERE document_id=$1 AND status='OPEN'`, [documentId, user.id]);
    await audit(user.id, 'DOCUMENT_MARKED_DUPLICATE', 'document', documentId, null, { ofRef });
    revalidatePath(`/documents/${documentId}`); revalidatePath('/documents');
    return ok('Marked as duplicate — nothing from this photo will post.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function notDuplicateAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const documentId = String(form.get('documentId'));
  try {
    await q(`UPDATE documents SET status='NEEDS_REVIEW', duplicate_of_id=NULL WHERE id=$1 AND status='DUPLICATE'`, [documentId]);
    await q(`UPDATE findings SET status='RESOLVED', resolved_at=now(), resolved_by=$2, resolution='Confirmed not a duplicate'
             WHERE document_id=$1 AND type='POSSIBLE_DUPLICATE_DOCUMENT' AND status='OPEN'`, [documentId, user.id]);
    await rerunChecks(documentId);
    return ok('Kept as a separate document.');
  } catch (e) { return fail(errMsg(e)); }
}

// ── Findings & tasks ─────────────────────────────────────────────────────────
export async function resolveFindingAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const id = String(form.get('findingId'));
  const status = String(form.get('status')) as 'RESOLVED' | 'ACCEPTED' | 'FALSE_POSITIVE';
  const resolution = String(form.get('resolution') ?? '').trim() || status;
  try {
    await domainResolveFinding(getPool(), id, user.id, status, resolution);
    revalidatePath('/findings'); revalidatePath('/');
    return ok('Finding closed.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function completeTaskAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const id = String(form.get('taskId'));
  const detail = String(form.get('detail') ?? '').trim() || undefined;
  try {
    await domainCompleteTask(getPool(), id, user.id, detail);
    const t = await q1<{ document_id: string | null }>(`SELECT document_id FROM workflow_tasks WHERE id=$1`, [id]);
    if (t?.document_id) await rerunChecks(t.document_id);
    revalidatePath('/tasks'); revalidatePath('/');
    return ok('Task done.');
  } catch (e) { return fail(errMsg(e)); }
}

// ── Stock: transfers & adjustments ───────────────────────────────────────────
export async function createTransferAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const itemId = String(form.get('itemId'));
  const size = String(form.get('size'));
  const qty = parseInt(String(form.get('qty')), 10);
  const direction = String(form.get('direction')); // S2G | G2S
  const date = String(form.get('date') || new Date().toISOString().slice(0, 10));
  if (!itemId || !size || !Number.isInteger(qty) || qty <= 0) return fail('Pick item, size and a quantity above zero.');
  try {
    const shop = await q1<{ id: string }>(`SELECT id FROM locations WHERE code='SHOP'`);
    const godown = await q1<{ id: string }>(`SELECT id FROM locations WHERE code='GODOWN'`);
    const from = direction === 'S2G' ? shop!.id : godown!.id;
    const to = direction === 'S2G' ? godown!.id : shop!.id;
    await withTx(async (client) => {
      const t = await client.query(
        `INSERT INTO stock_transfers (from_location_id, to_location_id, transfer_date, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id, transfer_no`, [from, to, date, user.id]);
      const lineRow = await client.query(
        `INSERT INTO stock_transfer_lines (transfer_id, item_id, size, quantity) VALUES ($1,$2,$3,$4) RETURNING id`,
        [t.rows[0].id, itemId, size, qty]);
      await postTransfer(client, {
        itemId, size, qty, businessDate: date,
        fromLocationId: from, toLocationId: to,
        sourceType: 'TRANSFER_LINE', sourceId: t.rows[0].id, sourceLineId: lineRow.rows[0].id,
        reason: `Transfer ${t.rows[0].transfer_no}`, createdBy: user.id,
      });
    });
    revalidatePath('/stock'); revalidatePath('/transfers');
    return ok(`Moved ${qty} pc ${direction === 'S2G' ? 'Shop → Godown' : 'Godown → Shop'}.`);
  } catch (e) { return fail(errMsg(e)); }
}

export async function createAdjustmentAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('ADMIN');
  const itemId = String(form.get('itemId'));
  const size = String(form.get('size'));
  const qty = parseInt(String(form.get('qty')), 10); // signed
  const location = String(form.get('location'));
  const reason = String(form.get('reason') ?? '').trim();
  if (!reason) return fail('An adjustment always needs a written reason.');
  if (!Number.isInteger(qty) || qty === 0) return fail('Quantity must be a non-zero whole number (use minus to reduce).');
  try {
    const loc = await q1<{ id: string }>(`SELECT id FROM locations WHERE code=$1`, [location]);
    if (!loc) return fail('Unknown location.');
    await withTx(async (client) => {
      await postMovements(client, [{
        movementType: 'ADJUSTMENT', itemId, size, locationId: loc.id, qty,
        businessDate: new Date().toISOString().slice(0, 10),
        sourceType: 'MANUAL', reason: `Adjustment: ${reason}`, createdBy: user.id,
      }]);
    });
    await audit(user.id, 'STOCK_ADJUSTED', 'item', itemId, null, { size, qty, location, reason });
    revalidatePath('/stock');
    return ok(`Adjusted by ${qty > 0 ? '+' : ''}${qty} pc at ${location}.`);
  } catch (e) { return fail(errMsg(e)); }
}

export async function reverseMovementAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('ADMIN');
  const movementId = String(form.get('movementId'));
  const reason = String(form.get('reason') ?? '').trim();
  if (!reason) return fail('A reversal always needs a written reason.');
  try {
    await withTx(async (client) => { await reverseMovement(client, movementId, user.id, reason); });
    revalidatePath('/stock');
    return ok('Movement reversed with an opposite entry (nothing is ever deleted).');
  } catch (e) { return fail(errMsg(e)); }
}

// ── Purchase orders ──────────────────────────────────────────────────────────
export async function createPoAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const supplierId = String(form.get('supplierId'));
  const orderDate = String(form.get('orderDate'));
  const expectedDate = String(form.get('expectedDate') ?? '').trim() || null;
  const linesRaw = String(form.get('lines') ?? '').trim();
  if (!supplierId || !orderDate || !linesRaw) return fail('Supplier, order date and at least one line are needed.');
  try {
    const lines = linesRaw.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed: { desc: string; size: string; qty: number }[] = [];
    for (const l of lines) {
      // "description | size | qty"
      const parts = l.split('|').map((p) => p.trim());
      if (parts.length < 3) return fail(`Line "${l}" — write it as: description | size | quantity`);
      const qty = parseInt(parts[2], 10);
      if (!Number.isInteger(qty) || qty <= 0) return fail(`Line "${l}" — quantity must be a whole number above zero.`);
      parsed.push({ desc: parts[0], size: parts[1], qty });
    }
    const po = await q1<{ id: string; po_no: string }>(
      `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id, po_no`, [supplierId, orderDate, expectedDate, user.id]);
    for (let i = 0; i < parsed.length; i++) {
      const item = await q1<{ id: string }>(
        `SELECT id FROM items WHERE is_active AND similarity(lower(name), lower($1)) > 0.6
         ORDER BY similarity(lower(name), lower($1)) DESC LIMIT 1`, [parsed[i].desc]);
      await q(`INSERT INTO purchase_order_lines (po_id, line_no, item_id, description_raw, size, quantity_ordered)
               VALUES ($1,$2,$3,$4,$5,$6)`,
        [po!.id, i + 1, item?.id ?? null, parsed[i].desc, parsed[i].size, parsed[i].qty]);
    }
    await audit(user.id, 'PO_CREATED', 'purchase_order', po!.id);
    revalidatePath('/orders');
    return ok(`Order ${po!.po_no} recorded with ${parsed.length} line(s).`);
  } catch (e) { return fail(errMsg(e)); }
}

export async function cancelPoAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const poId = String(form.get('poId'));
  try {
    await q(`UPDATE purchase_orders SET status='CANCELLED' WHERE id=$1`, [poId]);
    await q(`UPDATE findings SET status='CANCELLED', resolved_by=$2, resolved_at=now(), resolution='Order cancelled'
             WHERE type='ORDER_OVERDUE' AND status='OPEN' AND dedup_key = 'overdue:' || $1`, [poId, user.id]);
    revalidatePath('/orders');
    return ok('Order cancelled.');
  } catch (e) { return fail(errMsg(e)); }
}

// ── Reconciliation ───────────────────────────────────────────────────────────
export async function rebuildReconAction(form: FormData): Promise<ActionResult> {
  await apiUser('STAFF');
  const documentId = String(form.get('documentId'));
  try {
    const caseId = await reconcileReceiptGroup(documentId);
    revalidatePath('/recon');
    return caseId ? ok('Reconciliation refreshed.') : fail('This document type is not part of receipt reconciliation.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function resolveCaseAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const caseId = String(form.get('caseId'));
  try {
    await q(`UPDATE reconciliation_cases SET status='RESOLVED', resolved_at=now(), resolved_by=$2 WHERE id=$1`, [caseId, user.id]);
    revalidatePath('/recon');
    return ok('Case closed.');
  } catch (e) { return fail(errMsg(e)); }
}

// ── Items ────────────────────────────────────────────────────────────────────
export async function createItemAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const name = String(form.get('name') ?? '').trim();
  const code = String(form.get('code') ?? '').trim().toUpperCase();
  const category = String(form.get('category') ?? '').trim() || 'General';
  const sizes = String(form.get('sizes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || !code) return fail('Name and code are both needed.');
  try {
    let cat = await q1<{ id: string }>(`SELECT id FROM item_categories WHERE lower(name)=lower($1)`, [category]);
    if (!cat) cat = await q1<{ id: string }>(`INSERT INTO item_categories (name) VALUES ($1) RETURNING id`, [category]);
    const item = await q1<{ id: string }>(
      `INSERT INTO items (code, name, category_id) VALUES ($1,$2,$3) RETURNING id`, [code, name, cat!.id]);
    for (const s of sizes) {
      await q(`INSERT INTO item_sizes (item_id, size, sort_order)
               VALUES ($1,$2, CASE WHEN $2 ~ '^\\d+' THEN (regexp_match($2,'^\\d+'))[1]::int ELSE 999 END)
               ON CONFLICT DO NOTHING`, [item!.id, s]);
    }
    await audit(user.id, 'ITEM_CREATED', 'item', item!.id);
    revalidatePath('/items');
    return ok(`Item ${code} created${sizes.length ? ` with ${sizes.length} size(s)` : ''}.`);
  } catch (e) {
    return errMsg(e).includes('items_code_key') ? fail(`Code ${code} is already used.`) : fail(errMsg(e));
  }
}

export async function addItemSizeAction(form: FormData): Promise<ActionResult> {
  await apiUser('STAFF');
  const itemId = String(form.get('itemId'));
  const size = String(form.get('size') ?? '').trim();
  if (!size) return fail('Type a size.');
  try {
    await q(`INSERT INTO item_sizes (item_id, size, sort_order)
             VALUES ($1,$2, CASE WHEN $2 ~ '^\\d+' THEN (regexp_match($2,'^\\d+'))[1]::int ELSE 999 END)
             ON CONFLICT DO NOTHING`, [itemId, size]);
    revalidatePath(`/items/${itemId}`);
    return ok(`Size ${size} added.`);
  } catch (e) { return fail(errMsg(e)); }
}

export async function createPartyAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('STAFF');
  const kind = String(form.get('kind'));           // supplier | customer
  const name = String(form.get('name') ?? '').trim();
  const code = String(form.get('code') ?? '').trim().toUpperCase() || name.replace(/[^A-Za-z0-9]+/g, '').slice(0, 10).toUpperCase();
  if (!name) return fail('Name is needed.');
  try {
    const table = kind === 'customer' ? 'customers' : 'suppliers';
    const row = await q1<{ id: string }>(`INSERT INTO ${table} (code, name) VALUES ($1,$2) RETURNING id`, [code, name]);
    await audit(user.id, `${kind.toUpperCase()}_CREATED`, kind, row!.id);
    revalidatePath('/settings'); revalidatePath('/documents');
    return ok(`${kind === 'customer' ? 'Customer' : 'Supplier'} ${name} added.`);
  } catch (e) {
    return errMsg(e).includes('_code_key') ? fail(`Code ${code} is already used.`) : fail(errMsg(e));
  }
}

// ── Settings & users (admin) ─────────────────────────────────────────────────
export async function saveSettingAction(form: FormData): Promise<ActionResult> {
  const user = await apiUser('ADMIN');
  const key = String(form.get('key'));
  const raw = String(form.get('value') ?? '').trim();
  const kind = String(form.get('kind') ?? 'string');
  try {
    let value: unknown = raw;
    if (kind === 'number') { value = Number(raw); if (!Number.isFinite(value as number)) return fail('Enter a number.'); }
    if (kind === 'boolean') value = raw === 'true' || raw === 'on';
    if (kind === 'json') { try { value = JSON.parse(raw); } catch { return fail('Not valid JSON.'); } }
    await setSetting(getPool(), key, value, user.id);
    await audit(user.id, 'SETTING_CHANGED', 'setting', undefined, null, { key, value });
    revalidatePath('/settings');
    return ok('Setting saved.');
  } catch (e) { return fail(errMsg(e)); }
}

export async function createUserAction(form: FormData): Promise<ActionResult> {
  const admin = await apiUser('ADMIN');
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const name = String(form.get('name') ?? '').trim() || email.split('@')[0];
  const role = String(form.get('role') ?? 'STAFF');
  const password = String(form.get('password') ?? '');
  if (!email || password.length < 6) return fail('Email and a password of at least 6 characters are needed.');
  try {
    await q(`INSERT INTO users (email, name, role, password_hash, invited_by) VALUES ($1,$2,$3,$4,$5)`,
      [email, name, role, hashPassword(password), admin.id]);
    await audit(admin.id, 'USER_CREATED', 'user', undefined, null, { email, role });
    revalidatePath('/settings');
    return ok(`${name} can now log in.`);
  } catch (e) {
    return errMsg(e).includes('users_email_key') ? fail('That email already has a login.') : fail(errMsg(e));
  }
}

export async function toggleUserAction(form: FormData): Promise<ActionResult> {
  const admin = await apiUser('ADMIN');
  const id = String(form.get('userId'));
  if (id === admin.id) return fail('You cannot deactivate your own login.');
  try {
    await q(`UPDATE users SET is_active = NOT is_active WHERE id=$1`, [id]);
    revalidatePath('/settings');
    return ok('User updated.');
  } catch (e) { return fail(errMsg(e)); }
}

// ── Demo data ────────────────────────────────────────────────────────────────
export async function purgeDemoAction(_form?: FormData): Promise<ActionResult> {
  const user = await apiUser('ADMIN');
  try {
    await withTx(async (c) => {
      await c.query(`ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_immutable`);
      await c.query(`DELETE FROM inventory_movements WHERE item_id IN (SELECT id FROM items WHERE is_demo)
                     OR source_id IN (SELECT id FROM documents WHERE is_demo)`);
      await c.query(`ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_immutable`);
      await c.query(`DELETE FROM documents WHERE is_demo`);
      await c.query(`DELETE FROM purchase_orders WHERE is_demo`);
      await c.query(`DELETE FROM pos_imports WHERE is_demo`);
      await c.query(`DELETE FROM supplier_item_aliases WHERE is_demo OR supplier_id IN (SELECT id FROM suppliers WHERE is_demo)`);
      await c.query(`DELETE FROM findings WHERE supplier_id IN (SELECT id FROM suppliers WHERE is_demo)
                     OR item_id IN (SELECT id FROM items WHERE is_demo) OR document_id IS NOT NULL AND document_id NOT IN (SELECT id FROM documents)`);
      await c.query(`DELETE FROM item_sizes WHERE item_id IN (SELECT id FROM items WHERE is_demo)`);
      await c.query(`DELETE FROM items WHERE is_demo`);
      await c.query(`DELETE FROM suppliers WHERE is_demo`);
      await c.query(`DELETE FROM customers WHERE is_demo`);
      await c.query(`DELETE FROM stock_transfers WHERE is_demo`);
    });
    await audit(user.id, 'DEMO_PURGED');
    revalidatePath('/');
    return ok('Demo data removed. Real data is untouched.');
  } catch (e) { return fail(errMsg(e)); }
}
