-- Ideal Uniforms IMS — core schema
-- All quantities are whole units (INTEGER). All money is NUMERIC (never float).
-- Business document dates (DATE) are kept separate from system timestamps (TIMESTAMPTZ).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Reference sequences for human-readable numbers ───────────────────────────
CREATE SEQUENCE doc_ref_seq START 1001;
CREATE SEQUENCE finding_ref_seq START 1;
CREATE SEQUENCE task_ref_seq START 1;
CREATE SEQUENCE po_ref_seq START 1;
CREATE SEQUENCE transfer_ref_seq START 1;

-- ── Users & sessions ─────────────────────────────────────────────────────────
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STAFF' CHECK (role IN ('ADMIN','STAFF','VIEWER')),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  invited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ── Master data ──────────────────────────────────────────────────────────────
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,          -- SHOP / GODOWN
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gstin TEXT,
  phone TEXT,
  address TEXT,
  delivery_threshold_days INT,        -- overrides global setting when set
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);

CREATE TABLE item_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,          -- typically the school code: NH, MIS, DAV…
  parent_id UUID REFERENCES item_categories(id),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,          -- Ideal item code, e.g. IU-NH-TRK-GRN
  name TEXT NOT NULL,
  short_description TEXT,
  category_id UUID REFERENCES item_categories(id),
  subcategory TEXT,
  brand TEXT,
  colour TEXT,
  size_system TEXT NOT NULL DEFAULT 'NUMERIC',  -- NUMERIC | AGE | FREE …
  uom TEXT NOT NULL DEFAULT 'PC',
  reorder_level INT,
  preferred_supplier_id UUID REFERENCES suppliers(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX items_name_trgm ON items USING gin ((name || ' ' || coalesce(colour,'')) gin_trgm_ops);
CREATE INDEX items_category_idx ON items(category_id);

-- One row per allowed size of an item. POS SKUs are per-size, so the POS code
-- lives here (VasyERP exports one product code per item+size).
CREATE TABLE item_sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  size TEXT NOT NULL,                 -- '28', '12/14' (composite), 'FREE'
  sort_order INT NOT NULL DEFAULT 0,
  pos_code TEXT,
  mrp NUMERIC(12,2),
  selling_price NUMERIC(12,2),
  UNIQUE (item_id, size)
);
CREATE UNIQUE INDEX item_sizes_pos_code_uniq ON item_sizes(pos_code) WHERE pos_code IS NOT NULL;

CREATE TABLE supplier_item_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  supplier_item_code TEXT,
  supplier_description TEXT NOT NULL,
  supplier_colour TEXT,
  supplier_size_notation TEXT,
  item_id UUID REFERENCES items(id),
  mapping_confidence NUMERIC(4,3),
  status TEXT NOT NULL DEFAULT 'UNMAPPED'
    CHECK (status IN ('UNMAPPED','AI_SUGGESTED','USER_CONFIRMED','REJECTED','RETIRED')),
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  last_used_at TIMESTAMPTZ,
  source_document_id UUID,            -- FK added after documents
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX aliases_supplier_desc_trgm ON supplier_item_aliases USING gin (supplier_description gin_trgm_ops);
CREATE INDEX aliases_supplier_idx ON supplier_item_aliases(supplier_id, status);

