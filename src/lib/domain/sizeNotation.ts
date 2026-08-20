/**
 * Interpretation of handwritten size/quantity notation.
 *
 * In the trade, "28/5" (or 28 written over 5 like a fraction) means size 28,
 * quantity 5 — never 28 ÷ 5. But genuine composite sizes ("12/14", "28/32")
 * also exist. This module decides between the two using the allowed sizes of
 * the item, the configured composite-size list, page-layout context, whether
 * the token was written vertically, and the pattern of neighbouring tokens.
 *
 * It never guesses silently: uncertain tokens come back AMBIGUOUS with the
 * raw text preserved so a human-review task can be raised.
 */

export type NotationKind =
  | 'SIZE_OVER_QTY'   // 28/5 → size 28, qty 5
  | 'COMPOSITE_SIZE'  // 12/14 is one size (qty comes from elsewhere)
  | 'PLAIN'           // explicit qty column
  | 'SIZE_ONLY'       // a size with no quantity (e.g. "42/–")
  | 'EMPTY'           // dash / blank
  | 'AMBIGUOUS';      // store raw + proposal, needs human review

export interface RawToken { raw: string; vertical?: boolean; }

export interface ParsedToken {
  raw: string;
  vertical: boolean;
  kind: NotationKind;
  size: string | null;
  quantity: number | null;
  confidence: number;      // parser confidence 0..1 (combine with OCR confidence)
  reason: string;
}

export interface ParseContext {
  allowedSizes?: string[];          // allowed sizes of the (likely) item
  knownComposites?: string[];       // configured composite sizes
  layoutHint?: 'FRACTION_ROW' | 'SIZE_QTY_COLUMNS' | null;
  plausibleSizeMin?: number;
  plausibleSizeMax?: number;
}

const DASHES = new Set(['-', '–', '—', '−', '_', '']);
const isDash = (s: string) => DASHES.has(s.trim());

function normNum(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return Number(t);
}

export function isPlausibleSize(v: string, ctx: ParseContext): boolean {
  const t = v.trim();
  if (ctx.allowedSizes && ctx.allowedSizes.length) return ctx.allowedSizes.includes(t);
  const n = normNum(t);
  if (n === null) return false;
  return n >= (ctx.plausibleSizeMin ?? 4) && n <= (ctx.plausibleSizeMax ?? 50);
}

function isKnownComposite(joined: string, ctx: ParseContext): boolean {
  const t = joined.replace(/\s/g, '');
  if ((ctx.knownComposites ?? []).includes(t)) return true;
  if (ctx.allowedSizes?.includes(t)) return true; // item master defines it as one size
  return false;
}

/** Parse one token like "28/5", "12/14", "42/–", "36". */
export function parseToken(rawIn: string, ctx: ParseContext = {}, vertical = false): ParsedToken {
  const raw = rawIn.trim();
  const base = { raw: rawIn, vertical };
  if (isDash(raw)) return { ...base, kind: 'EMPTY', size: null, quantity: null, confidence: 0.95, reason: 'dash/blank' };

  const slash = raw.replace(/\s/g, '').match(/^(\d{1,4})[\/](\d{1,4}|[-–—−])$/);
  if (!slash) {
    const n = normNum(raw);
    if (n !== null && isPlausibleSize(raw, ctx)) {
      return { ...base, kind: 'SIZE_ONLY', size: String(n), quantity: null, confidence: 0.8, reason: 'single number, plausible size' };
    }
    return { ...base, kind: 'AMBIGUOUS', size: null, quantity: null, confidence: 0.3, reason: 'unrecognised token' };
  }

  const [, a, bRaw] = slash;
  if (isDash(bRaw)) {
    return { ...base, kind: 'SIZE_ONLY', size: a, quantity: null, confidence: 0.9, reason: 'size with dash (no quantity received)' };
  }
  const b = bRaw;
  const joined = `${a}/${b}`;
  const composite = isKnownComposite(joined, ctx);
  const aSize = isPlausibleSize(a, ctx);
  const bSize = isPlausibleSize(b, ctx);

  // A value sitting in a printed Size column (qty in its own column) is a size.
  if (ctx.layoutHint === 'SIZE_QTY_COLUMNS' && !vertical) {
    return { ...base, kind: 'COMPOSITE_SIZE', size: joined, quantity: null, confidence: 0.92, reason: 'value in Size column; quantity in separate column' };
  }

  // Written stacked like a fraction: this is the trade's size-over-qty notation.
  // Composite sizes are written inline, not stacked — but if the stacked value
  // matches a configured composite, flag for confirmation rather than assume.
  if (vertical) {
    if (composite) {
      return { ...base, kind: 'AMBIGUOUS', size: a, quantity: Number(b), confidence: 0.55, reason: `written as a fraction but ${joined} is a configured composite size — needs confirmation` };
    }
    if (aSize) {
      return { ...base, kind: 'SIZE_OVER_QTY', size: a, quantity: Number(b), confidence: 0.88, reason: 'written as size over quantity (fraction style)' };
    }
    return { ...base, kind: 'AMBIGUOUS', size: null, quantity: null, confidence: 0.35, reason: `written as a fraction but ${a} is not a plausible size` };
  }

  if (composite) {
    return { ...base, kind: 'COMPOSITE_SIZE', size: joined, quantity: null, confidence: 0.85, reason: 'matches configured composite size' };
  }
  if (aSize && !bSize) {
    return { ...base, kind: 'SIZE_OVER_QTY', size: a, quantity: Number(b), confidence: 0.9, reason: 'first part is a plausible size; second is not' };
  }
  if (aSize && bSize) {
    return { ...base, kind: 'AMBIGUOUS', size: a, quantity: Number(b), confidence: 0.5, reason: `both ${a} and ${b} are plausible sizes; could be size/qty or composite` };
  }
  return { ...base, kind: 'AMBIGUOUS', size: null, quantity: null, confidence: 0.3, reason: 'neither part is a plausible size' };
}

