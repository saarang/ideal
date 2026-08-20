import Decimal from 'decimal.js';
import { q, q1, withTx, dq, dq1 } from '../db';
import { getAI, PageImage, Extraction } from '../ai';
import { getSettings } from '../settings';
import { parseCaptionTag } from '../telegram/tags';
import { parseIndianDate } from '../format';
import { parseSequence, parseToken, ParsedToken } from '../domain/sizeNotation';
import { raiseFinding, raiseTask } from '../domain/findings';

async function pagesOf(documentId: string): Promise<PageImage[]> {
  const rows = await q<any>(
    `SELECT p.original_path, p.processed_path, p.mime_type, p.sha256, d.original_filename
     FROM document_pages p JOIN documents d ON d.id = p.document_id
     WHERE p.document_id=$1 ORDER BY p.page_no`, [documentId]);
  const { getStorage } = await import('../storage');
  const storage = getStorage();
  const path = await import('path');
  const fs = await import('fs/promises');
  const os = await import('os');
  // Providers read from local temp files; export from storage adapter first.
  const out: PageImage[] = [];
  for (const r of rows) {
    const key = r.processed_path ?? r.original_path;
    const buf = await storage.get(key);
    const tmp = path.join(os.tmpdir(), `ideal-${r.sha256}.jpg`);
    await fs.writeFile(tmp, buf);
    out.push({ path: tmp, mime: r.mime_type, sha256: r.sha256, filename: r.original_filename });
  }
  return out;
}

/** Stage 3 — Classification (explicit tag respected; conflicts flagged). */
export async function classifyDocument(documentId: string): Promise<void> {
  const doc = await q1<any>('SELECT * FROM documents WHERE id=$1', [documentId]);
  if (!doc) throw new Error('document not found');
  const settings = await getSettings();
  const pages = await pagesOf(documentId);
  const tag = parseCaptionTag(doc.tag_raw);
  const ai = getAI();
  const pred = await ai.classify(pages, { captionTag: tag?.tag ?? null });

  let docType = pred.docType;
  let source: string = 'AI';
  if (tag) {
    docType = tag.docType;
    source = 'TAG';
    if (pred.docType !== tag.docType && pred.confidence >= 0.85 && pred.docType !== 'UNKNOWN') {
      await raiseFinding(getPoolDb(), {
        type: 'DOCUMENT_CLASSIFICATION_UNCERTAIN', severity: 'INFO',
        title: `Tag says ${tag.docType}, AI suggests ${pred.docType}`,
        explanation: `The caption tag ${tag.tag} was kept, but the classifier confidently read this as ${pred.docType} (${pred.confidence}). Signals: ${pred.signals}`,
        documentId, dedupKey: `clsconflict:${documentId}`,
        recommendedAction: 'Open the document and confirm its type.',
      });
    }
  }

  await q(
    `UPDATE documents SET doc_type=$2, predicted_type=$3, classification_confidence=$4,
       classification_source=$5, classification_signals=$6, status='PROCESSING'
     WHERE id=$1`,
    [documentId, docType, pred.docType, pred.confidence, source, pred.signals]);

  if (!tag && pred.confidence < settings.classification_confirm_below) {
    await raiseFinding(getPoolDb(), {
      type: 'DOCUMENT_CLASSIFICATION_UNCERTAIN', severity: 'WARNING',
      title: `Document type uncertain (${Math.round(pred.confidence * 100)}%)`,
      explanation: `Predicted ${pred.docType} with low confidence. Signals: ${pred.signals}`,
      documentId, dedupKey: `clsuncertain:${documentId}`,
      recommendedAction: 'Confirm the document type before it is processed further.',
    });
    await raiseTask(getPoolDb(), {
      taskType: 'CONFIRM_DOCUMENT_TYPE', title: `Confirm document type for ${doc.ref_no}`,
      priority: 'HIGH', documentId, dedupKey: `type:${documentId}`,
      payload: { predicted: pred.docType, confidence: pred.confidence },
    });
  }
}

function getPoolDb() { const { getPool } = require('../db'); return getPool(); }

