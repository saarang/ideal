# HTTP endpoints

Most of the application talks to the database through server actions rather than an
API — these are the routes that exist because something outside the browser calls
them, or because a browser needs a file.

Everything except the Telegram webhook and the cron tick requires a signed-in
session cookie.

---

## `POST /api/telegram/webhook`

Receives Telegram updates. Register it with `setWebhook` and the same secret; the
route accepts `X-Telegram-Bot-Api-Secret-Token`, or `?secret=` for platforms that
strip headers. Requests failing the check get 401.

Photos and image documents become documents; other content is ignored. `/start` and
`/help` get a short reply explaining what to send.

Always answers **200** even on internal failure — a Telegram webhook that returns an
error gets retried in a storm. Failures are written to `processing_errors` and the
sender is told, in plain words, that the photo could not be read.

```json
{ "ok": true, "handled": true, "ref": "DOC-001042" }
```

---

## `GET /api/files/<key>`

Streams a stored document photo. Requires a session; refuses path traversal; sets a
private cache header. This is the only read path for stored files — the bucket or
directory itself is never public.

---

## `GET /api/jobs/tick?secret=<JOBS_TICK_SECRET>`

One heartbeat for serverless deployments: processes up to ten queued pipeline jobs,
sends pending Telegram summaries, and — at most once an hour — runs the
reconciliation scans. Call it every minute from an external scheduler. `npm run
worker` does the same continuously where a long-running process is possible.

The secret may also be sent as `Authorization: Bearer …`.

```json
{ "ok": true, "jobs": { "processed": 3, "failed": 0 }, "summaries": 1,
  "scans": { "challanAwaitingInvoice": 0, "overdueOrders": 2 } }
```

---

## `GET /api/reports/<key>/csv`

Downloads a report as CSV. `<key>` is one of the report keys listed on the Reports
page (`stock-by-size`, `movement-register`, `open-orders`, …). Query parameters are
passed to the report — date-ranged reports accept `from` and `to` as `YYYY-MM-DD`.

---

## Imports

All three take `multipart/form-data` with a `file` field, and require STAFF.

### `POST /api/imports/pos/preview`

Parses a POS export and stores a preview. Optional `map` field: a JSON column mapping
(`{"quantity":"Qty","posCode":"Item Code",…}`). Without it the saved template is used,
or the columns are guessed from their headers.

Returns every row marked importable, duplicate, or problematic, plus the mapping that
was used, so the browser can offer it for correction. **Nothing posts.** If the exact
file was already imported and posted, `alreadyImportedFile` is true and the response
is otherwise empty.

### `POST /api/imports/pos/commit`

Body: `importId` from the preview. Posts the importable rows to the ledger at SHOP,
skipping duplicates.

```json
{ "posted": 42, "blocked": 0, "skippedDuplicates": 3, "errors": 1 }
```

### `POST /api/imports/items`

Imports a VasyERP product export into the item master. Names ending in a size are
split into item plus size; the POS code is kept on the size for sales matching.

### `POST /api/imports/opening`

Imports counted opening stock. Additional fields: `asOfDate` (`YYYY-MM-DD`) and
`location` (`SHOP` or `GODOWN`). Posts one OPENING movement per row. Safe to re-run —
rows already posted are skipped.

---

## `POST /api/dev/telegram`

**Development only** — returns 404 unless `DEV_TOOLS=1`, and refuses to run when
`TELEGRAM_MODE=real`. Feeds a photo through the exact path a real Telegram message
takes, then runs the pipeline inline so the result is immediately visible without a
worker. Fields: `file` or `samplePath`, plus optional `caption` and `sender`.

---

## Errors

Failures return a JSON object with a single `error` field and a status of 400
(bad input), 401 (not signed in), 403 (wrong role) or 404. Messages are written for a
person to read; stack traces and internals stay in `processing_errors`.
