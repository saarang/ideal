/**
 * Mock AI provider — deterministic fixtures for demo and tests.
 *
 * The fixtures were transcribed from the five real sample documents supplied
 * with the project brief, including their genuine ambiguities (an unreadable
 * yellow-row in the Aavak Vahi, an unclear supplier on the Sarda challan),
 * so the review workflow can be exercised without an API key.
 * Unknown images fall back to a low-confidence UNKNOWN classification, which
 * routes them to human review — exactly what production should do when the
 * model is unsure.
 */
import { Classification, DocType, DocumentAI, Extraction, PageImage } from './types';

type Fixture = { match: (p: PageImage) => boolean; classification: Classification; extraction: Extraction };

const F = (raw: string, vertical = true) => ({ raw, vertical });

const fixtures: Fixture[] = [
  // ── Sanjay Dresses GST invoice #1873 ───────────────────────────────────────
  {
    match: (p) => (p.filename ?? '').toLowerCase().includes('sanjay'),
    classification: { docType: 'SUPPLIER_INVOICE', confidence: 0.97, signals: 'Printed "GST TAX INVOICE", GSTIN, CGST/SGST rows, invoice number and proprietor signature' },
    extraction: {
      header: {
        documentNumber: '1873', invoiceRef: '1873', documentDateRaw: '26-07-2026',
        supplierName: 'Sanjay Dresses', supplierConfidence: 0.97,
        customerName: 'Ideal Uniform', locationHint: 'Shiva Complex, New Panvel',
        gstin: '27AJCPM8167B1Z8',
        subtotalShown: '26102.00',
        taxes: [
          { kind: 'CGST', ratePct: '2.5', amountShown: '652.55' },
          { kind: 'SGST', ratePct: '2.5', amountShown: '652.55' },
          { kind: 'IGST', ratePct: null, amountShown: null },
        ],
        roundingShown: null, grandTotalShown: '27407.10', handwrittenTotalQty: null,
        notes: 'NETT 27407.10 written by hand next to bank details; "2 6102" pencilled at top of page',
      },
      lines: [
        { lineNo: 1, description: 'N.BLUE H.P.T.C. BHARI', colour: 'Navy Blue', sizeTokens: [{ raw: '12/14', vertical: false }], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 36, sizeSingle: null, rate: '118', amountShown: '4248', pageNo: 1, conf: { description: 0.9, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 2, description: 'N.BLUE H.P.T.C. BHARI', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 12, sizeSingle: '15', rate: '126', amountShown: '1512', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 3, description: 'N.BLUE H.P.T.C. BHARI', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 12, sizeSingle: '16', rate: '130', amountShown: '1560', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 4, description: 'N.BLUE H.P.T.C. BHARI', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 6, sizeSingle: '17', rate: '136', amountShown: '816', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 5, description: 'N.BLUE PINO BHARI', colour: 'Navy Blue', sizeTokens: [{ raw: '28/32', vertical: false }], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 36, sizeSingle: null, rate: '165', amountShown: '5940', pageNo: 1, conf: { description: 0.9, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 6, description: 'N.BLUE PINO BHARI', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 12, sizeSingle: '34', rate: '175', amountShown: '2100', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 7, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', colour: 'Navy Blue', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 6, sizeSingle: '12', rate: '145', amountShown: '870', pageNo: 1, conf: { description: 0.88, size: 0.95, quantity: 0.95, rate: 0.9, amount: 0.95 } },
        { lineNo: 8, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 6, sizeSingle: '13', rate: '147', amountShown: '882', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.9, amount: 0.95 } },
        { lineNo: 9, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 8, sizeSingle: '14', rate: '150', amountShown: '1200', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 10, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 12, sizeSingle: '15', rate: '152', amountShown: '1824', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 11, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 12, sizeSingle: '16', rate: '155', amountShown: '1860', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 12, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 8, sizeSingle: '18', rate: '160', amountShown: '1280', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 13, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 6, sizeSingle: '20', rate: '165', amountShown: '990', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
        { lineNo: 14, description: 'N.BLUE SADA SKIRTS BHARI SIDE CHAIN', rawText: '(ditto)', sizeTokens: [], layoutHint: 'SIZE_QTY_COLUMNS', quantity: 6, sizeSingle: '22', rate: '170', amountShown: '1020', pageNo: 1, conf: { description: 0.85, size: 0.95, quantity: 0.95, rate: 0.95, amount: 0.95 } },
      ],
      rawText: 'GST TAX INVOICE — SANJAY DRESSES, Specialist in Children Wear & School Uniforms, Miranda Chawl, Shop No.1, J.K. Sawant Marg, Dadar (W), Mumbai 400 028. Invoice No 1873, Date 26-07-2026. To: IDEAL UNIFORM, SHIVA COMPLEX, NEW PANVEL. Lines: N.Blue H.P.T.C. Bhari 12/14×36@118=4248; 15×12@126=1512; 16×12@130=1560; 17×6@136=816. N.Blue Pino Bhari 28/32×36@165=5940; 34×12@175=2100. N.Blue Sada Skirts Bhari side chain 12×6@145=870; 13×6@147=882; 14×8@150=1200; 15×12@152=1824; 16×12@155=1860; 18×8@160=1280; 20×6@165=990; 22×6@170=1020. Total 26102. CGST 2.5% 652.55, SGST 2.5% 652.55. Gr. Total 27407.10. GSTIN 27AJCPM8167B1Z8. Bank: Abhyudaya Co-Op Bank (Dadar).',
      overallConfidence: 0.95,
    },
  },

  // ── Ideal → The Jaan Foundation delivery challan #94 ───────────────────────
  {
    match: (p) => (p.filename ?? '').toLowerCase().includes('ideal_delivery'),
    classification: { docType: 'IDEAL_CUSTOMER_DELIVERY_CHALLAN', confidence: 0.95, signals: 'Printed "DELIVERY CHALLAN" form, FROM: Ideal, TO: customer, challan number and received-by signature' },
    extraction: {
      header: {
        documentNumber: '94', challanRef: '94', documentDateRaw: '13-08-26',
        customerName: 'The Jaan Foundation, Panvel',
        supplierName: null,
        taxes: [], subtotalShown: null, grandTotalShown: null,
        handwrittenTotalQty: 204,
        notes: 'Rate and Amount columns left blank; signed "Received by".',
      },
      lines: [
        { lineNo: 1, description: 'Maroon Jacket', colour: 'Maroon', layoutHint: 'FRACTION_ROW', quantity: 52,
          sizeTokens: [F('26/5'), F('28/2'), F('30/14'), F('32/9'), F('34/5'), F('36/13'), F('38/2'), F('40/2')],
          pageNo: 1, conf: { description: 0.93, size: 0.9, quantity: 0.9 } },
        { lineNo: 2, description: 'Pink Punjabi Set (Top & Salwar)', colour: 'Pink', layoutHint: 'FRACTION_ROW', quantity: 52,
          sizeTokens: [F('28/5'), F('30/7'), F('32/10'), F('34/10'), F('36/10'), F('38/5'), F('40/5')],
          pageNo: 1, conf: { description: 0.92, size: 0.9, quantity: 0.9 } },
        { lineNo: 3, description: 'Maroon Dupatta', colour: 'Maroon', sizeTokens: [], quantity: 50, rawText: '50 PC Maroon Dupptta',
          pageNo: 1, conf: { description: 0.9, quantity: 0.92 } },
        { lineNo: 4, description: 'Pink Punjabi Set (Top & Salwar)', colour: 'Pink', layoutHint: 'FRACTION_ROW', quantity: 50,
          sizeTokens: [F('28/5'), F('30/5'), F('32/10'), F('34/10'), F('36/10'), F('38/5'), F('40/5')],
          pageNo: 1, conf: { description: 0.92, size: 0.9, quantity: 0.9 } },
      ],
      rawText: 'DELIVERY CHALLAN. FROM: Ideal. TO: The Jaan Foundation, Panvel. Challan No 94, Date 13-08-26. Maroon Jacket 26/5 28/2 30/14 32/9 34/5 36/13 38/2 40/2 = 52. Pink Punjabi Set (Top & Salwar) 28/5 30/7 32/10 34/10 36/10 38/5 40/5 = 52. 50 PC Maroon Dupatta. Pink Punjabi Set (Top & Salwar) 28/5 30/5 32/10 34/10 36/10 38/5 40/5 = 50. Total 204 PC. Received by (signed).',
      overallConfidence: 0.92,
    },
  },

  // ── Sarda handwritten delivery note "To Ideal Uni, N.Panvel" ───────────────
  {
    match: (p) => (p.filename ?? '').toLowerCase().includes('sarda'),
    classification: { docType: 'SUPPLIER_DELIVERY_CHALLAN', confidence: 0.8, signals: 'Handwritten list addressed "To Ideal Uni, N.Panvel" with Size/PC columns and a goods total; no printed form' },
    extraction: {
      header: {
        documentNumber: null, documentDateRaw: '18/8/26',
        supplierName: 'Sarda', supplierConfidence: 0.45,
        customerName: null, locationHint: 'N.Panvel',
        taxes: [], handwrittenTotalQty: 116,
        notes: 'Supplier name not written on the page (taken from context); "584×1" written and boxed at lower left; pencil workings "41-36 / 42-32 / 68" on previous leaf.',
      },
      lines: [
        { lineNo: 1, description: 'Bushirt', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '36', quantity: 18, pageNo: 1, rawText: 'Bushirt 36 18', conf: { description: 0.6, size: 0.85, quantity: 0.85 } },
        { lineNo: 2, description: 'Sudarbar (unclear, Marathi)', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '40', quantity: 6, pageNo: 1, rawText: '(Marathi word) 40 06', conf: { description: 0.35, size: 0.85, quantity: 0.85 } },
        { lineNo: 3, description: 'Sukhanandan (unclear, Marathi)', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '34', quantity: 6, pageNo: 1, rawText: '(Marathi word) 34 06', conf: { description: 0.3, size: 0.8, quantity: 0.85 } },
        { lineNo: 4, description: 'College Pants', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '36', quantity: 1, pageNo: 1, rawText: 'Collegepants 36 01', conf: { description: 0.65, size: 0.85, quantity: 0.85 } },
        { lineNo: 5, description: 'College Pants', rawText: '(ditto) 40 13', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '40', quantity: 13, pageNo: 1, conf: { description: 0.6, size: 0.85, quantity: 0.85 } },
        { lineNo: 6, description: 'College Pants', rawText: '(ditto) 42 04', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '42', quantity: 4, pageNo: 1, conf: { description: 0.6, size: 0.85, quantity: 0.85 } },
        { lineNo: 7, description: 'BH42 College (unclear)', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '41', quantity: 36, pageNo: 1, rawText: '31142/college 41 36', conf: { description: 0.35, size: 0.85, quantity: 0.9 } },
        { lineNo: 8, description: 'SSS Pant', layoutHint: 'SIZE_QTY_COLUMNS', sizeTokens: [], sizeSingle: '42', quantity: 32, pageNo: 1, rawText: 'SSS Pant 42 32', conf: { description: 0.7, size: 0.85, quantity: 0.9 } },
      ],
      rawText: 'To IDEAL UNI, N.Panvel. 18/8/26. Columns: Particulars, Size, PC. Bushirt 36 18; (Marathi) 40 06; (Marathi) 34 06; Collegepants 36 01; -"- 40 13; -"- 42 04; 31142/college 41 36; SSS Pant 42 32. Total 116. Boxed: 584×1.',
      overallConfidence: 0.7,
    },
  },

  // ── Aavak Vahi (inward book) — from Aarena, 5-7-26 ────────────────────────
  {
    match: (p) => { const f = (p.filename ?? '').toLowerCase(); return f.includes('aavak') && !f.includes('2'); },
    classification: { docType: 'INWARD_BOOK', confidence: 0.9, signals: 'Ruled notebook page headed "From: Aarena" with dated receipt entries and bag totals; matches Aavak Vahi register style' },
    extraction: {
      header: {
        documentDateRaw: '5-7-26',
        supplierName: 'Aarena', supplierConfidence: 0.9,
        taxes: [],
        handwrittenTotalQty: 111,
        notes: '"2 Bag received from home 5/7/26" top right; paper slip pinned: "From Arena 5-7-26: Bag(1) Track-NH = 39 pc; Bag(2) Shivkar T-sh, SPU T-sh = 72 pc. Manish". Counter refilling & (unclear) noted at left. Signed Muskan.',
      },
      lines: [
        { lineNo: 1, description: 'NH Track', colour: 'Green', layoutHint: 'FRACTION_ROW',
          sizeTokens: [F('28/4'), F('32/4'), F('34/4'), F('36/4'), F('38/2'), F('40/3'), F('42/–')],
          pageNo: 1, conf: { description: 0.9, size: 0.85, quantity: 0.85 } },
        { lineNo: 2, description: 'NH Track', colour: 'Yellow', layoutHint: 'FRACTION_ROW',
          rawText: 'yellow row — top figures unclear, possibly continuation of sizes above: 4/8 –/4 4/8 –/4 4/6 4/7 2/2',
          sizeTokens: [F('4/8'), F('–/4'), F('4/8'), F('–/4'), F('4/6'), F('4/7'), F('2/2')],
          pageNo: 1, conf: { description: 0.85, size: 0.3, quantity: 0.5 } },
        { lineNo: 3, description: 'SPV Red TSH', colour: 'Red', layoutHint: 'FRACTION_ROW',
          rawText: 'circled: SPV Red TSH 22/13 24/13',
          sizeTokens: [F('22/13'), F('24/13')],
          pageNo: 1, conf: { description: 0.85, size: 0.8, quantity: 0.85 } },
        { lineNo: 4, description: 'Shivkar (TSH)', colour: 'Blue', layoutHint: 'FRACTION_ROW',
          sizeTokens: [F('24/6'), F('26/6'), F('28/3')],
          pageNo: 1, conf: { description: 0.88, size: 0.85, quantity: 0.85 } },
        { lineNo: 5, description: 'Shivkar (TSH)', colour: 'Green', layoutHint: 'FRACTION_ROW',
          sizeTokens: [F('26/6'), F('28/4')],
          pageNo: 1, conf: { description: 0.88, size: 0.85, quantity: 0.85 } },
        { lineNo: 6, description: 'Shivkar (TSH)', colour: 'Yellow', layoutHint: 'FRACTION_ROW',
          sizeTokens: [F('26/6'), F('28/6'), F('36/6'), F('38/3')],
          pageNo: 1, conf: { description: 0.88, size: 0.75, quantity: 0.85 } },
      ],
      rawText: 'From: Aarena. 5-7-26. 2 Bag received from home 5/7/26. Counter refiling & (unclear). NH Track: Green 28/4 32/4 34/4 36/4 38/2 40/3 42/–. Yellow (unclear) 4/8 –/4 4/8 –/4 4/6 4/7 2/2. Bag(1) boxed: 39. SPV Red TSH 22/13 24/13 (circled). Shivkar (TSH): Blue 24/6 26/6 28/3 | Green 26/6 28/4. Yellow 26/6 28/6 36/6 38/3. Slip: From Arena 5-7-26 Bag(1) Track-NH = 39 pc, Bag(2) Shivkar T-sh, SPU T-sh = 72 pc — Manish. Signed Muskan.',
      overallConfidence: 0.72,
    },
  },

  // ── Aavak Vahi 2 — from GMK, 19/7/26 ──────────────────────────────────────
  {
    match: (p) => (p.filename ?? '').toLowerCase().includes('aavak') && (p.filename ?? '').includes('2'),
    classification: { docType: 'INWARD_BOOK', confidence: 0.88, signals: 'Ruled register page headed "From: GMK" with dated parcel receipt entries; Aavak Vahi style' },
    extraction: {
      header: {
        documentDateRaw: '19/7/26',
        supplierName: 'GMK', supplierConfidence: 0.85,
        taxes: [],
        handwrittenTotalQty: null,
        notes: '"1 parcel received from home 19/7/26" noted in margin. Signed Raj.',
      },
      lines: [
        { lineNo: 1, description: 'Scout-Kite', sizeTokens: [], quantity: 15, rawText: 'Scout-Kite: 15 pc', pageNo: 1, conf: { description: 0.85, quantity: 0.9 } },
        { lineNo: 2, description: 'RSP-Kite', sizeTokens: [], quantity: 10, rawText: 'RSP-Kite: 10 pc', pageNo: 1, conf: { description: 0.85, quantity: 0.9 } },
        { lineNo: 3, description: 'White-SK', colour: 'White', layoutHint: 'FRACTION_ROW',
          sizeTokens: [F('18/11')], rawText: 'WHITE-SK: 18 over 11', pageNo: 1, conf: { description: 0.8, size: 0.8, quantity: 0.85 } },
      ],
      rawText: 'From: GMK. 19|7|26. 1 parcel received from home 19/7/26. Scout-Kite: 15 pc. RSP-Kite: 10 pc. WHITE-SK: 18/11 (written as fraction). Signed Raj.',
      overallConfidence: 0.85,
    },
  },
];

const UNKNOWN_CLASSIFICATION: Classification = {
  docType: 'UNKNOWN', confidence: 0.4,
  signals: 'Mock provider has no fixture for this image; in production the vision model would classify it. Routed to human review.',
};

const EMPTY_EXTRACTION: Extraction = {
  header: { taxes: [] },
  lines: [],
  rawText: '(mock provider: no fixture available for this image)',
  overallConfidence: 0.3,
};

export class MockProvider implements DocumentAI {
  readonly name = 'mock';

  private find(pages: PageImage[]): Fixture | null {
    for (const p of pages) {
      const f = fixtures.find((fx) => fx.match(p));
      if (f) return f;
    }
    return null;
  }

  async classify(pages: PageImage[], _hints: { captionTag?: string | null }): Promise<Classification> {
    return this.find(pages)?.classification ?? UNKNOWN_CLASSIFICATION;
  }

  async extract(pages: PageImage[], _docType: DocType): Promise<Extraction> {
    return this.find(pages)?.extraction ?? EMPTY_EXTRACTION;
  }
}