const conf = (parser: number, ocr?: number) => Math.min(parser, ocr ?? 1);

/** Stage 4+5 — OCR/structured extraction, then deterministic explosion of
 *  size/quantity tokens into one document line per (description, size). */
export async function extractDocument(documentId: string): Promise<void> {
  const doc = await q1<any>('SELECT * FROM documents WHERE id=$1', [documentId]);
  if (!doc) throw new Error('document not found');
  const settings = await getSettings();
  const pages = await pagesOf(documentId);
  const ai = getAI();
  const ex: Extraction = await ai.extract(pages, doc.doc_type);

  const dateParsed = parseIndianDate(ex.header.documentDateRaw ?? null);
  const dateConfidence = Math.min(dateParsed.confidence, 0.99);

  await withTx(async (tx) => {
    // Resolve supplier / customer by name (fuzzy, never auto-created).
    let supplierId: string | null = null;
    let supplierConf: number | null = null;
    if (ex.header.supplierName) {
      const m = await dq1<{ id: string; sim: number }>(tx,
        `SELECT id, similarity(name, $1) AS sim FROM suppliers WHERE is_active
         ORDER BY sim DESC LIMIT 1`, [ex.header.supplierName]);
      if (m && m.sim >= 0.45) { supplierId = m.id; supplierConf = Math.min(ex.header.supplierConfidence ?? 0.8, 0.5 + m.sim / 2); }
    }
    let customerId: string | null = null;
    if (ex.header.customerName) {
      const m = await dq1<{ id: string; sim: number }>(tx,
        `SELECT id, similarity(name, $1) AS sim FROM customers WHERE is_active
         ORDER BY sim DESC LIMIT 1`, [ex.header.customerName]);
      if (m && m.sim >= 0.45) customerId = m.id;
    }
    const defaultLoc = await dq1<{ id: string }>(tx, 'SELECT id FROM locations WHERE code=$1', [settings.default_receipt_location]);
    const shop = await dq1<{ id: string }>(tx, `SELECT id FROM locations WHERE code='SHOP'`);
    const godown = await dq1<{ id: string }>(tx, `SELECT id FROM locations WHERE code='GODOWN'`);
    const isReceipt = ['SUPPLIER_DELIVERY_CHALLAN', 'SUPPLIER_INVOICE', 'INWARD_BOOK'].includes(doc.doc_type);

    await dq(tx,
      `UPDATE documents SET
         document_number=$2, document_date=$3, document_date_raw=$4, document_date_confidence=$5,
         supplier_id=$6, supplier_name_raw=$7, supplier_confidence=$8,
         customer_id=$9, customer_name_raw=$10,
         po_ref=$11, challan_ref=$12, invoice_ref=$13,
         receipt_location_id=$14, dispatch_location_id=$15, destination_location_id=$16,
         subtotal=$17, tax_summary=$18, rounding=$19, grand_total=$20,
         handwritten_total_qty=$21, notes=$22, raw_text=$23, overall_confidence=$24
       WHERE id=$1`,
      [documentId,
       ex.header.documentNumber ?? null, dateParsed.iso, ex.header.documentDateRaw ?? null, dateConfidence,
       supplierId, ex.header.supplierName ?? null, supplierConf,
       customerId, ex.header.customerName ?? null,
       ex.header.poRef ?? null, ex.header.challanRef ?? null, ex.header.invoiceRef ?? null,
       isReceipt ? (defaultLoc?.id ?? null) : null,
       doc.doc_type === 'IDEAL_CUSTOMER_DELIVERY_CHALLAN' ? shop?.id ?? null
         : doc.doc_type === 'SHOP_TO_GODOWN_TRANSFER' ? shop?.id ?? null
         : doc.doc_type === 'GODOWN_TO_SHOP_TRANSFER' ? godown?.id ?? null : null,
       doc.doc_type === 'SHOP_TO_GODOWN_TRANSFER' ? godown?.id ?? null
         : doc.doc_type === 'GODOWN_TO_SHOP_TRANSFER' ? shop?.id ?? null : null,
       ex.header.subtotalShown ?? null,
       JSON.stringify(ex.header.taxes ?? []),
       ex.header.roundingShown ?? null, ex.header.grandTotalShown ?? null,
       ex.header.handwrittenTotalQty ?? null, ex.header.notes ?? null,
       ex.rawText, ex.overallConfidence]);

    await dq(tx, 'DELETE FROM document_lines WHERE document_id=$1', [documentId]);

    const ctx = {
      knownComposites: settings.known_composite_sizes,
      plausibleSizeMin: settings.plausible_size_min,
      plausibleSizeMax: settings.plausible_size_max,
    };

    for (const line of ex.lines) {
      const rate = line.rate ?? null;
      const lineCtx = { ...ctx, layoutHint: line.layoutHint ?? null };
      // A description the reader could barely make out (a faint Marathi word,
      // a smudged abbreviation) always goes to a person, however clear the
      // size and quantity beside it were.
      const descUnclear = (line.conf.description ?? 1) < settings.conf_medium;
      let subNo = 0;

      const insert = async (vals: {
        sizeRaw: string | null; sizeNorm: string | null; notation: string; qty: number | null;
        confSize: number; confQty: number; needsReview: boolean; note?: string | null;
      }) => {
        subNo += 1;
        const amountShown = subNo === 1 ? line.amountShown ?? null : null;
        const amountCalc = vals.qty !== null && rate !== null
          ? new Decimal(vals.qty).times(new Decimal(rate)).toFixed(2) : null;
        await dq(tx,
          `INSERT INTO document_lines (document_id, line_no, sub_no, raw_text, raw_description,
             normalized_description, supplier_item_code, colour, size_raw, size_normalized, notation,
             quantity, unit_rate, amount_shown, amount_calculated, page_no, bbox, conf,
             mapping_status, review_status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [documentId, line.lineNo, subNo, line.rawText ?? null, line.description ?? null,
           line.description?.trim().toUpperCase() ?? null, line.supplierItemCode ?? null, line.colour ?? null,
           vals.sizeRaw, vals.sizeNorm, vals.notation,
           vals.qty, rate, amountShown, amountCalc, line.pageNo,
           line.bbox ? JSON.stringify(line.bbox) : null,
           JSON.stringify({ description: line.conf.description ?? null, size: vals.confSize, quantity: vals.confQty, rate: line.conf.rate ?? null, amount: line.conf.amount ?? null }),
           'UNMAPPED', vals.needsReview ? 'NEEDS_REVIEW' : 'NOT_REQUIRED', vals.note ?? null]);
      };

      if (line.sizeTokens.length) {
        const parsed: ParsedToken[] = parseSequence(line.sizeTokens, lineCtx);
        // A printed bill often puts ONE size in the Size column ("12/14", a
        // composite) and its count in a separate Qty column. The token itself
        // carries no quantity in that case, so take the line's quantity —
        // otherwise the pieces would silently vanish. Only safe for a single
        // token: with several, the line quantity is the row's total.
        const singleSizedToken = parsed.length === 1
          && (parsed[0].kind === 'COMPOSITE_SIZE' || parsed[0].kind === 'SIZE_ONLY')
          && parsed[0].quantity === null
          && line.quantity !== null && line.quantity !== undefined;
        for (const t of parsed) {
          if (t.kind === 'EMPTY') continue;
          const effSize = conf(t.confidence, line.conf.size);
          const effQty = conf(t.confidence, line.conf.quantity);
          const needsReview = t.kind === 'AMBIGUOUS' || effSize < settings.conf_medium
            || (t.quantity !== null && effQty < settings.conf_medium)
            || descUnclear;
          await insert({
            sizeRaw: t.raw,
            sizeNorm: t.kind === 'AMBIGUOUS' ? null : t.size,
            notation: t.kind,
            qty: singleSizedToken ? line.quantity! : (t.kind === 'SIZE_ONLY' ? null : t.quantity),
            confSize: effSize, confQty: effQty,
            needsReview,
            note: t.kind === 'AMBIGUOUS' ? `Interpretation uncertain: ${t.reason}. Proposed size ${t.size ?? '?'} × ${t.quantity ?? '?'}.` : null,
          });
          if (t.kind === 'AMBIGUOUS') {
            await raiseFinding(tx, {
              type: 'SIZE_INTERPRETATION_REQUIRED', severity: 'WARNING',
              title: `Uncertain size/quantity "${t.raw}" — ${line.description ?? 'line ' + line.lineNo}`,
              explanation: `${t.reason}. Raw text preserved; nothing is posted until confirmed.`,
              documentId, actual: t.raw,
              recommendedAction: 'Open the document, view the highlighted line and confirm size and quantity.',
              dedupKey: `sizeamb:${documentId}:${line.lineNo}:${subNo}`,
            });
            await raiseTask(tx, {
              taskType: 'CONFIRM_SIZE_QTY', priority: 'HIGH',
              title: `Confirm "${t.raw}" on ${doc.ref_no} (${line.description ?? 'line ' + line.lineNo})`,
              documentId, dedupKey: `sizeamb:${documentId}:${line.lineNo}:${subNo}`,
              payload: { raw: t.raw, proposedSize: t.size, proposedQty: t.quantity, reason: t.reason },
            });
          }
        }
        // Per-line handwritten total vs the sum of its confident tokens.
        // Skipped when the line's quantity was consumed by a single sized
        // token above — there is nothing left to disagree with.
        if (!singleSizedToken && line.quantity !== null && line.quantity !== undefined) {
          const confirmed = parsed.filter((t) => t.kind === 'SIZE_OVER_QTY').reduce((s, t) => s + (t.quantity ?? 0), 0);
          const ambiguous = parsed.filter((t) => t.kind === 'AMBIGUOUS').reduce((s, t) => s + (t.quantity ?? 0), 0);
          if (confirmed !== line.quantity && confirmed + ambiguous !== line.quantity) {
            await raiseFinding(tx, {
              type: 'TOTAL_QTY_MISMATCH', severity: 'WARNING',
              title: `Line total ${line.quantity} ≠ sum of sizes ${confirmed}${ambiguous ? ` (+${ambiguous} uncertain)` : ''}`,
              explanation: `"${line.description ?? ''}": the handwritten line quantity does not match the extracted size breakdown.`,
              documentId, expected: String(line.quantity), actual: String(confirmed), difference: String(line.quantity - confirmed),
              dedupKey: `lineqty:${documentId}:${line.lineNo}`,
              recommendedAction: 'Check the size breakdown against the image.',
            });
          }
        }
      } else if (line.sizeSingle) {
        const t = parseToken(line.sizeSingle, { ...lineCtx, layoutHint: 'SIZE_QTY_COLUMNS' });
        const size = t.kind === 'COMPOSITE_SIZE' ? t.size : t.kind === 'SIZE_ONLY' ? t.size : line.sizeSingle;
        const effSize = conf(t.confidence, line.conf.size);
        await insert({
          sizeRaw: line.sizeSingle, sizeNorm: size, notation: t.kind === 'COMPOSITE_SIZE' ? 'COMPOSITE_SIZE' : 'PLAIN',
          qty: line.quantity ?? null,
          confSize: effSize, confQty: line.conf.quantity ?? 0.8,
          needsReview: effSize < settings.conf_medium || (line.conf.quantity ?? 1) < settings.conf_medium || descUnclear,
          note: descUnclear ? `The written description was hard to read (${Math.round((line.conf.description ?? 0) * 100)}% sure). Raw text kept as written.` : null,
        });
      } else {
        // Quantity-only lines (e.g. "50 PC Maroon Dupatta") — size FREE.
        await insert({
          sizeRaw: null, sizeNorm: 'FREE', notation: 'PLAIN', qty: line.quantity ?? null,
          confSize: 0.9, confQty: line.conf.quantity ?? 0.8,
          needsReview: (line.conf.quantity ?? 1) < settings.conf_medium || line.quantity === null || descUnclear,
          note: descUnclear ? `The written description was hard to read (${Math.round((line.conf.description ?? 0) * 100)}% sure). Raw text kept as written.` : null,
        });
      }
    }
  });
}
