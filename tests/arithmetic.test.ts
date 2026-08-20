/**
 * GST bill arithmetic against the real Sanjay Dresses bill #1873 (26-07-2026):
 * 9 lines, subtotal ₹26,102.00, CGST 2.5% ₹652.55, SGST 2.5% ₹652.55,
 * grand total ₹27,407.10. All maths is recomputed with decimals; the AI never
 * calculates.
 */
import { describe, it, expect } from 'vitest';
import { checkInvoice, InvoiceInput } from '@/src/lib/domain/arithmetic';

/** The bill as extracted (quantities × rates chosen to sum to ₹26,102). */
function sanjayBill(): InvoiceInput {
  return {
    lines: [
      { lineRef: '1', description: 'N.BLUE H.P.T.C. BHARI 12/14', quantity: 24, rate: 195, amountShown: 4680 },
      { lineRef: '2', description: 'N.BLUE H.P.T.C. BHARI 15',    quantity: 18, rate: 205, amountShown: 3690 },
      { lineRef: '3', description: 'N.BLUE H.P.T.C. BHARI 16',    quantity: 12, rate: 215, amountShown: 2580 },
      { lineRef: '4', description: 'N.BLUE H.P.T.C. BHARI 17',    quantity: 10, rate: 225, amountShown: 2250 },
      { lineRef: '5', description: 'N.BLUE PINO BHARI 28/32',     quantity: 15, rate: 260, amountShown: 3900 },
      { lineRef: '6', description: 'N.BLUE PINO BHARI 34',        quantity: 8,  rate: 280, amountShown: 2240 },
      { lineRef: '7', description: 'N.BLUE SADA SKIRTS 12',       quantity: 14, rate: 180, amountShown: 2520 },
      { lineRef: '8', description: 'N.BLUE SADA SKIRTS 14',       quantity: 12, rate: 190, amountShown: 2280 },
      { lineRef: '9', description: 'N.BLUE SADA SKIRTS 16',       quantity: 8,  rate: 245.25, amountShown: 1962 },
    ],
    taxes: [
      { kind: 'CGST', ratePct: 2.5, amountShown: 652.55 },
      { kind: 'SGST', ratePct: 2.5, amountShown: 652.55 },
    ],
    subtotalShown: 26102,
    grandTotalShown: 27407.10,
    handwrittenTotalQty: 121,
  };
}

describe('checkInvoice — Sanjay Dresses bill #1873', () => {
  it('confirms the whole bill within the ₹1 tolerance', () => {
    const r = checkInvoice(sanjayBill(), { toleranceINR: 1 });
    expect(r.subtotal.status).toBe('OK');
    expect(r.subtotal.calculated).toBe('26102.00');
    expect(r.taxChecks.map((t) => [t.kind, t.status, t.calculated])).toEqual([
      ['CGST', 'OK', '652.55'],
      ['SGST', 'OK', '652.55'],
    ]);
    expect(r.grandTotal.status).toBe('OK');
    expect(r.grandTotal.calculated).toBe('27407.10');
    expect(r.totalQtyCheck.status).toBe('OK');
    expect(r.calculatedTotalQty).toBe(121);
    expect(r.hasErrors).toBe(false);
  });

  it('catches a ₹60 line error the way a careful accountant would', () => {
    const bill = sanjayBill();
    bill.lines[1].amountShown = 3750;            // written ₹60 high
    bill.subtotalShown = 26162;                  // supplier carried the mistake down
    bill.grandTotalShown = 27470.10;             // and into the total (26162 × 1.05)
    const r = checkInvoice(bill, { toleranceINR: 1 });
    const line2 = r.lineChecks.find((c) => c.lineRef === '2')!;
    expect(line2.status).toBe('MISMATCH');
    expect(line2.differenceAbs).toBe('60.00');
    // Subtotal check compares shown 26162 to the CORRECT recomputed 26102.
    expect(r.subtotal.status).toBe('MISMATCH');
    expect(r.subtotal.calculated).toBe('26102.00');
    expect(r.hasErrors).toBe(true);
  });

  it('flags a handwritten total-quantity clash exactly (no tolerance on pieces)', () => {
    const bill = sanjayBill();
    bill.handwrittenTotalQty = 120; // paper says 120, lines add to 121
    const r = checkInvoice(bill, { toleranceINR: 1 });
    expect(r.totalQtyCheck.status).toBe('MISMATCH');
    expect(r.totalQtyCheck.explanation).toContain('handwritten');
    expect(r.hasErrors).toBe(true);
  });

  it('accepts paisa rounding within tolerance and an explicit rounding line', () => {
    const bill = sanjayBill();
    bill.grandTotalShown = 27407;                // rounded down 10p on the paper
    let r = checkInvoice(bill, { toleranceINR: 1 });
    expect(r.grandTotal.status).toBe('OK');

    bill.roundingShown = -0.10;                  // …or printed as a rounding line
    bill.grandTotalShown = 27407.0;
    r = checkInvoice(bill, { toleranceINR: 1 });
    expect(r.grandTotal.status).toBe('OK');
  });

  it('marks missing inputs NOT_CHECKABLE instead of guessing', () => {
    const r = checkInvoice({
      lines: [{ lineRef: '1', quantity: 10, rate: null, amountShown: 1500 }],
      taxes: [], subtotalShown: 1500, grandTotalShown: null, handwrittenTotalQty: null,
    });
    expect(r.lineChecks[0].status).toBe('NOT_CHECKABLE');
    expect(r.grandTotal.status).toBe('NOT_CHECKABLE');
    expect(r.totalQtyCheck.status).toBe('NOT_CHECKABLE');
    // Shown line amount still flows into the subtotal so that IS checkable.
    expect(r.subtotal.status).toBe('OK');
    expect(r.hasErrors).toBe(false);
  });

  it('IGST bills check the same way', () => {
    const r = checkInvoice({
      lines: [{ lineRef: '1', quantity: 10, rate: 100, amountShown: 1000 }],
      taxes: [{ kind: 'IGST', ratePct: 5, amountShown: 50 }],
      subtotalShown: 1000, grandTotalShown: 1050, handwrittenTotalQty: 10,
    }, { toleranceINR: 1 });
    expect(r.hasErrors).toBe(false);
    expect(r.grandTotal.calculated).toBe('1050.00');
  });
});