-- ── Documents (single typed table for all source documents) ──────────────────
-- Supplier challans/invoices, inward-book pages, customer challans, transfer
-- slips and order-book pages are all rows here, discriminated by doc_type.
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no TEXT NOT NULL UNIQUE DEFAULT ('DOC-' || lpad(nextval('doc_ref_seq')::text, 6, '0')),
  doc_type TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (doc_type IN (
    'ORDER_BOOK','SUPPLIER_DELIVERY_CHALLAN','SUPPLIER_INVOICE','INWARD_BOOK',
    'IDEAL_CUSTOMER_DELIVERY_CHALLAN','SHOP_TO_GODOWN_TRANSFER','GODOWN_TO_SHOP_TRANSFER',
    'POS_SALES_FILE','STOCK_ADJUSTMENT','UNKNOWN')),
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN (
    'RECEIVED','PROCESSING','NEEDS_REVIEW','READY_TO_POST','POSTED',
    'LINKED_NO_POSTING','DUPLICATE','FAILED','ARCHIVED')),
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','IN_REVIEW','REVIEWED','NOT_REQUIRED')),

  -- classification
  predicted_type TEXT,
  classification_confidence NUMERIC(4,3),
  classification_source TEXT CHECK (classification_source IN ('TAG','AI','USER','SEED')),
  classification_signals TEXT,
  tag_raw TEXT,

  -- header (business) fields
  document_number TEXT,
  document_date DATE,
  document_date_raw TEXT,
  document_date_confidence NUMERIC(4,3),
  supplier_id UUID REFERENCES suppliers(id),
  supplier_name_raw TEXT,
  supplier_confidence NUMERIC(4,3),
  customer_id UUID REFERENCES customers(id),
  customer_name_raw TEXT,
  po_ref TEXT,
  challan_ref TEXT,
  invoice_ref TEXT,
  receipt_location_id UUID REFERENCES locations(id),
  dispatch_location_id UUID REFERENCES locations(id),
  destination_location_id UUID REFERENCES locations(id),
  currency TEXT NOT NULL DEFAULT 'INR',
  subtotal NUMERIC(12,2),
  discount_total NUMERIC(12,2),
  tax_summary JSONB,                  -- [{kind:'CGST', rate_pct, amount_shown}]
  rounding NUMERIC(12,2),
  grand_total NUMERIC(12,2),
  handwritten_total_qty INT,
  calculated_total_qty INT,
  notes TEXT,

  -- provenance
  raw_text TEXT,
  overall_confidence NUMERIC(4,3),
  original_filename TEXT,
  source TEXT NOT NULL DEFAULT 'TELEGRAM' CHECK (source IN ('TELEGRAM','WEB_UPLOAD','SEED','SYSTEM')),
  telegram_chat_id TEXT,
  telegram_message_id TEXT,
  telegram_media_group_id TEXT,
  telegram_uploader TEXT,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duplicate_of_id UUID REFERENCES documents(id),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_type_status_idx ON documents(doc_type, status);
CREATE INDEX documents_supplier_idx ON documents(supplier_id);
CREATE INDEX documents_date_idx ON documents(document_date);
CREATE INDEX documents_media_group_idx ON documents(telegram_media_group_id) WHERE telegram_media_group_id IS NOT NULL;

ALTER TABLE supplier_item_aliases
  ADD CONSTRAINT aliases_source_doc_fk FOREIGN KEY (source_document_id) REFERENCES documents(id);

CREATE TABLE document_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INT NOT NULL DEFAULT 1,
  original_path TEXT NOT NULL,        -- storage key of untouched upload
  processed_path TEXT,                -- storage key of prepared copy
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  sha256 TEXT NOT NULL,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  width INT, height INT,
  rotation_applied INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_no)
);
CREATE INDEX document_pages_sha_idx ON document_pages(sha256);
CREATE INDEX document_pages_tguid_idx ON document_pages(telegram_file_unique_id) WHERE telegram_file_unique_id IS NOT NULL;

CREATE TABLE document_processing_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,                -- INGEST/PREPARE/CLASSIFY/EXTRACT/VALIDATE/MATCH/…
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  attempt INT NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  log JSONB
);
CREATE INDEX runs_doc_idx ON document_processing_runs(document_id, started_at);

CREATE TABLE processing_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  stage TEXT,
  error TEXT NOT NULL,
  details JSONB,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extracted line items. Descriptions written once with many size/qty pairs are
-- exploded into one row per pair (line_no shared, sub_no increments).
CREATE TABLE document_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  sub_no INT NOT NULL DEFAULT 1,
  raw_text TEXT,
  raw_description TEXT,
  normalized_description TEXT,
  supplier_item_code TEXT,
  item_id UUID REFERENCES items(id),
  alias_id UUID REFERENCES supplier_item_aliases(id),
  category_guess TEXT,
  colour TEXT,
  size_raw TEXT,
  size_normalized TEXT,
  notation TEXT CHECK (notation IN ('SIZE_OVER_QTY','COMPOSITE_SIZE','PLAIN','SIZE_ONLY','AMBIGUOUS','EMPTY')),
  quantity INT,
  uom TEXT DEFAULT 'PC',
  unit_rate NUMERIC(12,2),
  discount NUMERIC(12,2),
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(12,2),
  amount_shown NUMERIC(12,2),
  amount_calculated NUMERIC(12,2),
  page_no INT DEFAULT 1,
  bbox JSONB,                          -- {x,y,w,h} in original-image pixels
  conf JSONB,                          -- {description,size,quantity,rate,amount}
  mapping_status TEXT NOT NULL DEFAULT 'UNMAPPED'
    CHECK (mapping_status IN ('UNMAPPED','AI_SUGGESTED','USER_CONFIRMED','NOT_REQUIRED','REJECTED')),
  review_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (review_status IN ('NOT_REQUIRED','NEEDS_REVIEW','REVIEWED')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, line_no, sub_no)
);
CREATE INDEX doc_lines_doc_idx ON document_lines(document_id);
CREATE INDEX doc_lines_item_idx ON document_lines(item_id);
CREATE INDEX doc_lines_mapping_idx ON document_lines(mapping_status) WHERE mapping_status IN ('UNMAPPED','AI_SUGGESTED');

