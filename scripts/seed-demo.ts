/**
 * Demo seed — a guided-tour dataset built on the five real sample documents
 * (as mock-AI fixtures). Everything it creates is flagged is_demo where the
 * schema allows, so it can coexist with early real data.
 *
 *   npm run seed:core   (first)
 *   npm run seed:demo
 *
 * What you get:
 *  • Suppliers: Sanjay Dresses, Sarda, Aarena, GMK — customer: The Jaan Foundation
 *  • Item master with sizes + opening stock at SHOP/GODOWN
 *  • Confirmed aliases for most Sanjay Dresses descriptions (auto-mapping demo);
 *    one description left unmapped so the Mapping workbench has work
 *  • A purchase order the Sanjay invoice partially fulfils, and an old GMK
 *    order that the overdue scan flags
 *  • The five sample photos generated as JPEGs in ./samples and pushed through
 *    ingest → classify → extract → validate → match → status
 *  • The Ideal→Jaan challan left READY_TO_POST so "Post to stock" can be
 *    demonstrated live; the Sanjay invoice posted so the ledger has receipts
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { q, q1, closePool, getPool, withTx } from '../src/lib/db';
import { ingestImages } from '../src/lib/pipeline/ingest';
import { runPipeline } from '../src/lib/pipeline/runner';
import { runPeriodicScans } from '../src/lib/pipeline/recon';
import { postMovements } from '../src/lib/domain/ledger';

const SAMPLES_DIR = path.join(process.cwd(), 'samples');

// ── tiny SVG "document photo" generator ──────────────────────────────────────
async function docImage(file: string, title: string, lines: string[]): Promise<string> {
  const body = lines.map((l, i) =>
    `<text x="60" y="${180 + i * 44}" font-family="serif" font-size="30" fill="#1f2937">${l
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${240 + lines.length * 44}">
    <rect width="100%" height="100%" fill="#fdf9ef"/>
    <rect x="20" y="20" width="860" height="${200 + lines.length * 44}" fill="none" stroke="#c8bfa8" stroke-width="2"/>
    <text x="60" y="90" font-family="serif" font-size="40" font-weight="bold" fill="#111827">${title}</text>
    <line x1="60" y1="120" x2="840" y2="120" stroke="#c8bfa8" stroke-width="2"/>
    ${body}
  </svg>`;
  const out = path.join(SAMPLES_DIR, file);
  await fs.mkdir(SAMPLES_DIR, { recursive: true });
  await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(out);
  return out;
}

async function upsert<T extends { id: string }>(sql: string, params: unknown[]): Promise<string> {
  const row = await q1<T>(sql, params);
  if (!row) throw new Error(`Upsert returned nothing: ${sql.slice(0, 60)}`);
  return row.id;
}

async function ensureItem(code: string, name: string, category: string, sizes: string[], opts?: { colour?: string }): Promise<string> {
  let cat = await q1<{ id: string }>(`SELECT id FROM item_categories WHERE lower(name)=lower($1)`, [category]);
  if (!cat) cat = await q1<{ id: string }>(`INSERT INTO item_categories (name) VALUES ($1) RETURNING id`, [category]);
  const id = await upsert(
    `INSERT INTO items (code, name, category_id, colour, is_demo) VALUES ($1,$2,$3,$4,TRUE)
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [code, name, cat!.id, opts?.colour ?? null]);
  for (const s of sizes) {
    await q(`INSERT INTO item_sizes (item_id, size, sort_order)
             VALUES ($1,$2, CASE WHEN $2 ~ '^\\d+' THEN (regexp_match($2,'^\\d+'))[1]::int ELSE 999 END)
             ON CONFLICT (item_id, size) DO NOTHING`, [id, s]);
  }
  return id;
}

async function main() {
  const pool = getPool();
  const shop = await q1<{ id: string }>(`SELECT id FROM locations WHERE code='SHOP'`);
  const godown = await q1<{ id: string }>(`SELECT id FROM locations WHERE code='GODOWN'`);
  if (!shop || !godown) throw new Error('Run npm run seed:core first.');
  const admin = await q1<{ id: string }>(`SELECT id FROM users WHERE role='ADMIN' ORDER BY created_at LIMIT 1`);

  console.log('→ Suppliers & customer');
  const sanjay = await upsert(`INSERT INTO suppliers (code,name,gstin,is_demo) VALUES ('SANJAY','Sanjay Dresses','27AJCPM8167B1Z8',TRUE)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, []);
  const sarda = await upsert(`INSERT INTO suppliers (code,name,is_demo) VALUES ('SARDA','Sarda',TRUE)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, []);
  const aarena = await upsert(`INSERT INTO suppliers (code,name,is_demo) VALUES ('AARENA','Aarena',TRUE)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, []);
  const gmk = await upsert(`INSERT INTO suppliers (code,name,is_demo) VALUES ('GMK','GMK',TRUE)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, []);
  const jaan = await upsert(`INSERT INTO customers (code,name,is_demo) VALUES ('JAAN','The Jaan Foundation',TRUE)
    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, []);

  console.log('→ Item master');
  const hptc = await ensureItem('IU-NB-HPTC', 'Navy Blue Half Pant T.C. Bhari', 'Half Pants', ['12/14', '15', '16', '17'], { colour: 'Navy Blue' });
  const pino = await ensureItem('IU-NB-PINO', 'Navy Blue Pino Bhari Pant', 'Full Pants', ['28/32', '34'], { colour: 'Navy Blue' });
  const skirt = await ensureItem('IU-NB-SKIRT', 'Navy Blue Sada Skirt Bhari (Side Chain)', 'Skirts', ['12', '13', '14', '15', '16', '18'], { colour: 'Navy Blue' });
  const jacket = await ensureItem('IU-MRN-JKT', 'Maroon Jacket', 'Jackets', ['26', '28', '30', '32', '34', '36', '38', '40'], { colour: 'Maroon' });
  const punjabi = await ensureItem('IU-PNK-PNJB', 'Pink Punjabi Set (Top & Salwar)', 'Sets', ['28', '30', '32', '34', '36', '38', '40'], { colour: 'Pink' });
  const dupatta = await ensureItem('IU-MRN-DPT', 'Maroon Dupatta', 'Accessories', ['FREE'], { colour: 'Maroon' });
  const nhTrack = await ensureItem('IU-NH-TRK', 'NH Track Pant', 'Track Pants', ['28', '32', '34', '36', '38', '40', '42']);
  const shivkar = await ensureItem('IU-SHV-TSH', 'Shivkar T-Shirt', 'T-Shirts', ['24', '26', '28', '36', '38']);
  const spv = await ensureItem('IU-SPV-TSH', 'SPV Red T-Shirt', 'T-Shirts', ['22', '24'], { colour: 'Red' });
  await ensureItem('IU-SCT-KITE', 'Scout Kite Uniform', 'Uniform Sets', ['FREE']);
  await ensureItem('IU-RSP-KITE', 'RSP Kite Uniform', 'Uniform Sets', ['FREE']);
  await ensureItem('IU-WHT-SK', 'White SK Shirt', 'Shirts', ['18'], { colour: 'White' });
  const bushirt = await ensureItem('IU-BUSHIRT', 'Bushirt (College)', 'Shirts', ['34', '36', '40']);
  const collegePant = await ensureItem('IU-CLG-PANT', 'College Pant', 'Full Pants', ['36', '40', '41', '42']);
  const sssPant = await ensureItem('IU-SSS-PANT', 'SSS Pant', 'Full Pants', ['42']);

  console.log('→ Confirmed aliases for Sanjay Dresses (auto-mapping demo)');
  const alias = async (supplierId: string, desc: string, itemId: string) => q(
    `INSERT INTO supplier_item_aliases (supplier_id, supplier_description, item_id, status, mapping_confidence, approved_by)
     SELECT $1,$2,$3,'USER_CONFIRMED',1.0,$4
     WHERE NOT EXISTS (SELECT 1 FROM supplier_item_aliases WHERE supplier_id=$1 AND lower(supplier_description)=lower($2))`,
    [supplierId, desc, itemId, admin?.id ?? null]);
  await alias(sanjay, 'N.BLUE H.P.T.C. BHARI', hptc);
  await alias(sanjay, 'N.BLUE PINO BHARI', pino);
  // 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN' left unmapped on purpose → Mapping workbench demo.
  await alias(sarda, 'Bushirt', bushirt);
  await alias(sarda, 'College Pants', collegePant);
  await alias(sarda, 'SSS Pant', sssPant);
  await alias(aarena, 'NH Track', nhTrack);
  await alias(aarena, 'Shivkar (TSH)', shivkar);
  await alias(aarena, 'SPV Red TSH', spv);

  console.log('→ Opening stock (01-07-2026)');
  const opening: [string, string, string, number][] = [
    [jacket, '26', 'SHOP', 8], [jacket, '28', 'SHOP', 6], [jacket, '30', 'SHOP', 20], [jacket, '32', 'SHOP', 15],
    [jacket, '34', 'SHOP', 10], [jacket, '36', 'SHOP', 18], [jacket, '38', 'SHOP', 6], [jacket, '40', 'SHOP', 6],
    [punjabi, '28', 'SHOP', 15], [punjabi, '30', 'SHOP', 15], [punjabi, '32', 'SHOP', 25], [punjabi, '34', 'SHOP', 25],
    [punjabi, '36', 'SHOP', 25], [punjabi, '38', 'SHOP', 12], [punjabi, '40', 'SHOP', 12],
    [dupatta, 'FREE', 'SHOP', 60], [dupatta, 'FREE', 'GODOWN', 40],
    [nhTrack, '32', 'GODOWN', 10], [shivkar, '26', 'GODOWN', 12],
    [skirt, '14', 'SHOP', 4],
  ];
  await withTx(async (client) => {
    await postMovements(client, opening.map(([itemId, size, loc, qty]) => ({
      movementType: 'OPENING' as const, itemId, size,
      locationId: loc === 'SHOP' ? shop.id : godown.id, qty,
      businessDate: '2026-07-01', sourceType: 'MANUAL',
      reason: 'Demo opening stock', createdBy: admin?.id ?? null,
    })));
  });

  console.log('→ Purchase orders');
  const po1 = await q1<{ id: string }>(
    `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, is_demo, notes, created_by)
     VALUES ($1,'2026-07-18','2026-07-28',TRUE,'School reopening stock — demo',$2) RETURNING id`,
    [sanjay, admin?.id ?? null]);
  const poLines1: [string, string | null, string, number][] = [
    [hptc, 'N.Blue H.P.T.C. Bhari', '12/14', 36], [hptc, null, '15', 12], [hptc, null, '16', 12], [hptc, null, '17', 6],
    [pino, 'N.Blue Pino Bhari', '28/32', 36], [pino, null, '34', 12],
    [skirt, 'N.Blue Sada Skirt (side chain)', '14', 8], [skirt, null, '15', 12], [skirt, null, '16', 12],
  ];
  for (let i = 0; i < poLines1.length; i++) {
    const [itemId, desc, size, qty] = poLines1[i];
    await q(`INSERT INTO purchase_order_lines (po_id, line_no, item_id, description_raw, size, quantity_ordered)
             VALUES ($1,$2,$3,$4,$5,$6)`, [po1!.id, i + 1, itemId, desc, size, qty]);
  }
  // Old GMK order → overdue scan demo.
  const po2 = await q1<{ id: string }>(
    `INSERT INTO purchase_orders (supplier_id, order_date, expected_date, is_demo, notes, created_by)
     VALUES ($1,'2026-06-20','2026-07-05',TRUE,'Kite uniforms — demo (will show as overdue)',$2) RETURNING id`,
    [gmk, admin?.id ?? null]);
  const scout = await q1<{ id: string }>(`SELECT id FROM items WHERE code='IU-SCT-KITE'`);
  await q(`INSERT INTO purchase_order_lines (po_id, line_no, item_id, description_raw, size, quantity_ordered)
           VALUES ($1,1,$2,'Scout Kite uniforms','FREE',40)`, [po2!.id, scout!.id]);

  console.log('→ Generating sample document photos');
  const sanjayImg = await docImage('sanjay_invoice_1873.jpg', 'SANJAY DRESSES — GST TAX INVOICE No. 1873', [
    'Date: 26-07-2026   GSTIN 27AJCPM8167B1Z8   To: Ideal Uniform, New Panvel',
    'N.BLUE H.P.T.C. BHARI   12/14 x36 @118 · 15 x12 @126 · 16 x12 @130 · 17 x6 @136',
    'N.BLUE PINO BHARI       28/32 x36 @165 · 34 x12 @175',
    'N.BLUE SADA SKIRTS BHARI SIDE CHAIN   12x6 13x6 14x8 15x12 16x12 18x8',
    'Subtotal 26102.00   CGST 2.5% 652.55   SGST 2.5% 652.55   NETT 27407.10',
  ]);
  const jaanImg = await docImage('ideal_delivery_challan_94.jpg', 'IDEAL — DELIVERY CHALLAN No. 94', [
    'Date: 13-08-26   To: The Jaan Foundation, Panvel',
    'Maroon Jacket    26/5 28/2 30/14 32/9 34/5 36/13 38/2 40/2  = 52',
    'Pink Punjabi Set 28/5 30/7 32/10 34/10 36/10 38/5 40/5      = 52',
    '50 PC Maroon Dupatta',
    'Pink Punjabi Set 28/5 30/5 32/10 34/10 36/10 38/5 40/5      = 50',
    'Total 204 PC   Received by: (signed)',
  ]);
  const sardaImg = await docImage('sarda_challan.jpg', 'To IDEAL UNI, N.Panvel — 18/8/26', [
    'Particulars        Size   PC',
    'Bushirt             36    18',
    '(Marathi word)      40    06',
    '(Marathi word)      34    06',
    'Collegepants        36    01  · 40 13 · 42 04',
    '31142/college       41    36',
    'SSS Pant            42    32        Total 116   [584 x 1]',
  ]);
  const aavak1Img = await docImage('aavak_vahi_aarena.jpg', 'AAVAK VAHI — From: Aarena — 5-7-26', [
    '2 Bag received from home 5/7/26',
    'NH Track Green: 28/4 32/4 34/4 36/4 38/2 40/3 42/–',
    'NH Track Yellow: 4/8 –/4 4/8 –/4 4/6 4/7 2/2 (unclear)',
    'SPV Red TSH 22/13 24/13 (circled)   Bag(1): 39',
    'Shivkar TSH Blue 24/6 26/6 28/3 · Green 26/6 28/4 · Yellow 26/6 28/6 36/6 38/3',
    'Slip: Bag(1) Track-NH = 39 pc, Bag(2) = 72 pc — Manish. Signed Muskan.',
  ]);
  const aavak2Img = await docImage('aavak_vahi_2_gmk.jpg', 'AAVAK VAHI — From: GMK — 19|7|26', [
    '1 parcel received from home 19/7/26',
    'Scout-Kite: 15 pc',
    'RSP-Kite: 10 pc',
    'WHITE-SK: 18/11',
    'Signed Raj.',
  ]);

  console.log('→ Ingesting samples through the full pipeline (mock AI)');
  const ingestOne = async (file: string) => {
    const buffer = await fs.readFile(file);
    const r = await ingestImages({
      files: [{ buffer, filename: path.basename(file) }],
      source: 'SEED', isDemo: true,
    });
    const run = await runPipeline(r.documentId, 'PREPARE');
    console.log(`   ${path.basename(file)} → ${r.refNo} ${run.ok ? '' : `(failed at ${run.failedStage}: ${run.error})`}`);
    return r.documentId;
  };
  const sanjayDoc = await ingestOne(sanjayImg);
  const jaanDoc = await ingestOne(jaanImg);
  await ingestOne(sardaImg);
  await ingestOne(aavak1Img);
  await ingestOne(aavak2Img);

  // Mark demo docs so they can be filtered/purged.
  await q(`UPDATE documents SET is_demo=TRUE WHERE source='SEED'`);

  console.log('→ Confirming customer-challan suggestions so it is READY_TO_POST');
  await q(`UPDATE document_lines SET mapping_status='USER_CONFIRMED'
           WHERE document_id=$1 AND mapping_status='AI_SUGGESTED'`, [jaanDoc]);
  const { refreshDocumentStatus } = await import('../src/lib/pipeline/status');
  const jaanStatus = await refreshDocumentStatus(jaanDoc);
  console.log(`   Ideal→Jaan challan: ${jaanStatus.status}${jaanStatus.blockers.length ? ' — ' + jaanStatus.blockers.join(' | ') : ''}`);

  console.log('→ Posting the Sanjay invoice (receipts land in stock, PO fills up)');
  const sanjayStatus = await refreshDocumentStatus(sanjayDoc);
  if (sanjayStatus.status === 'READY_TO_POST') {
    const { postDocument } = await import('../src/lib/pipeline/post');
    const out = await postDocument(sanjayDoc, admin?.id ?? null);
    console.log(`   ${out.status}: ${out.message}`);
  } else {
    console.log(`   Left in ${sanjayStatus.status}: ${sanjayStatus.blockers.join(' | ')} (mapping workbench demo)`);
  }

  console.log('→ Reconciliation scans (overdue GMK order should appear)');
  console.log('  ', await runPeriodicScans());

  const counts = await q1<{ docs: number; findings: number; tasks: number; moves: number }>(
    `SELECT (SELECT count(*) FROM documents)::int AS docs,
            (SELECT count(*) FROM findings WHERE status='OPEN')::int AS findings,
            (SELECT count(*) FROM workflow_tasks WHERE status='OPEN')::int AS tasks,
            (SELECT count(*) FROM inventory_movements)::int AS moves`);
  console.log(`\nDemo ready: ${counts!.docs} documents, ${counts!.moves} stock movements, ${counts!.findings} open findings, ${counts!.tasks} open tasks.`);
  console.log('Log in and start at the Dashboard.');
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
