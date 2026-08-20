/**
 * Reports. Each report is a plain SQL query returning headers + rows so the
 * same definition serves the on-screen table and the CSV download.
 */
import { getPool, dq } from './db';
import { toCsv } from './importers/csv';

export interface ReportResult {
  key: string;
  title: string;
  description: string;
  headers: string[];
  rows: (string | number | null)[][];
}

export interface ReportDef {
  key: string;
  title: string;
  description: string;
  run(params: Record<string, string>): Promise<ReportResult>;
}

function res(def: Pick<ReportDef, 'key' | 'title' | 'description'>, headers: string[], rows: (string | number | null)[][]): ReportResult {
  return { ...def, headers, rows };
}

const stockBySize: ReportDef = {
  key: 'stock-by-size',
  title: 'Current stock by item and size',
  description: 'Book stock per size at SHOP and GODOWN, with totals. Negative numbers mean the ledger shows more going out than in.',
  async run() {
    const rows = await dq<{ code: string; name: string; size: string; shop: number; godown: number; total: number }>(getPool(),
      `SELECT i.code, i.name, im.size,
              COALESCE(SUM(im.qty) FILTER (WHERE l.code='SHOP'),0)::int AS shop,
              COALESCE(SUM(im.qty) FILTER (WHERE l.code='GODOWN'),0)::int AS godown,
              SUM(im.qty)::int AS total
       FROM inventory_movements im
       JOIN items i ON i.id = im.item_id
       JOIN locations l ON l.id = im.location_id
       GROUP BY i.code, i.name, im.size
       ORDER BY i.name, (regexp_match(im.size, '^\\d+'))[1]::int NULLS LAST, im.size`);
    return res(stockBySize, ['Item code', 'Item', 'Size', 'Shop', 'Godown', 'Total'],
      rows.map((r) => [r.code, r.name, r.size, r.shop, r.godown, r.total]));
  },
};

const stockTotals: ReportDef = {
  key: 'stock-totals',
  title: 'Stock value summary by item',
  description: 'Total pieces per item across all sizes and locations, valued at selling price where one is set.',
  async run() {
    const rows = await dq<{ code: string; name: string; pieces: number; value: string | null }>(getPool(),
      `SELECT i.code, i.name, SUM(im.qty)::int AS pieces,
              SUM(im.qty * COALESCE(isz.selling_price, 0))::numeric(14,2)::text AS value
       FROM inventory_movements im
       JOIN items i ON i.id = im.item_id
       LEFT JOIN item_sizes isz ON isz.item_id = im.item_id AND isz.size = im.size
       GROUP BY i.code, i.name
       HAVING SUM(im.qty) <> 0
       ORDER BY i.name`);
    return res(stockTotals, ['Item code', 'Item', 'Pieces', 'Value at selling price (₹)'],
      rows.map((r) => [r.code, r.name, r.pieces, r.value]));
  },
};

const lowStock: ReportDef = {
  key: 'low-stock',
  title: 'Low / negative stock',
  description: 'Item sizes at or below the reorder level, and anything negative. Negative stock means a receipt or opening balance is missing.',
  async run() {
    const rows = await dq<{ code: string; name: string; size: string; total: number; reorder: number | null }>(getPool(),
      `SELECT i.code, i.name, im.size, SUM(im.qty)::int AS total, i.reorder_level AS reorder
       FROM inventory_movements im JOIN items i ON i.id = im.item_id
       GROUP BY i.code, i.name, im.size, i.reorder_level
       HAVING SUM(im.qty) < 0 OR (i.reorder_level IS NOT NULL AND SUM(im.qty) <= i.reorder_level)
       ORDER BY SUM(im.qty)`);
    return res(lowStock, ['Item code', 'Item', 'Size', 'On hand', 'Reorder level'],
      rows.map((r) => [r.code, r.name, r.size, r.total, r.reorder]));
  },
};

