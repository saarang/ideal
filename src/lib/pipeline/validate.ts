import { q, q1, getPool } from '../db';
import { getSettings } from '../settings';
import { checkInvoice, InvoiceInput } from '../domain/arithmetic';
import { raiseFinding, raiseTask } from '../domain/findings';

/** Build the deterministic-arithmetic input for a document from stored rows. */
export async function invoiceInputFor(documentId: string): Promise<InvoiceInput> {
  const doc = await q1<any>('SELECT * FROM documents WHERE id=$1', [documentId]);
  const lines = await q<any>(
    `SELECT * FROM document_lines WHERE document_id=$1 AND quantity IS NOT NULL ORDER BY line_no, sub_no`,
    [documentId]);
  return {
    lines: lines.map((l) => ({
      lineRef: `${l.line_no}.${l.sub_no}`,
      description: l.raw_description,
      quantity: l.quantity,
      rate: l.unit_rate,
      discount: l.discount,
      amountShown: l.amount_shown,
    })),
    taxes: (doc.tax_summary ?? []).map((t: any) => ({ kind: t.kind, ratePct: t.ratePct, amountShown: t.amountShown })),
    subtotalShown: doc.subtotal,
    roundingShown: doc.rounding,
    grandTotalShown: doc.grand_total,
    handwrittenTotalQty: doc.handwritten_total_qty,
  };
}

/** Stage 6 — deterministic validation. AI output is treated as provisional;
 *  every check here is plain code with decimal-safe arithmetic. */