/**
 * Parse a horizontal sequence like 28/5 30/7 32/10 34/10.
 * A run of ≥2 pairs with strictly increasing first parts is a size ladder:
 * seconds are quantities. This resolves lone-token ambiguity (e.g. 22/13 24/13).
 */
export function parseSequence(tokens: RawToken[], ctx: ParseContext = {}): ParsedToken[] {
  const first = tokens.map((t) => parseToken(t.raw, ctx, t.vertical ?? false));

  const firsts: number[] = [];
  for (const p of first) {
    const m = p.raw.replace(/\s/g, '').match(/^(\d+)\/(\d+|[-–—−])$/);
    if (m) firsts.push(Number(m[1]));
  }
  const isRun = firsts.length >= 2 && firsts.every((n, i) => i === 0 || n > firsts[i - 1]);

  if (!isRun) return first;
  return first.map((p) => {
    const m = p.raw.replace(/\s/g, '').match(/^(\d+)\/(\d+)$/);
    if (!m) return p;
    if (p.kind === 'AMBIGUOUS' && p.size !== null) {
      // A configured composite stays a question even inside a ladder — the
      // ladder makes size/qty LIKELY, but "28/32" could still be the composite
      // size with the quantity elsewhere. Raise the proposal's confidence a
      // little and leave the decision to a person.
      if (isKnownComposite(`${m[1]}/${m[2]}`, ctx)) {
        return { ...p, size: m[1], quantity: Number(m[2]), confidence: Math.max(p.confidence, 0.6), reason: p.reason + '; sits inside an ascending size run, which suggests size/qty — confirm' };
      }
      return { ...p, kind: 'SIZE_OVER_QTY' as const, size: m[1], quantity: Number(m[2]), confidence: Math.max(p.confidence, 0.82), reason: p.reason + '; resolved by row pattern (ascending size run)' };
    }
    if (p.kind === 'COMPOSITE_SIZE' && (ctx.layoutHint === 'FRACTION_ROW' || p.vertical)) {
      return { ...p, kind: 'AMBIGUOUS' as const, size: m[1], quantity: Number(m[2]), confidence: 0.55, reason: 'configured composite size found inside a size/qty run — needs confirmation' };
    }
    return p;
  });
}

/** Sum quantities of confidently parsed tokens (AMBIGUOUS excluded). */
export function sumConfirmedQuantities(tokens: ParsedToken[]): number {
  return tokens.reduce((s, t) => s + ((t.kind === 'SIZE_OVER_QTY' || t.kind === 'PLAIN') ? (t.quantity ?? 0) : 0), 0);
}

/** Sum of AMBIGUOUS proposals (for "would reconcile if confirmed" checks). */
export function sumAmbiguousProposals(tokens: ParsedToken[]): number {
  return tokens.reduce((s, t) => s + (t.kind === 'AMBIGUOUS' ? (t.quantity ?? 0) : 0), 0);
}