CREATE TABLE field_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,           -- 'document' | 'document_line' | …
  entity_id UUID NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  corrected_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX corrections_entity_idx ON field_corrections(entity_type, entity_id);

-- ── Purchase orders ──────────────────────────────────────────────────────────
CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no TEXT NOT NULL UNIQUE DEFAULT ('PO-' || lpad(nextval('po_ref_seq')::text, 5, '0')),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  order_date DATE NOT NULL,
  expected_date DATE,
  source_document_id UUID REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','PARTIALLY_DELIVERED','DELIVERED','OVER_DELIVERED','CANCELLED','OVERDUE','MATCH_REVIEW_REQUIRED')),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  item_id UUID REFERENCES items(id),
  description_raw TEXT,
  size TEXT,
  quantity_ordered INT NOT NULL CHECK (quantity_ordered > 0),
  quantity_cancelled INT NOT NULL DEFAULT 0 CHECK (quantity_cancelled >= 0),
  notes TEXT,
  UNIQUE (po_id, line_no)
);

-- Delivered quantity is derived from links to receipt document lines.
CREATE TABLE po_line_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_line_id UUID NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  document_line_id UUID NOT NULL REFERENCES document_lines(id),
  quantity INT NOT NULL CHECK (quantity > 0),
  delivery_date DATE,
  match_method TEXT NOT NULL DEFAULT 'DETERMINISTIC',
  match_score NUMERIC(4,3),
  confirmed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (po_line_id, document_line_id)
);

-- ── Reconciliation ───────────────────────────────────────────────────────────
CREATE TABLE reconciliation_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type TEXT NOT NULL CHECK (case_type IN ('RECEIPT_GROUP','CHALLAN_INVOICE','ORDER_DELIVERY')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','MATCHED','PARTIALLY_MATCHED','QUANTITY_MISMATCH','SIZE_MISMATCH','ITEM_MISMATCH',
     'MISSING_INWARD_ENTRY','INWARD_WITHOUT_SOURCE_DOCUMENT','REVIEW_REQUIRED','RESOLVED')),
  supplier_id UUID REFERENCES suppliers(id),
  summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id)
);

CREATE TABLE reconciliation_case_documents (
  case_id UUID NOT NULL REFERENCES reconciliation_cases(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id),
  role TEXT NOT NULL,                  -- CHALLAN / INWARD / INVOICE / ORDER / DELIVERY
  PRIMARY KEY (case_id, document_id)
);

CREATE TABLE reconciliation_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES reconciliation_cases(id) ON DELETE CASCADE,
  left_line_id UUID REFERENCES document_lines(id),
  right_line_id UUID REFERENCES document_lines(id),
  matched_qty INT,
  method TEXT NOT NULL CHECK (method IN ('EXACT','DETERMINISTIC','FUZZY','MANUAL')),
  score NUMERIC(4,3),
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED')),
  explanation TEXT,
  confirmed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── POS imports ──────────────────────────────────────────────────────────────
CREATE TABLE pos_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,    -- same file cannot be imported twice
  template JSONB,                      -- saved column mapping
  row_count INT NOT NULL DEFAULT 0,
  ok_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','POSTED','FAILED')),
  imported_by UUID REFERENCES users(id),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ
);

CREATE TABLE pos_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES pos_imports(id) ON DELETE CASCADE,
  row_no INT NOT NULL,
  sale_date DATE,
  receipt_no TEXT,
  pos_item_code TEXT,
  item_id UUID REFERENCES items(id),
  size TEXT,
  quantity INT,
  rate NUMERIC(12,2),
  discount NUMERIC(12,2),
  tax NUMERIC(12,2),
  net_amount NUMERIC(12,2),
  is_return BOOLEAN NOT NULL DEFAULT FALSE,
  dedup_key TEXT,                      -- hash of the business identity of the txn
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','POSTED','ERROR','SKIPPED_DUPLICATE','BLOCKED')),
  error TEXT,
  UNIQUE (import_id, row_no)
);
CREATE UNIQUE INDEX pos_sales_dedup_uniq ON pos_sales(dedup_key) WHERE status = 'POSTED';

