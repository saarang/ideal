# Architecture

## The shape of it

```
Telegram group ──photo──► webhook / poller ──► ingest ──► processing_jobs
                                                              │
                                          ┌───────────────────┘
                                          ▼
              PREPARE ─► CLASSIFY ─► EXTRACT ─► VALIDATE ─► MATCH ─► STATUS
                 │           │          │           │         │        │
              straighten   what      read into   recompute   find    ready, or
              the photo    kind of   raw + conf   totals,    items   list what
                           paper?    per field    dates      + POs   is missing
                                          │
                                          ▼
                            NEEDS_REVIEW ──person decides──► READY_TO_POST
                                                                  │
                                                            "Post to stock"
                                                                  │
                                                                  ▼
                                                      inventory_movements
                                                      (append-only ledger)
```

Every stage is a plain function taking a document id. They are idempotent and
individually re-runnable, which is what makes the "Re-read photo" and "Re-process"
buttons safe. Each attempt is recorded in `document_processing_runs`; failures also
land in `processing_errors` and flip the document to FAILED rather than disappearing.

**A photo never posts itself.** Reading and posting are separate steps with a person
in between (unless `auto_post_high_confidence` is switched on, and even then only for
papers with no open questions).

---

## Layers

| Layer | Where | Responsibility |
|---|---|---|
| Domain | `src/lib/domain/` | Pure business logic: size notation, GST arithmetic, the ledger, findings. No HTTP, no React. Fully unit-tested. |
| Pipeline | `src/lib/pipeline/` | The stages above, plus reconciliation and posting. |
| Adapters | `src/lib/ai/`, `telegram/`, `storage/` | Everything external, behind an interface with a mock implementation. |
| Importers | `src/lib/importers/` | POS sales, product master, opening stock. |
| Server actions | `app/actions.ts` | Every mutation the UI performs, with role checks and audit. |
| Pages | `app/(shell)/` | Server components reading straight from Postgres. |
| API routes | `app/api/` | Telegram webhook, file serving, cron tick, CSV, imports. |

The domain layer knows nothing about Next.js. That is why the same code runs from a
web request, the worker, a seed script, and the tests.

---

## Data model

Thirty-four tables. The centre of gravity is *documents → lines → movements*.

```
                    ┌──────────────┐
                    │    users     │──sessions
                    └──────┬───────┘
                           │ created_by / resolved_by / …
   ┌─────────────┐         │
   │  suppliers  │◄────┐   │
   └──────┬──────┘     │   │
          │            │   │
          │      ┌─────┴───┴──────────────────────────┐
          │      │           documents                │
          │      │  ref_no, doc_type, status,         │
          │      │  document_number/date + confidence, │
          │      │  supplier_id / customer_id,        │──► document_pages
          │      │  totals, raw_text, telegram_*      │──► document_processing_runs
          │      └─────┬──────────────────────────────┘
          │            │ 1..n
          │      ┌─────▼──────────────────────────────┐
          │      │        document_lines              │
          │      │  line_no + sub_no  ◄── one row per │
          │      │  size/qty pair under one wording   │
          │      │  raw_description, size_raw,        │
          │      │  size_normalized, notation, qty,   │
          │      │  conf jsonb, mapping_status,       │
          │      │  review_status                     │
          │      └─────┬───────────────┬──────────────┘
          │            │               │
          │            │ item_id       │ source_line_id
   ┌──────▼──────┐     │        ┌──────▼───────────────────┐
   │supplier_item│     │        │   inventory_movements    │
   │  _aliases   │─────┤        │  APPEND-ONLY (trigger)   │
   │ "how THIS   │     │        │  signed qty, item, size, │
   │  supplier   │     │        │  location, business_date,│
   │  writes it" │     │        │  source_*, reversal_of   │
   └─────────────┘     │        └──────────────────────────┘
                 ┌─────▼─────┐        ▲            ▲
                 │   items   │────────┘            │
                 │item_sizes │                     │
                 └─────┬─────┘              ┌──────┴────────┐
                       │                    │ pos_sales     │
                       │                    │ stock_transfer│
                       │                    │  _lines       │
                       │                    └───────────────┘
        ┌──────────────▼────────────┐
        │ purchase_orders / _lines  │──po_line_deliveries──► document_lines
        └───────────────────────────┘

  reconciliation_cases ──case_documents──► documents
           └──matches                      (roles: CHALLAN / INWARD / INVOICE)

  findings · workflow_tasks · task_events · field_corrections · audit_events
  system_settings · processing_jobs · processing_errors · telegram_outbox · imports
```

