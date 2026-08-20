/**
 * The full intake pipeline against the mock AI fixtures (the same five real
 * papers the shop supplied): a photo arrives, is classified, read, checked,
 * matched to items and put in the right state — with review tasks raised
 * wherever the system is not sure.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import sharp from 'sharp';
import { resetDb, seedCore, makeItem, makeSupplier, closeDb, CoreIds } from './helpers/db';

let core: CoreIds;

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 800, channels: 3, background: '#ffffff' } })
    .jpeg().toBuffer();
}

/** Ingest a photo whose filename steers the mock AI to a fixture. */
async function sendPhoto(filename: string, captionTag?: string): Promise<string> {
  const { ingestImages } = await import('@/src/lib/pipeline/ingest');
  const { runPipeline } = await import('@/src/lib/pipeline/runner');
  const r = await ingestImages({
    files: [{ buffer: await jpeg(), filename }],
    captionTag: captionTag ?? null,
    source: 'TELEGRAM',
    telegram: { chatId: 'test-chat', messageId: String(Date.now() + Math.random()), uploader: 'Papa' },
  });
  await runPipeline(r.documentId, 'PREPARE');
  return r.documentId;
}

async function doc(id: string) {
  const { q1 } = await import('@/src/lib/db');
  return q1<{
    doc_type: string; status: string; document_number: string | null; document_date: string | null;
    supplier_id: string | null; customer_id: string | null; grand_total: string | null;
    calculated_total_qty: number | null; classification_confidence: string | null;
  }>(`SELECT doc_type, status, document_number, document_date, supplier_id, customer_id,
             grand_total, calculated_total_qty, classification_confidence
      FROM documents WHERE id=$1`, [id]);
}
async function lines(id: string) {
  const { q } = await import('@/src/lib/db');
  return q<{ raw_description: string | null; size_normalized: string | null; quantity: number | null;
             mapping_status: string; review_status: string; item_id: string | null }>(
    `SELECT raw_description, size_normalized, quantity, mapping_status, review_status, item_id
     FROM document_lines WHERE document_id=$1 ORDER BY line_no, sub_no`, [id]);
}
async function tasks(id: string) {
  const { q } = await import('@/src/lib/db');
  return q<{ task_type: string; title: string; status: string }>(
    `SELECT task_type, title, status FROM workflow_tasks WHERE document_id=$1 ORDER BY created_at`, [id]);
}

beforeEach(async () => {
  await resetDb();
  core = await seedCore();
});
afterAll(async () => { await closeDb(); });

describe('supplier bill (Sanjay Dresses #1873)', () => {
  it('classifies, reads the header and totals, and lands in a reviewable state', async () => {
    await makeSupplier('SANJAY', 'Sanjay Dresses');
    const id = await sendPhoto('sanjay_invoice_1873.jpg');
    const d = await doc(id);

    expect(d?.doc_type).toBe('SUPPLIER_INVOICE');
    expect(d?.document_number).toBe('1873');
    expect(d?.document_date).toBeTruthy();
    expect(d?.supplier_id).toBeTruthy();                 // fuzzy-linked to Sanjay Dresses
    expect(Number(d?.grand_total)).toBeCloseTo(27407.10, 2);
    expect(['NEEDS_REVIEW', 'READY_TO_POST']).toContain(d?.status);

    const ls = await lines(id);
    expect(ls.length).toBeGreaterThan(0);
    // Nothing is mapped yet — no aliases exist, so every stock line asks for mapping.
    expect(ls.every((l) => l.item_id === null)).toBe(true);
    const ts = await tasks(id);
    expect(ts.some((t) => t.task_type === 'MAP_ITEM')).toBe(true);
  });

  it('uses a confirmed supplier alias to map lines automatically', async () => {
    const supplierId = await makeSupplier('SANJAY', 'Sanjay Dresses');
    const itemId = await makeItem('IU-NB-HPTC', 'Navy Blue Half Pant T.C.', ['12/14', '15', '16', '17']);
    const { getPool } = await import('@/src/lib/db');
    await getPool().query(
      `INSERT INTO supplier_item_aliases (supplier_id, supplier_description, item_id, status, mapping_confidence)
       VALUES ($1, 'N.BLUE H.P.T.C. BHARI', $2, 'USER_CONFIRMED', 1.0)`, [supplierId, itemId]);

    const id = await sendPhoto('sanjay_invoice_1873.jpg');
    const ls = await lines(id);
    const mapped = ls.filter((l) => l.item_id === itemId);
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.every((l) => l.mapping_status === 'USER_CONFIRMED')).toBe(true);
  });
});