-- ── Stock transfers (manual entry or from transfer-slip documents) ───────────
CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no TEXT NOT NULL UNIQUE DEFAULT ('TRF-' || lpad(nextval('transfer_ref_seq')::text, 5, '0')),
  from_location_id UUID NOT NULL REFERENCES locations(id),
  to_location_id UUID NOT NULL REFERENCES locations(id),
  transfer_date DATE NOT NULL,
  source_document_id UUID REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  created_by UUID REFERENCES users(id),
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_location_id <> to_location_id)
);

CREATE TABLE stock_transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  size TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  document_line_id UUID REFERENCES document_lines(id)
);

-- ── Immutable inventory ledger ───────────────────────────────────────────────
CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'OPENING','SUPPLIER_RECEIPT','POS_SALE','POS_RETURN','CUSTOMER_ISSUE','CUSTOMER_RETURN',
    'TRANSFER_OUT','TRANSFER_IN','SUPPLIER_RETURN','ADJUSTMENT','REVERSAL')),
  item_id UUID NOT NULL REFERENCES items(id),
  size TEXT NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  qty INT NOT NULL CHECK (qty <> 0),   -- signed: + into location, − out of location
  business_date DATE NOT NULL,
  source_type TEXT NOT NULL,           -- DOCUMENT_LINE / POS_SALE / TRANSFER_LINE / IMPORT / MANUAL / REVERSAL
  source_id UUID,                      -- parent (document / import / transfer)
  source_line_id UUID,                 -- the atomic unit that may post exactly once per location
  transfer_group_id UUID,              -- links the − and + legs of one transfer
  reversal_of_id UUID REFERENCES inventory_movements(id),
  reason TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotency: one source line posts at most once per location.
CREATE UNIQUE INDEX movements_source_uniq
  ON inventory_movements(source_type, source_line_id, location_id)
  WHERE source_line_id IS NOT NULL;
CREATE INDEX movements_item_idx ON inventory_movements(item_id, size, location_id);
CREATE INDEX movements_date_idx ON inventory_movements(business_date);
CREATE INDEX movements_source_idx ON inventory_movements(source_type, source_id);

-- The ledger is append-only. Corrections are made with reversing entries.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only; create a reversal instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_movements_immutable
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ── Findings & tasks ─────────────────────────────────────────────────────────
CREATE TABLE findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no TEXT NOT NULL UNIQUE DEFAULT ('F-' || lpad(nextval('finding_ref_seq')::text, 5, '0')),
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO','WARNING','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','ACCEPTED','FALSE_POSITIVE','CANCELLED')),
  title TEXT NOT NULL,
  explanation TEXT,
  supplier_id UUID REFERENCES suppliers(id),
  customer_id UUID REFERENCES customers(id),
  document_id UUID REFERENCES documents(id),
  related_document_ids UUID[],
  item_id UUID REFERENCES items(id),
  size TEXT,
  expected_value TEXT,
  actual_value TEXT,
  difference TEXT,
  recommended_action TEXT,
  dedup_key TEXT,                      -- prevents the same automated finding twice
  assigned_to UUID REFERENCES users(id),
  due_date DATE,
  resolution TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX findings_dedup_uniq ON findings(dedup_key) WHERE dedup_key IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX findings_status_idx ON findings(status, severity);
CREATE INDEX findings_doc_idx ON findings(document_id);

CREATE TABLE workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no TEXT NOT NULL UNIQUE DEFAULT ('T-' || lpad(nextval('task_ref_seq')::text, 5, '0')),
  task_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  title TEXT NOT NULL,
  document_id UUID REFERENCES documents(id),
  document_line_id UUID REFERENCES document_lines(id),
  finding_id UUID REFERENCES findings(id),
  payload JSONB,
  dedup_key TEXT,
  assigned_to UUID REFERENCES users(id),
  due_date DATE,
  completed_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tasks_dedup_uniq ON workflow_tasks(dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('OPEN','IN_PROGRESS');
CREATE INDEX tasks_status_idx ON workflow_tasks(status, priority);

CREATE TABLE task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Processing queue, audit, settings, misc ──────────────────────────────────
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  next_stage TEXT NOT NULL,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pick_idx ON processing_jobs(status, run_after) WHERE status = 'QUEUED';

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  actor_type TEXT NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','SYSTEM','TELEGRAM')),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_events(entity_type, entity_id);
CREATE INDEX audit_time_idx ON audit_events(created_at);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE telegram_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','MOCKED')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('ITEM_MASTER','OPENING_STOCK','SUPPLIERS','VASYERP_PRODUCTS')),
  filename TEXT NOT NULL,
  file_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'DONE' CHECK (status IN ('PREVIEW','DONE','FAILED')),
  ok_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  errors JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
