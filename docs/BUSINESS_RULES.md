# Business rules

Every rule the system applies, in plain language. Where a rule is configurable, the
setting name is given — all of them live under **Settings**.

---

## 1. Reading sizes and quantities

**"28/5" is size 28, quantity 5.** Never a division. This is how the trade writes it
and it is the system's default reading.

**"12/14" and "28/32" are single sizes.** A garment sized 12/14 is one size, and its
quantity comes from elsewhere on the paper. The system tells these apart from
size-over-quantity by:

1. the item's own size list, if the line is already mapped to an item — the item
   master is the authority;
2. the configured `known_composite_sizes` list (default `12/14`, `28/32`, `14/16`,
   `16/18`);
3. the column layout — a value sitting in a printed *Size* column with quantities in
   their own column is a size;
4. how it was written — stacked like a fraction means size over quantity, because
   composite sizes are written inline;
5. plausibility — a number outside `plausible_size_min`–`plausible_size_max`
   (default 16–44) is not a size, so `28/5` resolves cleanly;
6. the pattern of the row — `22/13 24/13 26/12 28/10` is an ascending size ladder,
   which settles each pair as size-over-quantity.

**When it still cannot tell, it does not choose.** The raw text is kept exactly as
written, a proposal is recorded with a confidence, the line is marked as needing
review, and a task is raised. Nothing uncertain reaches the stock ledger.

**A size in the Size column keeps its quantity.** Where one composite size sits in a
Size column and its count in a Qty column, the count is carried onto that line rather
than dropped.

**"42/–" is a size with nothing received.** A dash means the size was listed but
nothing came.

---

## 2. Reading a paper

The reader (AI or a person) records *what it saw* and *how sure it was*, per field.
It never calculates and never decides what enters stock.

- A line whose **description** was barely legible goes to review even when the size
  and quantity beside it read cleanly. A confident number attached to an unreadable
  word is still an unreadable line.
- Any field below `conf_medium` (default 0.75) goes to review.
- If the classifier is less sure than `classification_confirm_below` (default 0.8)
  about what kind of paper it is, a person confirms the type before anything else
  happens.
- A caption tag on the Telegram message (`#bill`, `#challan`, `#inward`, `#order`,
  `#ideal_challan`, `#shop_to_godown`, `#godown_to_shop`) is taken as the type
  without asking.

---

## 3. Arithmetic

Every figure printed on a bill is recomputed with decimal-safe arithmetic and
compared with what the paper says:

- each line: quantity × rate − discount, against the amount shown;
- the subtotal, against the sum of the lines;
- each tax (CGST / SGST / IGST) at its stated rate, against the amount shown;
- the grand total, including any rounding line;
- the handwritten total quantity, against the sum of the line quantities.

Differences up to `rounding_tolerance_inr` (default ₹1) are treated as rounding.
Anything larger is a finding stating both numbers and the difference.

**Quantities have no tolerance.** Pieces are counted, not rounded: a handwritten
total of 120 against lines summing to 121 is always a mismatch.

Where an input is missing — no rate on a line, no total printed — the check is
reported as *not checkable* rather than being guessed at or silently passed.

---

## 4. Stock

**The ledger is the only record of stock.** Every figure is the sum of movements for
that item, size and location. There is no stored balance to drift.

**The ledger is append-only.** The database itself refuses to update or delete a
movement. A mistake is corrected by a reversal — an equal and opposite entry pointing
at the original — and both remain visible for ever. Reversal is admin-only and always
requires a written reason.

**Stock moves only when a document is posted**, by a person pressing *Post to stock*
(or automatically if `auto_post_high_confidence` is on and the paper has no open
questions). Reading a photo never moves stock.

**Posting twice is harmless.** A document line that has already posted inserts
nothing the second time.

**One physical receipt, one stock entry.** When a challan, an aavak entry and a bill
describe the same delivery, whichever is posted first moves the stock. Later members
of the group skip any item+size already received; if everything is already in, the
document is filed as *linked, nothing posted* — recorded and searchable, but not
counted again. If a later paper carries extra lines, only those extra lines post.

**Negative stock** is governed by `negative_stock_policy`:
- `BLOCK` (default) — a posting that would take a balance below zero is refused and
  the whole transaction rolls back;
- `WARN_ALLOW` — it posts and raises a finding.

`BLOCK` is right once opening stock is trustworthy. Before that, `WARN_ALLOW` avoids
refusing real sales because the books have not caught up.

**Transfers are two linked entries** — out of one location, into the other, sharing a
group id — so the total across the business never changes. A transfer out of a
location still respects the negative-stock policy.

**Adjustments are admin-only and always require a written reason.** They are the
honest way to record a physical count, damage, or shrinkage — the reason is what a
future reader needs.

---

## 5. Items and supplier wordings

Suppliers write their own names for things: `N.BLUE H.P.T.C. BHARI` is Sanjay's
wording for Navy Blue Half Pant T.C. Map a wording once with *remember this wording*
and every future paper from that supplier maps itself.

- A **confirmed** alias maps automatically and silently.
- A **name similarity** match is offered as a suggestion, never applied on its own
  for supplier papers. On our own customer challans — where the wording is ours — a
  strong match is prefilled.
- An unmapped wording raises a mapping task; the document cannot post those lines
  until it is resolved.
- A size not on the item's size list raises a task naming the size and the item,
  rather than inventing a new size.
- Lines that are not stock at all (freight, notes, totals) can be marked as such and
  are then ignored by posting.

---

## 6. Papers that need chasing

Run on a schedule (worker or cron):

- **Challan awaiting invoice** — a posted challan with no bill after
  `challan_invoice_wait_days` (default 10) raises a reminder, so purchases and GST
  records stay complete.
- **Invoice without challan** — a bill that arrived with no delivery paper behind it
  is noted for information.
- **Order overdue** — an order past its expected date, or past
  `overdue_delivery_days` (default 14) from the order date where no expected date was
  given, is flagged with the quantity still outstanding, and the order is marked
  OVERDUE. Cancelling the order closes the finding.
- **Inward without source** — an aavak entry with no challan or bill in its group.

Findings are deduplicated: the same observation is never raised twice while it is
still open.

---

## 7. POS sales

Sales come from the VasyERP export, not from the shop's papers.

- **The same file cannot be imported twice** — files are fingerprinted by content, so
  a renamed copy is still recognised.
- **The same bill line cannot be imported twice** — each row has a key built from
  date, receipt number, item code, size, quantity and direction. Overlapping exports
  (a common habit) import only the rows that are new.
- Everything is **previewed before anything posts**: rows are shown as importable,
  duplicate, or problematic, with the reason.
- A row whose item cannot be matched is **reported, not guessed**. Good rows in the
  same file still post.
- A **return** adds stock back.
- Sales post out of SHOP.

---

## 8. Documents and duplicates

The same photo sent twice — a common thing in a family group — is recognised by
content and linked to the original rather than recorded again. Several photos of one
paper sent as an album become one document with several pages. A document wrongly
flagged as a duplicate can be released by a person.

---

## 9. Who can do what

| | VIEWER | STAFF | ADMIN |
|---|---|---|---|
| See everything | ✓ | ✓ | ✓ |
| Correct readings, map items, complete tasks | | ✓ | ✓ |
| Post documents, transfer stock, record orders | | ✓ | ✓ |
| Adjust stock, reverse movements | | | ✓ |
| Settings, logins, clear demo data | | | ✓ |

Every action is written to the audit trail with who did it and what changed.
