/**
 * Real AI provider — Anthropic Messages API with vision.
 *
 * Isolated integration adapter. To enable: set AI_PROVIDER=anthropic and
 * ANTHROPIC_API_KEY in the environment. Everything downstream (validation,
 * arithmetic, size interpretation) is deterministic code; the model only
 * transcribes and structures what it sees.
 */
import fs from 'fs/promises';
import { Classification, ClassificationSchema, DocType, DocumentAI, Extraction, ExtractionSchema, PageImage } from './types';

const CLASSIFY_PROMPT = `You classify photographs of retail stock documents for a uniform shop in India.
Possible types: ORDER_BOOK, SUPPLIER_DELIVERY_CHALLAN, SUPPLIER_INVOICE, INWARD_BOOK,
IDEAL_CUSTOMER_DELIVERY_CHALLAN, SHOP_TO_GODOWN_TRANSFER, GODOWN_TO_SHOP_TRANSFER,
POS_SALES_FILE, STOCK_ADJUSTMENT, UNKNOWN.
Clues: printed "DELIVERY CHALLAN" forms FROM Ideal are IDEAL_CUSTOMER_DELIVERY_CHALLAN;
GST invoices with GSTIN/CGST/SGST are SUPPLIER_INVOICE; ruled notebook pages headed
"From: <supplier>" listing received goods are INWARD_BOOK (Aavak Vahi); handwritten
lists addressed "To Ideal" from a supplier are SUPPLIER_DELIVERY_CHALLAN.
Respond ONLY with JSON: {"docType": "...", "confidence": 0-1, "signals": "short reasons"}.`;

const EXTRACT_PROMPT = `You transcribe Indian retail stock documents (handwritten and printed) into strict JSON.
CRITICAL notation rules:
- Sizes are often written over quantities like a fraction: 28 over 5 (or "28/5") means size 28, quantity 5. NEVER compute a division.
- Genuine composite sizes such as 12/14 or 28/32 also exist, usually in a printed Size column with the quantity in a separate column.
- Do NOT decide which is which. Copy each token exactly as written into sizeTokens[].raw, set vertical=true when written as a fraction, and set layoutHint to FRACTION_ROW (row of fractions) or SIZE_QTY_COLUMNS (separate printed columns).
- A description written once followed by several size/quantity tokens is ONE line with many sizeTokens. Ditto marks (—"—, -do-) repeat the previous description.
- Copy money values as printed strings (e.g. "652.55"). Do not calculate anything. Empty rate/amount columns stay null.
- Dates: copy the raw text into documentDateRaw exactly (e.g. "13-08-26").
- Include a best-effort full transcription in rawText. Give per-field confidences 0-1; use low values for unclear handwriting rather than guessing.
Respond ONLY with JSON matching the provided schema. No prose, no markdown fences.`;

async function toImageBlock(p: PageImage) {
  const data = await fs.readFile(p.path);
  return {
    type: 'image',
    source: { type: 'base64', media_type: p.mime || 'image/jpeg', data: data.toString('base64') },
  };
}

async function callAnthropic(system: string, userBlocks: any[], maxTokens = 4000): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (AI_PROVIDER=anthropic)');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0,
      system,
      messages: [{ role: 'user', content: userBlocks }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
}

export class AnthropicProvider implements DocumentAI {
  readonly name = 'anthropic';

  async classify(pages: PageImage[], hints: { captionTag?: string | null }): Promise<Classification> {
    const blocks: any[] = [];
    for (const p of pages.slice(0, 3)) blocks.push(await toImageBlock(p));
    blocks.push({ type: 'text', text: hints.captionTag ? `User caption tag suggests: ${hints.captionTag}` : 'No caption tag supplied.' });
    const text = await callAnthropic(CLASSIFY_PROMPT, blocks, 500);
    return ClassificationSchema.parse(JSON.parse(text));
  }

  async extract(pages: PageImage[], docType: DocType): Promise<Extraction> {
    const blocks: any[] = [];
    for (const p of pages.slice(0, 5)) blocks.push(await toImageBlock(p));
    blocks.push({
      type: 'text',
      text: `Document type: ${docType}. Extract header and line items as JSON with this shape:\n` +
        JSON.stringify({
          header: { documentNumber: 'string|null', documentDateRaw: 'string|null', supplierName: 'string|null', supplierConfidence: 0.9, customerName: 'string|null', challanRef: 'string|null', invoiceRef: 'string|null', locationHint: 'string|null', gstin: 'string|null', subtotalShown: 'string|null', taxes: [{ kind: 'CGST', ratePct: '2.5', amountShown: '652.55' }], grandTotalShown: 'string|null', handwrittenTotalQty: 116, notes: 'string|null' },
          lines: [{ lineNo: 1, rawText: 'as written', description: 'string|null', colour: 'string|null', sizeTokens: [{ raw: '28/5', vertical: true }], layoutHint: 'FRACTION_ROW', quantity: null, sizeSingle: null, rate: 'string|null', amountShown: 'string|null', pageNo: 1, conf: { description: 0.9, size: 0.8, quantity: 0.8 } }],
          rawText: 'full transcription', overallConfidence: 0.85,
        }),
    });
    const text = await callAnthropic(EXTRACT_PROMPT, blocks, 8000);
    return ExtractionSchema.parse(JSON.parse(text));
  }
}
