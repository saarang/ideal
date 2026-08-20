# Assumptions

Where the specification was silent or the sample papers were ambiguous, a decision
had to be made. Each one below is reversible, and most are a setting.

---

## About the papers

**"28/5" means size 28, quantity 5.** Taken from the specification and confirmed by
the sample papers. Everything else in the size parser follows from treating this as
the default and composite sizes as the exception.

**Composite sizes were seeded as `12/14`, `28/32`, `14/16`, `16/18`** — the ones
visible on the samples. The real list belongs in Settings; the item master overrides
it per item anyway.

**Plausible sizes are 16–44 by default.** This range makes `28/5` unambiguous (5 is
not a size) while covering the garments on the sample papers. It is wrong for infant
sizes and would need widening if the shop stocks them — at which point more values
become genuinely ambiguous and more lines will ask for confirmation. That is the
correct trade: the alternative is silent misreadings.

**The Sarda challan's date is genuinely hard to read.** It is treated as low
confidence with a proposal rather than asserted.

**One of the aavak rows cannot be resolved from the photograph.** Several
combinations of quantities sum to the written total. The system records the raw text
and asks rather than picking one — this is the behaviour the sample was chosen to
demonstrate.

**Marathi words on the Sarda challan are kept as written and flagged.** No attempt is
made to translate or guess an item from an unreadable word.

---

## About stock

**Goods arrive at SHOP unless the paper says otherwise** (`default_receipt_location`).

**Sales go out of SHOP.** The POS is at the shop counter.

**The first paper to arrive posts the stock.** The specification says a challan, an
aavak entry and a bill may describe one delivery; it does not say which should be
believed. Posting the first and linking the rest means stock reflects goods as soon
as evidence exists, without double counting. Disagreements between the papers become
findings rather than silently changing the number already posted.

**`BLOCK` is the default negative-stock policy**, on the grounds that a refusal is
visible and a wrong number is not. `docs/OPERATIONS.md` recommends starting on
`WARN_ALLOW` until opening stock is trustworthy.

**Opening stock below zero is refused.** A negative opening balance is a problem in
the source data, not a ledger entry.

**Items with no size (a dupatta, a belt) use the size `FREE`.** Stock is always per
item *and* size, so every item needs one.

---

## About money

**₹1 tolerance** on money comparisons, per the specification. Quantities are compared
exactly — pieces are counted, not rounded.

**Tax is computed on the printed subtotal** where it is present and correct, and on
the recomputed subtotal where the printed one is itself wrong — otherwise one error
would cascade into every downstream check and hide its own cause.

**GST rates are read from the paper, not assumed.** No rate table is built in.

---

## About the system

**Sessions rather than a hosted auth service.** Self-contained, no external
dependency, and portable to any host. Invite-only: there is no self-registration.

**Three roles.** VIEWER / STAFF / ADMIN was the smallest set that separates looking,
working, and correcting. Adjustments and reversals are admin-only because they are
the two actions that can make the books say something the papers do not.

**Mock adapters are the default** for AI reading and Telegram, so the system runs,
demos and tests with no network and no keys. Both are single environment variables
away from real.

**Purchase orders are entered by hand**, not read from the order book. The
specification placed order-book extraction in a later phase; the schema, the
delivery matching and the overdue scanning are all present and working.

**The demo data is marked and removable.** Everything seeded by `seed:demo` carries
`is_demo`, so it can be cleared in one action without touching real records.

---

## About the sample data

The five sample papers were read carefully by eye and their contents encoded as
fixtures, including their defects: the arithmetic on the Sanjay bill was verified line
by line to ₹26,102, and the aavak totals were checked to confirm the ambiguous row
must sum to 18. The fixtures are keyed by filename so the demo seed can reproduce a
realistic first day.

Two sizes on the Sanjay bill (20 and 22) are deliberately not on that item's seeded
size list, so the demo shows a real question being asked rather than a system that
always agrees with itself.
