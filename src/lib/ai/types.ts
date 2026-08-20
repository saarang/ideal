import { z } from 'zod';

export const DocTypes = [
  'ORDER_BOOK','SUPPLIER_DELIVERY_CHALLAN','SUPPLIER_INVOICE','INWARD_BOOK',
  'IDEAL_CUSTOMER_DELIVERY_CHALLAN','SHOP_TO_GODOWN_TRANSFER','GODOWN_TO_SHOP_TRANSFER',
  'POS_SALES_FILE','STOCK_ADJUSTMENT','UNKNOWN',
] as const;
export type DocType = typeof DocTypes[number];

export const ClassificationSchema = z.object({
  docType: z.enum(DocTypes),
  confidence: z.number().min(0).max(1),
  signals: z.string().describe('Short human-readable reasons for the prediction'),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** A size/quantity token as written on the page ("28/5", "12/14", "42/–"). */
export const SizeTokenSchema = z.object({
  raw: z.string(),
  vertical: z.boolean().optional().describe('true when written as size over quantity like a fraction'),
});

export const ExtractedLineSchema = z.object({
  lineNo: z.number().int(),
  rawText: z.string().optional(),
  description: z.string().nullable(),
  supplierItemCode: z.string().nullable().optional(),
  colour: z.string().nullable().optional(),
  /** Tokens exactly as written; interpretation happens deterministically later. */
  sizeTokens: z.array(SizeTokenSchema).default([]),
  layoutHint: z.enum(['FRACTION_ROW', 'SIZE_QTY_COLUMNS']).nullable().optional(),
  /** For rows with a single explicit quantity (e.g. "50 PC Maroon Dupatta"). */
  quantity: z.number().int().nullable().optional(),
  sizeSingle: z.string().nullable().optional().describe('size when written in a dedicated Size column'),
  rate: z.string().nullable().optional(),
  discount: z.string().nullable().optional(),
  amountShown: z.string().nullable().optional(),
  pageNo: z.number().int().default(1),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
  conf: z.object({
    description: z.number().min(0).max(1).optional(),
    size: z.number().min(0).max(1).optional(),
    quantity: z.number().min(0).max(1).optional(),
    rate: z.number().min(0).max(1).optional(),
    amount: z.number().min(0).max(1).optional(),
  }).default({}),
});
export type ExtractedLine = z.infer<typeof ExtractedLineSchema>;

export const ExtractionSchema = z.object({
  header: z.object({
    documentNumber: z.string().nullable().optional(),
    documentDateRaw: z.string().nullable().optional(),
    supplierName: z.string().nullable().optional(),
    supplierConfidence: z.number().min(0).max(1).optional(),
    customerName: z.string().nullable().optional(),
    poRef: z.string().nullable().optional(),
    challanRef: z.string().nullable().optional(),
    invoiceRef: z.string().nullable().optional(),
    locationHint: z.string().nullable().optional(),
    gstin: z.string().nullable().optional(),
    subtotalShown: z.string().nullable().optional(),
    taxes: z.array(z.object({
      kind: z.enum(['CGST','SGST','IGST','OTHER']),
      ratePct: z.string().nullable(),
      amountShown: z.string().nullable(),
    })).default([]),
    roundingShown: z.string().nullable().optional(),
    grandTotalShown: z.string().nullable().optional(),
    handwrittenTotalQty: z.number().int().nullable().optional(),
    notes: z.string().nullable().optional(),
  }),
  lines: z.array(ExtractedLineSchema),
  rawText: z.string().describe('Best-effort full transcription of the page(s)'),
  overallConfidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface PageImage { path: string; mime: string; sha256: string; filename?: string | null; }

export interface DocumentAI {
  classify(pages: PageImage[], hints: { captionTag?: string | null }): Promise<Classification>;
  extract(pages: PageImage[], docType: DocType): Promise<Extraction>;
  readonly name: string;
}
