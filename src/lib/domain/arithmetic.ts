/**
 * Deterministic invoice/bill arithmetic.
 *
 * The AI extractor never does maths. After extraction, every calculation is
 * repeated here with decimal-safe arithmetic (Decimal.js) and compared with
 * the values printed on the document, within the configured tolerance.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export interface LineInput {
  lineRef: string;            // stable ref for reporting, e.g. "3.2"
  description?: string;
  quantity: number | null;
  rate: string | number | null;
  discount?: string | number | null;
  amountShown: string | number | null;
}

export interface TaxInput { kind: 'CGST' | 'SGST' | 'IGST' | 'OTHER'; ratePct: string | number | null; amountShown: string | number | null; }

export interface InvoiceInput {
  lines: LineInput[];
  taxes: TaxInput[];
  subtotalShown?: string | number | null;
  roundingShown?: string | number | null;
  grandTotalShown?: string | number | null;
  handwrittenTotalQty?: number | null;
}

export type CheckStatus = 'OK' | 'MISMATCH' | 'NOT_CHECKABLE';

export interface ValueCheck {
  shown: string | null;
  calculated: string | null;
  differenceAbs: string | null;
  differencePct: string | null;
  status: CheckStatus;
  explanation: string;
}

export interface LineCheck extends ValueCheck { lineRef: string; description?: string; }

export interface InvoiceCheckResult {
  lineChecks: LineCheck[];
  subtotal: ValueCheck;
  taxChecks: (ValueCheck & { kind: string; ratePct: string | null })[];
  grandTotal: ValueCheck;
  totalQtyCheck: ValueCheck;
  calculatedTotalQty: number;
  hasErrors: boolean;
}

function D(v: string | number | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  try { return new Decimal(v); } catch { return null; }
}

function money(d: Decimal): string { return d.toFixed(2); }

function compare(shown: Decimal | null, calc: Decimal | null, tol: Decimal, what: string): ValueCheck {
  if (calc === null && shown === null) {
    return { shown: null, calculated: null, differenceAbs: null, differencePct: null, status: 'NOT_CHECKABLE', explanation: `${what}: nothing to compare` };
  }
  if (calc === null) {
    return { shown: shown ? money(shown) : null, calculated: null, differenceAbs: null, differencePct: null, status: 'NOT_CHECKABLE', explanation: `${what}: inputs missing, cannot recalculate` };
  }
  if (shown === null) {
    return { shown: null, calculated: money(calc), differenceAbs: null, differencePct: null, status: 'NOT_CHECKABLE', explanation: `${what}: value not printed on document` };
  }
  const diff = shown.minus(calc);
  const ok = diff.abs().lte(tol);
  const pct = calc.isZero() ? null : diff.abs().div(calc.abs()).times(100).toFixed(2);
  return {
    shown: money(shown), calculated: money(calc),
    differenceAbs: money(diff.abs()), differencePct: pct,
    status: ok ? 'OK' : 'MISMATCH',
    explanation: ok
      ? `${what} matches within ₹${money(tol)}`
      : `${what}: document shows ₹${money(shown)} but calculation gives ₹${money(calc)} (difference ₹${money(diff.abs())})`,
  };
}

export function checkInvoice(input: InvoiceInput, opts: { toleranceINR?: number | string } = {}): InvoiceCheckResult {
  const tol = new Decimal(opts.toleranceINR ?? 1);
  const zeroTol = new Decimal(0); // integer quantities compare exactly

  const lineChecks: LineCheck[] = [];
  let subtotalCalc = new Decimal(0);
  let anyLineComputable = false;
  let totalQty = 0;

  for (const l of input.lines) {
    const qty = l.quantity;
    const rate = D(l.rate);
    const disc = D(l.discount) ?? new Decimal(0);
    const shown = D(l.amountShown);
    if (qty !== null) totalQty += qty;

    let calc: Decimal | null = null;
    if (qty !== null && rate !== null) {
      calc = new Decimal(qty).times(rate).minus(disc);
      anyLineComputable = true;
    }
    const check = compare(shown, calc, tol, `Line ${l.lineRef} amount (qty × rate − discount)`);
    lineChecks.push({ ...check, lineRef: l.lineRef, description: l.description });
    // Subtotal builds from the calculated value when available, else from shown.
    if (calc !== null) subtotalCalc = subtotalCalc.plus(calc);
    else if (shown !== null) subtotalCalc = subtotalCalc.plus(shown);
  }

  const subtotalShown = D(input.subtotalShown);
  const subtotal = anyLineComputable || input.lines.length
    ? compare(subtotalShown, subtotalCalc, tol, 'Subtotal (sum of lines)')
    : compare(subtotalShown, null, tol, 'Subtotal');

  const taxable = subtotalShown && subtotal.status === 'MISMATCH' ? subtotalCalc : (subtotalShown ?? subtotalCalc);
  const taxChecks = input.taxes.map((t) => {
    const rate = D(t.ratePct);
    const shown = D(t.amountShown);
    const calc = rate !== null ? taxable.times(rate).div(100) : null;
    const c = compare(shown, calc, tol, `${t.kind} @ ${rate ? rate.toString() : '?'}%`);
    return { ...c, kind: t.kind, ratePct: rate ? rate.toString() : null };
  });

  let grandCalc = subtotalCalc;
  for (const t of input.taxes) {
    const rate = D(t.ratePct);
    const shown = D(t.amountShown);
    if (rate !== null) grandCalc = grandCalc.plus(taxable.times(rate).div(100));
    else if (shown !== null) grandCalc = grandCalc.plus(shown);
  }
  const roundingShown = D(input.roundingShown);
  if (roundingShown) grandCalc = grandCalc.plus(roundingShown);
  const grandTotal = compare(D(input.grandTotalShown), grandCalc, tol, 'Grand total');

  const totalQtyCheck: ValueCheck =
    input.handwrittenTotalQty === null || input.handwrittenTotalQty === undefined
      ? { shown: null, calculated: String(totalQty), differenceAbs: null, differencePct: null, status: 'NOT_CHECKABLE', explanation: 'No handwritten total quantity on document' }
      : compare(new Decimal(input.handwrittenTotalQty), new Decimal(totalQty), zeroTol, 'Total quantity (handwritten vs sum of lines)');

  const hasErrors =
    lineChecks.some((c) => c.status === 'MISMATCH') ||
    subtotal.status === 'MISMATCH' ||
    taxChecks.some((c) => c.status === 'MISMATCH') ||
    grandTotal.status === 'MISMATCH' ||
    totalQtyCheck.status === 'MISMATCH';

  return { lineChecks, subtotal, taxChecks, grandTotal, totalQtyCheck, calculatedTotalQty: totalQty, hasErrors };
}
