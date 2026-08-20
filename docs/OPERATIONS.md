# Operations

Written for whoever runs the shop's books day to day.

---

## The daily loop

**1. Send the papers.** Photograph each challan, bill, aavak page or delivery
challan and send it to the Telegram group as it happens. One paper per photo; several
photos of one long paper can go as an album. The bot replies with a reference number,
then again when it has finished reading.

Add a caption tag if you already know what it is — `#bill`, `#challan`, `#inward`,
`#ideal_challan` — it saves the system a question.

**2. Open the Dashboard.** It opens with what needs a decision, then the numbers.
Work top to bottom:

- **Tasks** — small jobs with one decision each. Most are finished on the paper
  itself: confirm a size, map a wording, fill in a missing party.
- **Documents → Needs attention** — each paper lists exactly what is holding it
  back.
- **Findings** — things the system noticed: a challan and an aavak entry that
  disagree, a bill whose arithmetic does not add up, an order that has not arrived.

**3. Post what is ready.** A paper with no open questions shows *Post to stock*.
That is the moment stock moves — not before.

**4. Import POS sales** when you export them (daily or weekly). Imports → POS sales:
choose the file, check the preview, post. Re-importing an overlapping export is safe.

---

## Starting from scratch

1. **Items.** Imports → product list, using the VasyERP export. Item names ending in
   a size (`NH TRACK PANT GREEN 28`) become one item with that size, and the 7-digit
   POS code is kept for matching sales.
2. **Suppliers and customers.** Settings, or as papers arrive.
3. **Opening stock.** Count physically, then Imports → opening stock with the count
   date. This is the single most important number in the system: everything after it
   is arithmetic on top of it.
4. **Set the negative-stock policy.** Leave it on `WARN_ALLOW` for the first weeks
   while the books catch up, then switch to `BLOCK`.
5. **Add logins** for whoever works the papers. Give VIEWER to anyone who only needs
   to look.
6. **Clear the demo data** if you loaded it (Settings → Clear demo data).

---

## When something looks wrong

**Stock is higher than the shelf.** Usually a sale not imported, or the same
delivery posted from two papers. Open the item, read its movement register — every
entry names the paper it came from. Check Reconciliation for a group where the same
goods posted twice.

**Stock is negative.** The books say more went out than came in: opening stock was
missed or too low, or a receipt was never posted. The Dashboard banner links to the
report. Fix the cause where possible; if the count is simply right and the history is
not, an admin adjustment with a written reason is the honest correction.

**A paper is stuck in "needs attention".** Open it — the reason is listed at the top
in words, naming the lines and what is missing.

**The system read a figure wrongly.** Correct it on the document. The original
reading is kept, your correction is recorded against your name, and the checks re-run
immediately.

**A wrong posting went through.** Admin only: find the entry in the movement register
(Stock, or the item's own page) and reverse it with a reason. The original stays
visible; a matching opposite entry cancels it.

**A photo failed to read.** Open it and press *Re-read photo*. If it fails again the
photo is probably too dark or too angled — retake it. The paper's record is kept
either way.

---

## Month-end

- **Reports → Current stock by item and size**, downloaded as CSV, is the closing
  position.
- **Challans awaiting invoices** shows what to chase before the GST return.
- **Open findings** should be at or near zero. Anything left is a real disagreement
  worth settling with the supplier.
- **Receipts by supplier** and **POS sales summary** give the month's movement.

---

## Keeping it running

- The **worker** (or the cron tick) must be running for photos to be read and
  reminders to appear. If the Documents page fills with papers stuck at *processing*,
  that is the first thing to check.
- **Back up the database.** The ledger cannot be edited from inside the application,
  but that is no protection against losing the database itself.
- **Change the seeded admin password** and remove any login that is no longer used.
- The **Telegram simulator** page must not be enabled in production (`DEV_TOOLS`
  unset).

---

## Settings worth knowing

| Setting | What it changes |
|---|---|
| `negative_stock_policy` | Whether a posting that would go below zero is refused or merely flagged |
| `rounding_tolerance_inr` | How large a money difference is treated as rounding (default ₹1) |
| `challan_invoice_wait_days` | How long before a challan with no bill is chased |
| `overdue_delivery_days` | How long before an order with no expected date is overdue |
| `recon_date_window_days` | How far apart papers from one supplier can be and still count as one delivery |
| `known_composite_sizes` | Which slashed values are one size rather than size-over-quantity |
| `conf_medium` | How unsure a reading has to be before a person is asked |
| `auto_post_high_confidence` | Whether a clean, fully-matched paper posts without a person |
| `default_receipt_location` | Where goods arrive unless the paper says otherwise |
