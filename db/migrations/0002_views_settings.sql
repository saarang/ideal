-- Derived views + default settings

-- Physical stock by item, size and location (sum of the append-only ledger).
CREATE VIEW v_stock_current AS
SELECT item_id, size, location_id, SUM(qty)::int AS qty
FROM inventory_movements
GROUP BY item_id, size, location_id;

-- Shop / godown / total per item+size.
CREATE VIEW v_stock_totals AS
SELECT
  s.item_id, s.size,
  COALESCE(SUM(CASE WHEN l.code = 'SHOP' THEN s.qty END), 0)::int AS shop_qty,
  COALESCE(SUM(CASE WHEN l.code = 'GODOWN' THEN s.qty END), 0)::int AS godown_qty,
  COALESCE(SUM(s.qty), 0)::int AS total_qty
FROM v_stock_current s
JOIN locations l ON l.id = s.location_id
GROUP BY s.item_id, s.size;

-- Delivered quantity per PO line (from confirmed delivery links).
CREATE VIEW v_po_line_delivered AS
SELECT pol.id AS po_line_id,
       COALESCE(SUM(d.quantity), 0)::int AS delivered_qty,
       MIN(d.delivery_date) AS first_delivery_date,
       MAX(d.delivery_date) AS last_delivery_date
FROM purchase_order_lines pol
LEFT JOIN po_line_deliveries d ON d.po_line_id = pol.id
GROUP BY pol.id;

-- On-order = ordered − cancelled − delivered (floored at 0) for open orders.
CREATE VIEW v_item_on_order AS
SELECT pol.item_id, pol.size,
       SUM(GREATEST(pol.quantity_ordered - pol.quantity_cancelled - v.delivered_qty, 0))::int AS on_order_qty
FROM purchase_order_lines pol
JOIN v_po_line_delivered v ON v.po_line_id = pol.id
JOIN purchase_orders po ON po.id = pol.po_id
WHERE po.status NOT IN ('CANCELLED','DELIVERED','OVER_DELIVERED')
  AND pol.item_id IS NOT NULL
GROUP BY pol.item_id, pol.size;

-- Receipt-type document lines extracted but not yet reflected in the ledger
-- (unmapped, under review, or the document is not posted). "Pending receipt".
CREATE VIEW v_pending_receipts AS
SELECT dl.item_id, dl.size_normalized AS size, SUM(dl.quantity)::int AS pending_qty
FROM document_lines dl
JOIN documents d ON d.id = dl.document_id
WHERE d.doc_type IN ('SUPPLIER_DELIVERY_CHALLAN','SUPPLIER_INVOICE','INWARD_BOOK')
  AND d.status IN ('NEEDS_REVIEW','READY_TO_POST','PROCESSING','RECEIVED')
  AND dl.item_id IS NOT NULL AND dl.quantity IS NOT NULL
GROUP BY dl.item_id, dl.size_normalized;

-- Reserved = customer-challan lines approved but not yet posted.
CREATE VIEW v_reserved AS
SELECT dl.item_id, dl.size_normalized AS size, SUM(dl.quantity)::int AS reserved_qty
FROM document_lines dl
JOIN documents d ON d.id = dl.document_id
WHERE d.doc_type = 'IDEAL_CUSTOMER_DELIVERY_CHALLAN'
  AND d.status IN ('READY_TO_POST','NEEDS_REVIEW')
  AND dl.item_id IS NOT NULL AND dl.quantity IS NOT NULL
GROUP BY dl.item_id, dl.size_normalized;

-- ── Default settings ─────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value) VALUES
  ('business_name',                 '"Ideal Uniforms"'),
  ('currency',                      '"INR"'),
  ('timezone',                      '"Asia/Kolkata"'),
  ('date_format',                   '"DD-MM-YYYY"'),
  ('overdue_delivery_days',         '14'),
  ('recon_date_window_days',        '7'),
  ('challan_invoice_wait_days',     '10'),
  ('rounding_tolerance_inr',        '1.00'),
  ('negative_stock_policy',         '"BLOCK"'),          -- BLOCK | WARN_ALLOW
  ('default_receipt_location',      '"SHOP"'),
  ('auto_post_high_confidence',     'false'),
  ('conf_high',                     '0.90'),
  ('conf_medium',                   '0.70'),
  ('classification_confirm_below',  '0.75'),
  ('known_composite_sizes',         '["12/14","28/32","14/16","16/18"]'),
  ('plausible_size_min',            '4'),
  ('plausible_size_max',            '50');