const movementRegister: ReportDef = {
  key: 'movement-register',
  title: 'Movement register',
  description: 'Every stock movement in a date range (defaults to the last 30 days), newest first.',
  async run(params) {
    const from = params.from || null;
    const to = params.to || null;
    const rows = await dq<{
      created_at: string; business_date: string; type: string; item: string; size: string;
      location: string; qty: number; reason: string | null;
    }>(getPool(),
      `SELECT to_char(im.created_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI') AS created_at,
              to_char(im.business_date, 'DD-MM-YYYY') AS business_date,
              im.movement_type AS type, i.name AS item, im.size, l.code AS location, im.qty, im.reason
       FROM inventory_movements im
       JOIN items i ON i.id = im.item_id
       JOIN locations l ON l.id = im.location_id
       WHERE im.business_date >= COALESCE($1::date, CURRENT_DATE - 30)
         AND im.business_date <= COALESCE($2::date, CURRENT_DATE)
       ORDER BY im.created_at DESC
       LIMIT 2000`, [from, to]);
    return res(movementRegister, ['Recorded', 'Business date', 'Type', 'Item', 'Size', 'Location', 'Qty', 'Reason'],
      rows.map((r) => [r.created_at, r.business_date, r.type, r.item, r.size, r.location, r.qty, r.reason]));
  },
};

const receiptsBySupplier: ReportDef = {
  key: 'receipts-by-supplier',
  title: 'Receipts by supplier',
  description: 'Pieces received per supplier in a date range (defaults to the last 90 days), from posted receipt documents.',
  async run(params) {
    const rows = await dq<{ supplier: string; documents: number; pieces: number }>(getPool(),
      `SELECT s.name AS supplier, COUNT(DISTINCT d.id)::int AS documents, SUM(im.qty)::int AS pieces
       FROM inventory_movements im
       JOIN document_lines dl ON dl.id = im.source_line_id
       JOIN documents d ON d.id = dl.document_id
       JOIN suppliers s ON s.id = d.supplier_id
       WHERE im.movement_type='SUPPLIER_RECEIPT'
         AND im.business_date >= COALESCE($1::date, CURRENT_DATE - 90)
         AND im.business_date <= COALESCE($2::date, CURRENT_DATE)
       GROUP BY s.name ORDER BY pieces DESC`, [params.from || null, params.to || null]);
    return res(receiptsBySupplier, ['Supplier', 'Documents', 'Pieces received'],
      rows.map((r) => [r.supplier, r.documents, r.pieces]));
  },
};

const openOrders: ReportDef = {
  key: 'open-orders',
  title: 'Open purchase orders',
  description: 'Order lines with quantity still to be delivered, oldest first.',
  async run() {
    const rows = await dq<{
      po_no: string; supplier: string; order_date: string; expected: string | null;
      item: string | null; size: string | null; ordered: number; delivered: number; outstanding: number; status: string;
    }>(getPool(),
      `SELECT po.po_no, s.name AS supplier, to_char(po.order_date,'DD-MM-YYYY') AS order_date,
              to_char(po.expected_date,'DD-MM-YYYY') AS expected,
              COALESCE(i.name, pol.description_raw) AS item, pol.size,
              (pol.quantity_ordered - pol.quantity_cancelled)::int AS ordered,
              COALESCE(del.qty,0)::int AS delivered,
              (pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0))::int AS outstanding,
              po.status
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.po_id
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN items i ON i.id = pol.item_id
       LEFT JOIN (SELECT po_line_id, SUM(quantity)::int AS qty FROM po_line_deliveries GROUP BY po_line_id) del
         ON del.po_line_id = pol.id
       WHERE po.status IN ('OPEN','PARTIALLY_DELIVERED','OVERDUE')
         AND (pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0)) > 0
       ORDER BY po.order_date, po.po_no`);
    return res(openOrders, ['PO', 'Supplier', 'Ordered on', 'Expected by', 'Item', 'Size', 'Ordered', 'Delivered', 'Outstanding', 'Status'],
      rows.map((r) => [r.po_no, r.supplier, r.order_date, r.expected, r.item, r.size, r.ordered, r.delivered, r.outstanding, r.status]));
  },
};

const openFindings: ReportDef = {
  key: 'open-findings',
  title: 'Open findings',
  description: 'Everything the system has flagged and nobody has resolved yet, most serious first.',
  async run() {
    const rows = await dq<{ created: string; severity: string; type: string; title: string; supplier: string | null; doc: string | null }>(getPool(),
      `SELECT to_char(f.created_at AT TIME ZONE 'Asia/Kolkata','DD-MM-YYYY') AS created, f.severity, f.type, f.title,
              s.name AS supplier, d.ref_no AS doc
       FROM findings f
       LEFT JOIN suppliers s ON s.id = f.supplier_id
       LEFT JOIN documents d ON d.id = f.document_id
       WHERE f.status='OPEN'
       ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END, f.created_at DESC`);
    return res(openFindings, ['Raised', 'Severity', 'Type', 'What', 'Supplier', 'Document'],
      rows.map((r) => [r.created, r.severity, r.type, r.title, r.supplier, r.doc]));
  },
};