export async function validateDocument(documentId: string): Promise<void> {
  const db = getPool();
  const doc = await q1<any>('SELECT * FROM documents WHERE id=$1', [documentId]);
  if (!doc) throw new Error('document not found');
  const settings = await getSettings();
  const isReceipt = ['SUPPLIER_DELIVERY_CHALLAN', 'SUPPLIER_INVOICE', 'INWARD_BOOK'].includes(doc.doc_type);
  const isCustomer = doc.doc_type === 'IDEAL_CUSTOMER_DELIVERY_CHALLAN';

  // Header requirements.
  if (!doc.document_date || (doc.document_date_confidence ?? 0) < settings.conf_medium) {
    await raiseTask(db, {
      taskType: 'CORRECT_HEADER', priority: 'NORMAL',
      title: `Confirm document date on ${doc.ref_no}${doc.document_date_raw ? ` (read as "${doc.document_date_raw}")` : ''}`,
      documentId, dedupKey: `hdrdate:${documentId}`,
      payload: { field: 'document_date', raw: doc.document_date_raw, parsed: doc.document_date, confidence: doc.document_date_confidence },
    });
  }
  if (isReceipt && !doc.supplier_id) {
    await raiseFinding(db, {
      type: 'FIELD_EXTRACTION_UNCERTAIN', severity: 'WARNING',
      title: `Supplier unclear on ${doc.ref_no}`,
      explanation: doc.supplier_name_raw
        ? `Read "${doc.supplier_name_raw}" but no confident match in the supplier master.`
        : 'No supplier name could be read from the document.',
      documentId, dedupKey: `hdrsupplier:${documentId}`,
      recommendedAction: 'Select the supplier on the document screen.',
    });
    await raiseTask(db, {
      taskType: 'CORRECT_HEADER', priority: 'HIGH',
      title: `Select supplier for ${doc.ref_no}`,
      documentId, dedupKey: `hdrsupplierT:${documentId}`,
      payload: { field: 'supplier_id', raw: doc.supplier_name_raw },
    });
  }
  if (isReceipt && (doc.supplier_confidence ?? 1) < settings.conf_medium && doc.supplier_id) {
    await raiseTask(db, {
      taskType: 'CORRECT_HEADER', priority: 'NORMAL',
      title: `Confirm supplier "${doc.supplier_name_raw}" on ${doc.ref_no}`,
      documentId, dedupKey: `hdrsupplierC:${documentId}`,
      payload: { field: 'supplier_id', raw: doc.supplier_name_raw, confidence: doc.supplier_confidence },
    });
  }
  if (isCustomer && !doc.customer_id) {
    await raiseTask(db, {
      taskType: 'CORRECT_HEADER', priority: 'HIGH',
      title: `Select customer for ${doc.ref_no}${doc.customer_name_raw ? ` (read as "${doc.customer_name_raw}")` : ''}`,
      documentId, dedupKey: `hdrcustomer:${documentId}`,
      payload: { field: 'customer_id', raw: doc.customer_name_raw },
    });
  }

  // Duplicate document number for the same supplier.
  if (doc.supplier_id && doc.document_number) {
    const dup = await q1<any>(
      `SELECT ref_no FROM documents WHERE supplier_id=$1 AND document_number=$2 AND doc_type=$3 AND id<>$4 AND status<>'DUPLICATE' LIMIT 1`,
      [doc.supplier_id, doc.document_number, doc.doc_type, documentId]);
    if (dup) {
      await raiseFinding(db, {
        type: 'POSSIBLE_DUPLICATE_DOCUMENT', severity: 'HIGH',
        title: `${doc.doc_type === 'SUPPLIER_INVOICE' ? 'Invoice' : 'Document'} number ${doc.document_number} already exists (${dup.ref_no})`,
        explanation: 'Same supplier and same document number as an earlier upload — possible duplicate billing.',
        documentId, supplierId: doc.supplier_id, dedupKey: `dupnum:${documentId}`,
        recommendedAction: 'Compare both documents before approving either.',
      });
    }
  }

  // Arithmetic — supplier invoices and any document carrying amounts.
  const hasAmounts = await q1<{ n: string }>(
    `SELECT count(*) AS n FROM document_lines WHERE document_id=$1 AND (unit_rate IS NOT NULL OR amount_shown IS NOT NULL)`,
    [documentId]);
  if (doc.doc_type === 'SUPPLIER_INVOICE' || Number(hasAmounts?.n ?? 0) > 0 || doc.grand_total) {
    const input = await invoiceInputFor(documentId);
    const res = checkInvoice(input, { toleranceINR: settings.rounding_tolerance_inr });
    for (const lc of res.lineChecks) {
      if (lc.status === 'MISMATCH') {
        await raiseFinding(db, {
          type: 'BILL_CALCULATION_ERROR', severity: 'HIGH',
          title: `Line ${lc.lineRef} amount off by ₹${lc.differenceAbs} on ${doc.ref_no}`,
          explanation: lc.explanation, documentId, supplierId: doc.supplier_id,
          expected: lc.calculated, actual: lc.shown, difference: lc.differenceAbs,
          dedupKey: `calc:${documentId}:${lc.lineRef}`,
          recommendedAction: 'Check quantity, rate and the amount written on the bill; query the supplier if the bill is wrong.',
        });
      }
    }
    for (const tc of res.taxChecks) {
      if (tc.status === 'MISMATCH') {
        await raiseFinding(db, {
          type: 'TAX_CALCULATION_ERROR', severity: 'HIGH',
          title: `${tc.kind} off by ₹${tc.differenceAbs} on ${doc.ref_no}`,
          explanation: tc.explanation, documentId, supplierId: doc.supplier_id,
          expected: tc.calculated, actual: tc.shown, difference: tc.differenceAbs,
          dedupKey: `tax:${documentId}:${tc.kind}`,
        });
      }
    }
    if (res.grandTotal.status === 'MISMATCH') {
      await raiseFinding(db, {
        type: 'BILL_CALCULATION_ERROR', severity: 'HIGH',
        title: `Grand total off by ₹${res.grandTotal.differenceAbs} on ${doc.ref_no}`,
        explanation: res.grandTotal.explanation, documentId, supplierId: doc.supplier_id,
        expected: res.grandTotal.calculated, actual: res.grandTotal.shown, difference: res.grandTotal.differenceAbs,
        dedupKey: `calcGT:${documentId}`,
      });
    }
    if (res.subtotal.status === 'MISMATCH') {
      await raiseFinding(db, {
        type: 'BILL_CALCULATION_ERROR', severity: 'WARNING',
        title: `Subtotal off by ₹${res.subtotal.differenceAbs} on ${doc.ref_no}`,
        explanation: res.subtotal.explanation, documentId, supplierId: doc.supplier_id,
        dedupKey: `calcSub:${documentId}`,
      });
    }
    await q('UPDATE documents SET calculated_total_qty=$2 WHERE id=$1', [documentId, res.calculatedTotalQty]);
    if (res.totalQtyCheck.status === 'MISMATCH') {
      const ambiguous = await q1<{ s: string }>(
        `SELECT COALESCE(SUM(quantity),0) AS s FROM document_lines WHERE document_id=$1 AND notation='AMBIGUOUS'`, [documentId]);
      const amb = Number(ambiguous?.s ?? 0);
      const reconcilesWithAmbiguous = doc.handwritten_total_qty === res.calculatedTotalQty + amb;
      await raiseFinding(db, {
        type: 'TOTAL_QTY_MISMATCH',
        severity: reconcilesWithAmbiguous ? 'INFO' : 'WARNING',
        title: `Handwritten total ${doc.handwritten_total_qty} vs extracted ${res.calculatedTotalQty} on ${doc.ref_no}`,
        explanation: reconcilesWithAmbiguous
          ? `The totals will match once ${amb} unit(s) in uncertain lines are confirmed.`
          : `Confirmed lines add to ${res.calculatedTotalQty}${amb ? ` plus ${amb} unit(s) in uncertain lines` : ''}, but the page total says ${doc.handwritten_total_qty}.`,
        documentId, expected: String(doc.handwritten_total_qty), actual: String(res.calculatedTotalQty),
        difference: String((doc.handwritten_total_qty ?? 0) - res.calculatedTotalQty),
        dedupKey: `docqty:${documentId}`,
        recommendedAction: 'Review uncertain lines, then re-check the total.',
      });
    }
  } else {
    const sum = await q1<{ s: string }>(
      `SELECT COALESCE(SUM(quantity),0) AS s FROM document_lines WHERE document_id=$1 AND notation IN ('SIZE_OVER_QTY','PLAIN')`, [documentId]);
    await q('UPDATE documents SET calculated_total_qty=$2 WHERE id=$1', [documentId, Number(sum?.s ?? 0)]);
  }
}
