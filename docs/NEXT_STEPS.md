# Next steps

In the order I would actually do them.

---

## Before anyone uses it in earnest

**1. Connect the real AI reader and measure it.** Set `AI_PROVIDER=anthropic`, send
thirty real photographs through, and compare what it read against the papers. The
`field_corrections` table is built for exactly this: after a fortnight of ordinary
use it tells you which fields get corrected most, which is the honest measure of
whether the reading is good enough and where the thresholds should sit.

**2. Connect the bot and watch the group for a week.** The intake path is the part
the family actually touches. Watch what people send — sideways photos, two papers in
one frame, WhatsApp forwards — and let that shape the next fix.

**3. Implement the S3 driver** if deploying serverless. Three methods.

**4. Count opening stock properly.** Everything downstream inherits its accuracy.

---

## Soon after

**5. Tune the thresholds against real data.** `conf_medium` at 0.75 is a guess.
Too low and wrong figures pass silently; too high and everything queues for review
and the system becomes an irritation nobody uses.

**6. Weight the mapping suggestions.** Colour, category and size compatibility are
already stored. Folding them into the similarity score would visibly improve the
mapping workbench, which is where a new shop spends its first fortnight.

**7. Use document numbers in reconciliation grouping.** The current supplier + date
window occasionally merges two genuine deliveries. A challan number printed on the
bill is the strongest possible link and is already extracted.

**8. Add pagination** to the movement register and documents list before the data
outgrows the caps.

---

## When the basics are steady

**9. Read the order book.** The remaining document type. The schema, matching and
overdue logic already exist — this is a fixture, a prompt and a stage branch.

**10. A PO matching screen**, so an unusual delivery can be attributed to order lines
by hand rather than through an adjustment.

**11. Perceptual hashing for duplicates**, so the same paper photographed twice is
caught even when the files differ.

**12. Reorder suggestions.** `reorder_level` is stored and shown but nothing acts on
it. With a season's sales history, "what to order from whom" is the report that
earns its keep in a uniform shop with a rush every June.

**13. A stock-count mode.** A screen for walking the shelves on a phone, entering
counts, and producing the adjustments in one reviewed batch rather than one at a
time.

---

## Worth considering later

- **Materialised stock view** with incremental refresh, when the aggregate query
  starts to be felt.
- **Session invalidation on password change.**
- **Print layouts** for delivery challans and stock sheets.
- **A second shop or godown.** Locations are already a table, not an enum — the
  ledger, transfers and reports would mostly work; the UI assumes two in places.
- **Supplier returns / debit notes** as a first-class flow.

---

## What I would not rush

Automatic posting (`auto_post_high_confidence`) and any expansion of what the AI is
trusted to decide on its own. The value of this system is that a person confirms
anything uncertain and every number traces back to a photograph. That is worth more
than the minutes saved by removing the confirmation, at least until the reading has
a measured track record.
