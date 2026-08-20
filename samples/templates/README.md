# Import templates

Two starting points for the Imports page. Both are read by column *header*, not by
position, so extra columns are ignored and the order does not matter.

## pos-sales-template.csv

The shape a VasyERP sales export arrives in. Only the quantity column is required;
everything else improves matching and deduplication:

- **Item Code** — the 7-digit POS code. This is how a sale finds its item and size,
  so without it rows have to fall back to item code + size and many will not match.
- **Bill Date** and **Bill No** — together with the item and quantity these form the
  key that stops the same sale importing twice. Overlapping exports are safe.
- **Type** — anything containing RETURN (or a negative quantity) adds stock back.

Rows whose item cannot be matched are reported in the preview and left unposted;
good rows in the same file still import.

## opening-stock-template.csv

A physical count. **Location** is optional — the whole sheet defaults to whichever
location you choose on the Imports page. Negative quantities are refused rather than
posted: a negative opening balance is a problem to fix at source.

Import this once, with the date you actually counted. Every balance in the system is
built on top of it.