const posSalesSummary: ReportDef = {
  key: 'pos-sales-summary',
  title: 'POS sales by item',
  description: 'Pieces sold (net of returns) per item and size from imported POS files, in a date range (defaults to the last 30 days).',
  async run(params) {
    const rows = await dq<{ item: string; size: string; sold: number; returned: number; net: number }>(getPool(),
      `SELECT i.name AS item, ps.size,
              COALESCE(SUM(ps.quantity) FILTER (WHERE NOT ps.is_return),0)::int AS sold,
              COALESCE(SUM(ps.quantity) FILTER (WHERE ps.is_return),0)::int AS returned,
              COALESCE(SUM(ps.quantity) FILTER (WHERE NOT ps.is_return),0)::int
                - COALESCE(SUM(ps.quantity) FILTER (WHERE ps.is_return),0)::int AS net
       FROM pos_sales ps JOIN items i ON i.id = ps.item_id
       WHERE ps.status='POSTED'
         AND ps.sale_date >= COALESCE($1::date, CURRENT_DATE - 30)
         AND ps.sale_date <= COALESCE($2::date, CURRENT_DATE)
       GROUP BY i.name, ps.size ORDER BY net DESC, i.name`, [params.from || null, params.to || null]);
    return res(posSalesSummary, ['Item', 'Size', 'Sold', 'Returned', 'Net'],
      rows.map((r) => [r.item, r.size, r.sold, r.returned, r.net]));
  },
};

const customerIssues: ReportDef = {
  key: 'customer-issues',
  title: 'Deliveries to schools / customers',
  description: 'Pieces issued per customer from posted Ideal delivery challans, in a date range (defaults to the last 90 days).',
  async run(params) {
    const rows = await dq<{ customer: string; documents: number; pieces: number }>(getPool(),
      `SELECT c.name AS customer, COUNT(DISTINCT d.id)::int AS documents, ABS(SUM(im.qty))::int AS pieces
       FROM inventory_movements im
       JOIN document_lines dl ON dl.id = im.source_line_id
       JOIN documents d ON d.id = dl.document_id
       JOIN customers c ON c.id = d.customer_id
       WHERE im.movement_type='CUSTOMER_ISSUE'
         AND im.business_date >= COALESCE($1::date, CURRENT_DATE - 90)
         AND im.business_date <= COALESCE($2::date, CURRENT_DATE)
       GROUP BY c.name ORDER BY pieces DESC`, [params.from || null, params.to || null]);
    return res(customerIssues, ['Customer', 'Challans', 'Pieces issued'],
      rows.map((r) => [r.customer, r.documents, r.pieces]));
  },
};

const challanInvoiceStatus: ReportDef = {
  key: 'challan-invoice-status',
  title: 'Challans awaiting invoices',
  description: 'Posted supplier challans and whether an invoice has been linked to them yet.',
  async run() {
    const rows = await dq<{ ref: string; supplier: string; date: string | null; days: number; invoice: string | null }>(getPool(),
      `SELECT d.ref_no AS ref, s.name AS supplier, to_char(d.document_date,'DD-MM-YYYY') AS date,
              (CURRENT_DATE - d.document_date)::int AS days,
              (SELECT string_agg(d2.ref_no, ', ')
               FROM reconciliation_case_documents me
               JOIN reconciliation_case_documents inv ON inv.case_id = me.case_id AND inv.role='INVOICE'
               JOIN documents d2 ON d2.id = inv.document_id
               WHERE me.document_id = d.id) AS invoice
       FROM documents d JOIN suppliers s ON s.id = d.supplier_id
       WHERE d.doc_type='SUPPLIER_DELIVERY_CHALLAN' AND d.status IN ('POSTED','LINKED_NO_POSTING')
       ORDER BY d.document_date`);
    return res(challanInvoiceStatus, ['Challan', 'Supplier', 'Date', 'Days ago', 'Invoice(s)'],
      rows.map((r) => [r.ref, r.supplier, r.date, r.days, r.invoice ?? '— none yet']));
  },
};

export const REPORTS: ReportDef[] = [
  stockBySize, stockTotals, lowStock, movementRegister, receiptsBySupplier,
  openOrders, openFindings, posSalesSummary, customerIssues, challanInvoiceStatus,
];

export function getReport(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

export function reportToCsv(r: ReportResult): string {
  return toCsv(r.headers, r.rows);
}