### Choices worth explaining

**One `documents` table, not one per paper type.** A challan, a bill, an aavak page
and a customer challan share 90% of their fields and all of their pipeline. Document
type is a column; type-specific behaviour lives in code, not in the schema. This kept
the pipeline single-path and the UI single-path.

**`line_no` + `sub_no`.** A handwritten line reads
`Maroon Jacket 26/5 28/2 30/14` — one wording, three size/quantity pairs. Each pair
becomes its own row sharing `line_no`, distinguished by `sub_no`, with the original
`raw_text` preserved on every one. Stock needs the pairs; a person checking against
the photo needs the original line.

**The ledger is the only truth about stock.** There is no `quantity_on_hand` column
anywhere. Stock is `SUM(qty)` over `inventory_movements`, grouped by item, size and
location. Nothing can drift out of agreement with its own history, and every figure
on screen can be traced to the movements — and therefore the papers — behind it.

**Append-only is enforced by the database.** A trigger raises an exception on any
UPDATE or DELETE of `inventory_movements`. Not a convention, not application
discipline: `DELETE FROM inventory_movements` fails for the application, for a
psql session, for anyone. Mistakes are corrected by posting an equal and opposite
REVERSAL row that points at the original; both stay visible for ever.

**Idempotency by unique index.** `(source_type, source_line_id, location_id)` is
unique where `source_line_id` is set, and posting uses `ON CONFLICT DO NOTHING`.
Posting the same document line twice inserts nothing the second time. The location
in the key is what lets a transfer write two rows (out and in) from one source line.

**Advisory locks on posting.** Before checking a balance, `postMovements` takes
`pg_advisory_xact_lock` per item+size+location, in sorted order. Two people posting
at once cannot both pass a negative-stock check on the same balance, and the sorted
order rules out deadlocks.

**Confidence travels with the data.** `document_lines.conf` is a jsonb with a score
per field (description, size, quantity, rate, amount). The parser's own confidence is
combined with the reader's. Below `conf_medium`, the line goes to review regardless
of how neat the rest of the row looked.

**Findings vs tasks.** A *finding* is something the system noticed and wrote in the
register — it may be closed as fixed, accepted or a false alarm. A *task* is a
specific job for a person, with a single decision at the end. Findings explain, tasks
act. Both carry a `dedup_key` so the same observation is not raised twice.

---

## Reconciliation

The same goods arrive on up to three papers: the supplier's challan, the aavak vahi
entry, and later the bill. A *receipt group* is the set of documents from one
supplier within `recon_date_window_days`. Within a group the quantities are compared
per item+size across each pair of roles, and any disagreement becomes a finding
naming both numbers.

Stock is posted by whichever document arrives first. When a later member of the same
group is posted, `alreadyPostedKeysForGroup` returns the item+size keys already in
the ledger; those lines are skipped. If every line is skipped, the document is filed
as LINKED_NO_POSTING — recorded, searchable, linked to its siblings, but adding
nothing to stock. If it carries *extra* lines, only those post. This is the
no-double-count rule, and it is tested from both directions.

---

## Security

Sessions are random 32-byte tokens, stored hashed (sha256) in `sessions`, carried in
an httpOnly cookie, 30-day expiry. `requireUser(role)` guards pages and redirects;
`apiUser(role)` guards routes and throws 401/403. Three roles: VIEWER reads, STAFF
works papers and stock, ADMIN additionally corrects stock, reverses movements, edits
settings and manages logins.

Document photos are never public. `/api/files/…` checks the session, refuses path
traversal, and streams bytes through the storage adapter. The Telegram webhook
verifies a shared secret and ignores chats other than the configured group.

Every mutation writes to `audit_events` with actor, action, entity and before/after
snapshots. Field-level edits additionally write `field_corrections`, which is what
makes it possible to see later that the reader misread a figure and a person fixed
it — useful both for trust and for judging whether the AI is worth its cost.
