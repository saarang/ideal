/**
 * The single most important business rule of the whole system:
 * "28/5" is size 28, quantity 5 — never twenty-eight fifths.
 */
import { describe, it, expect } from 'vitest';
import {
  parseToken, parseSequence, isPlausibleSize, sumConfirmedQuantities, sumAmbiguousProposals,
  ParseContext,
} from '@/src/lib/domain/sizeNotation';

const ctx: ParseContext = {
  knownComposites: ['12/14', '28/32', '14/16', '16/18'],
  plausibleSizeMin: 16,
  plausibleSizeMax: 44,
};

describe('parseToken — size-over-quantity notation', () => {
  it('reads 28/5 as size 28 × 5 pcs (never division)', () => {
    const p = parseToken('28/5', ctx);
    expect(p.kind).toBe('SIZE_OVER_QTY');
    expect(p.size).toBe('28');
    expect(p.quantity).toBe(5);
  });

  it('reads a vertically stacked 30 over 7 as size 30 × 7', () => {
    const p = parseToken('30/7', ctx, true);
    expect(p.kind).toBe('SIZE_OVER_QTY');
    expect(p.size).toBe('30');
    expect(p.quantity).toBe(7);
  });

  it('keeps 12/14 as ONE composite size, not size 12 qty 14', () => {
    const p = parseToken('12/14', ctx);
    expect(p.kind).toBe('COMPOSITE_SIZE');
    expect(p.size).toBe('12/14');
    expect(p.quantity).toBeNull();
  });

  it('treats an item-master size list as authoritative for composites', () => {
    const p = parseToken('34/36', { ...ctx, allowedSizes: ['34/36', '38/40'] });
    expect(p.kind).toBe('COMPOSITE_SIZE');
    expect(p.size).toBe('34/36');
  });

  it('flags 28/32 written as a stacked fraction for confirmation (composite vs size-qty clash)', () => {
    const p = parseToken('28/32', ctx, true);
    expect(p.kind).toBe('AMBIGUOUS');
    expect(p.size).toBe('28');
    expect(p.quantity).toBe(32);
    expect(p.confidence).toBeLessThan(0.75);
  });

  it('marks 26/28 (both plausible sizes, not configured composite) ambiguous with a proposal', () => {
    const p = parseToken('26/28', ctx);
    expect(p.kind).toBe('AMBIGUOUS');
    expect(p.raw).toBe('26/28');
    expect(p.size).toBe('26');
    expect(p.quantity).toBe(28);
  });

  it('reads 42/– as size 42 with nothing received', () => {
    const p = parseToken('42/–', ctx);
    expect(p.kind).toBe('SIZE_ONLY');
    expect(p.size).toBe('42');
    expect(p.quantity).toBeNull();
  });

  it('treats a dash as an empty cell', () => {
    expect(parseToken('—', ctx).kind).toBe('EMPTY');
  });

  it('respects the Size column layout hint: 28/30 in a printed Size column is a size', () => {
    const p = parseToken('28/30', { ...ctx, layoutHint: 'SIZE_QTY_COLUMNS' });
    expect(p.kind).toBe('COMPOSITE_SIZE');
    expect(p.size).toBe('28/30');
  });

  it('never invents: an unreadable token stays AMBIGUOUS with raw preserved', () => {
    const p = parseToken('2?/5', ctx);
    expect(p.kind).toBe('AMBIGUOUS');
    expect(p.raw).toBe('2?/5');
    expect(p.quantity).toBeNull();
  });
});

describe('parseSequence — row patterns resolve lone ambiguity', () => {
  it('resolves 22/13 24/13 26/12 28/10 as an ascending size ladder', () => {
    const seq = parseSequence(
      ['22/13', '24/13', '26/12', '28/10'].map((raw) => ({ raw })),
      { ...ctx, plausibleSizeMin: 16 });
    for (const p of seq) expect(p.kind).toBe('SIZE_OVER_QTY');
    expect(seq.map((p) => p.size)).toEqual(['22', '24', '26', '28']);
    expect(sumConfirmedQuantities(seq)).toBe(13 + 13 + 12 + 10);
  });

  it('a configured composite inside a fraction-row run is queried, not assumed', () => {
    const seq = parseSequence(
      ['24/6', '28/32', '30/4'].map((raw) => ({ raw, vertical: true })), ctx);
    const middle = seq[1];
    expect(middle.kind).toBe('AMBIGUOUS');
    expect(middle.size).toBe('28');
    expect(middle.quantity).toBe(32);
  });

  it('does not force a ladder on unordered pairs', () => {
    const seq = parseSequence(['28/5', '24/6'].map((raw) => ({ raw })), ctx);
    // 28/5: 5 below plausible-size floor → clean size/qty. 24/6 likewise.
    expect(seq[0].kind).toBe('SIZE_OVER_QTY');
    expect(seq[1].kind).toBe('SIZE_OVER_QTY');
  });

});

describe('quantity summing', () => {
  it('separates confirmed from ambiguous totals', () => {
    const tokens = [
      parseToken('28/5', ctx),          // confirmed 5
      parseToken('30/7', ctx, true),    // confirmed 7
      parseToken('26/28', ctx),         // ambiguous proposal 28
      parseToken('12/14', ctx),         // composite, no qty
    ];
    expect(sumConfirmedQuantities(tokens)).toBe(12);
    expect(sumAmbiguousProposals(tokens)).toBe(28);
  });
});

describe('isPlausibleSize', () => {
  it('uses the configured window when no item size list is known', () => {
    expect(isPlausibleSize('28', ctx)).toBe(true);
    expect(isPlausibleSize('5', ctx)).toBe(false);
    expect(isPlausibleSize('120', ctx)).toBe(false);
  });
  it('prefers the item size list when present', () => {
    expect(isPlausibleSize('15', { allowedSizes: ['15', '16'] })).toBe(true);
    expect(isPlausibleSize('28', { allowedSizes: ['15', '16'] })).toBe(false);
  });
});