describe('supplier challan with unclear lines (Sarda)', () => {
  it('keeps the low-confidence supplier name a question and raises review tasks', async () => {
    const id = await sendPhoto('sarda_challan.jpg');
    const d = await doc(id);
    expect(d?.doc_type).toBe('SUPPLIER_DELIVERY_CHALLAN');
    expect(d?.status).toBe('NEEDS_REVIEW');

    const ts = await tasks(id);
    expect(ts.length).toBeGreaterThan(0);
    // Unreadable Marathi lines must surface as review work, never be dropped.
    const ls = await lines(id);
    expect(ls.some((l) => l.review_status === 'NEEDS_REVIEW')).toBe(true);
  });
});

describe('inward book pages (aavak vahi)', () => {
  it('reads the Aarena page and flags the unclear yellow row', async () => {
    const id = await sendPhoto('aavak_vahi_aarena.jpg', '#inward');
    const d = await doc(id);
    expect(d?.doc_type).toBe('INWARD_BOOK');
    const ls = await lines(id);
    expect(ls.length).toBeGreaterThan(0);
    expect(ls.some((l) => l.review_status === 'NEEDS_REVIEW')).toBe(true);
  });

  it('reads the GMK page including its size/quantity pairs', async () => {
    const id = await sendPhoto('aavak_vahi_2_gmk.jpg', '#inward');
    const ls = await lines(id);
    // WHITE-SK 18/11 must be read as size 18, quantity 11 — not 1.64.
    const white = ls.find((l) => (l.raw_description ?? '').toUpperCase().includes('WHITE'));
    expect(white).toBeTruthy();
    expect(white!.size_normalized).toBe('18');
    expect(white!.quantity).toBe(11);
  });
});

describe('own delivery challan to a customer (The Jaan Foundation)', () => {
  it('is recognised as an outgoing delivery and linked to the customer', async () => {
    const { getPool } = await import('@/src/lib/db');
    await getPool().query(`INSERT INTO customers (code, name) VALUES ('JAAN','The Jaan Foundation')`);
    const id = await sendPhoto('ideal_delivery_challan_94.jpg');
    const d = await doc(id);
    expect(d?.doc_type).toBe('IDEAL_CUSTOMER_DELIVERY_CHALLAN');
    expect(d?.customer_id).toBeTruthy();
    expect(d?.document_number).toBe('94');
    expect(d?.calculated_total_qty).toBe(204);
  });
});

describe('intake safeguards', () => {
  it('the same photo sent twice is recognised as a duplicate, not counted twice', async () => {
    const { ingestImages } = await import('@/src/lib/pipeline/ingest');
    const buffer = await jpeg();
    const first = await ingestImages({
      files: [{ buffer, filename: 'sanjay_invoice_1873.jpg' }],
      source: 'TELEGRAM', telegram: { chatId: 'c', messageId: '1', uploader: 'Papa' },
    });
    const second = await ingestImages({
      files: [{ buffer, filename: 'sanjay_invoice_1873.jpg' }],
      source: 'TELEGRAM', telegram: { chatId: 'c', messageId: '2', uploader: 'Papa' },
    });
    expect(second.duplicate).toBe(true);
    expect(second.duplicateOfRef).toBe(first.refNo);
  });

  it('an unrecognisable photo asks a person what it is rather than guessing', async () => {
    const id = await sendPhoto('random_holiday_photo.jpg');
    const d = await doc(id);
    const ts = await tasks(id);
    const unsure = d?.doc_type === 'UNKNOWN'
      || Number(d?.classification_confidence ?? 1) < 0.8
      || ts.some((t) => t.task_type === 'CONFIRM_DOCUMENT_TYPE');
    expect(unsure).toBe(true);
  });

  it('a caption tag is respected as the document type', async () => {
    const id = await sendPhoto('aavak_vahi_aarena.jpg', '#inward');
    const d = await doc(id);
    expect(d?.doc_type).toBe('INWARD_BOOK');
  });
});

describe('a size in the Size column with its count in the Qty column', () => {
  it('keeps the quantity — a composite size must not lose its pieces', async () => {
    await makeSupplier('SANJAY', 'Sanjay Dresses');
    const id = await sendPhoto('sanjay_invoice_1873.jpg');
    const ls = await lines(id);
    const composite = ls.filter((l) => l.size_normalized === '12/14' || l.size_normalized === '28/32');
    expect(composite.length).toBe(2);
    for (const l of composite) {
      expect(l.quantity).toBe(36);   // 36 pcs each, read from the Qty column
    }
    // And the document's own total counts them.
    const { q1 } = await import('@/src/lib/db');
    const d = await q1<{ calculated_total_qty: number }>(
      `SELECT calculated_total_qty FROM documents WHERE id=$1`, [id]);
    expect(d?.calculated_total_qty).toBe(178);   // 66 half pants + 48 pinos + 64 skirts
  });
});
