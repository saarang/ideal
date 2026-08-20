# Limitations

An honest account of what this does not do, or does only partly. Nothing here is
hidden behind a half-working screen: where a thing is missing, it is missing.

---

## Not exercised against a live service

**The AI reader has never run against a real photograph in this build.** The
environment had no API key, so every test and every demo runs on fixtures written by
reading the sample papers by eye. The provider, the JSON schema, validation, and every
stage downstream are real and tested — but the reading *quality* on a fresh
photograph is unknown. Expect the first weeks to need corrections, and expect the
confidence thresholds (`conf_medium`, `classification_confirm_below`) to want tuning
once you can see how often it is right.

**The Telegram bot has never talked to Telegram.** api.telegram.org was unreachable
from the build environment. The webhook route, the poller, secret verification,
caption tags, album grouping, duplicate detection and the outgoing replies are all
real code, exercised through the mock transport and the simulator. The first live
connection is still a first live connection: expect to spend a few minutes on
BotFather privacy mode and the chat id.

**S3 storage is a stub.** The local-disk driver is complete and used throughout. The
S3 driver is three unimplemented methods with instructions above them — perhaps
twenty minutes of work, but it is not written, and local disk does not survive on
Vercel. This must be done before deploying serverless.

---

## Deliberately scoped out

**The order book is not read by AI.** Orders are typed in. The schema, delivery
matching against receipts, outstanding quantities and overdue scanning all work; only
the photograph-to-order step is absent.

**Purchase-order line matching is quantity-based, not interactive.** Deliveries fill
open order lines by supplier, item and size. There is no screen for manually saying
"this line of this challan fills that line of that order", so an unusual delivery
needs an adjustment rather than a correction to the match.

**Transfers have no slip document flow.** The transfer form works and posts both legs
correctly; a photographed transfer slip is classified but has no dedicated screen.

**There is no supplier return / debit note flow.** The movement type exists in the
ledger; nothing creates one except an adjustment.

**No global search.** Each list has its own filter and search. There is no single box
that searches papers, items and suppliers together.

**No printing.** Reports download as CSV. There is no print layout for a challan or a
stock sheet.

---

## Known rough edges

**Reconciliation groups by supplier and date window only.** Two separate deliveries
from one supplier in the same week can be pulled into one group, producing a
mismatch finding that is really two deliveries being compared. Narrowing
`recon_date_window_days` helps; document numbers would help more.

**Mapping suggestions use trigram similarity on the name alone.** Colour, category
and size compatibility are stored but not yet weighted into the score, so a
suggestion is sometimes obviously wrong to a human eye. It is never applied
automatically for supplier papers, so the cost is a wasted glance rather than a wrong
number.

**Duplicate detection is exact-content only.** The same paper photographed twice from
slightly different angles produces two different files and will not be caught
automatically. The header-based duplicate check (same supplier, same document number)
runs at validation and covers most of the rest.

**The dashboard's "pieces out this week" counts POS sales and customer issues only.**
Transfers and adjustments are excluded deliberately, but the label is terser than the
rule.

**No pagination anywhere.** Lists cap at 100–400 rows. Fine for one shop for a year;
the movement register will want paging before it will not.

**Every page is server-rendered on each request with no caching.** Correct and
simple, but the stock matrix does a full aggregate over the movement table each time
it is opened. At a few hundred thousand movements this will want a materialised view.

**The item master carries no reorder logic.** `reorder_level` is stored and shown;
nothing acts on it. The low-stock report is a threshold query, not a suggestion to
order.

**No file-size or rate limiting on uploads.** An accidental video sent to the group
is rejected by MIME type, but a very large photo is accepted and processed.

---

## Things that could bite

**Opening stock is the foundation of every number.** If it is counted carelessly,
every balance after it is wrong in the same way, and the system will confidently show
wrong figures for months. Count it properly, and re-count a sample after a few weeks.

**`auto_post_high_confidence` is off for good reason.** Turning it on means papers
enter stock with no human glance. It is safe only once the reader's accuracy is known
from real use.

**The demo purge is broad.** It deletes everything marked `is_demo` including
movements. It is admin-only and confirmed, but there is no undo.

**Sessions do not expire on password change.** Changing a password does not
invalidate existing sessions elsewhere. For a shop with a handful of trusted logins
this is a small risk; deactivating the login does cut access immediately.
