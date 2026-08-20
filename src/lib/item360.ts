/**
 * Item 360 — everything the shop wants to know about one item on one screen:
 * stock by size and location, quantities on order, recent movements, open
 * findings, supplier aliases, and where the item appears in documents.
 */
import { getPool, dq, dq1 } from './db';

export interface Item360 {
  item: {
    id: string; code: string; name: string; category: string | null; colour: string | null;
    uom: string; reorder_level: number | null; is_active: boolean; notes: string | null;
  };
  sizes: { size: string; pos_code: string | null; mrp: string | null; selling_price: string | null }[];
  stock: { size: string; SHOP: number; GODOWN: number; total: number }[];
  onOrder: { size: string; qty: number; po_no: string; supplier: string; expected_date: string | null }[];
  movements: {
    id: string; created_at: string; business_date: string; movement_type: string; size: string;
    location: string; qty: number; reason: string | null; source_type: string; source_id: string | null;
    reversal_of_id: string | null;
  }[];
  findings: { id: string; severity: string; type: string; title: string; created_at: string }[];
  aliases: { supplier: string; supplier_description: string; status: string }[];
  documents: { id: string; ref_no: string; doc_type: string; document_date: string | null; status: string; qty: number }[];
}

export async function getItem360(itemId: string): Promise<Item360 | null> {
  const pool = getPool();
  const item = await dq1<Item360['item'] & { category: string | null }>(pool,
    `SELECT i.id, i.code, i.name, c.name AS category, i.colour, i.uom, i.reorder_level, i.is_active, i.notes
     FROM items i LEFT JOIN item_categories c ON c.id = i.category_id
     WHERE i.id = $1`, [itemId]);
  if (!item) return null;

  const sizes = await dq<Item360['sizes'][number]>(pool,
    `SELECT size, pos_code, mrp::text, selling_price::text FROM item_sizes
     WHERE item_id=$1 ORDER BY sort_order, size`, [itemId]);

  const stockRows = await dq<{ size: string; code: string; qty: number }>(pool,
    `SELECT im.size, l.code, SUM(im.qty)::int AS qty
     FROM inventory_movements im JOIN locations l ON l.id = im.location_id
     WHERE im.item_id=$1 GROUP BY im.size, l.code`, [itemId]);
  const stockMap = new Map<string, { SHOP: number; GODOWN: number }>();
  for (const s of sizes) stockMap.set(s.size, { SHOP: 0, GODOWN: 0 });
  for (const r of stockRows) {
    const e = stockMap.get(r.size) ?? { SHOP: 0, GODOWN: 0 };
    if (r.code === 'SHOP') e.SHOP += r.qty; else if (r.code === 'GODOWN') e.GODOWN += r.qty;
    stockMap.set(r.size, e);
  }
  const stock = [...stockMap.entries()]
    .map(([size, v]) => ({ size, ...v, total: v.SHOP + v.GODOWN }))
    .sort((a, b) => {
      const na = parseInt(a.size, 10), nb = parseInt(b.size, 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.size.localeCompare(b.size);
    });

  const onOrder = await dq<Item360['onOrder'][number]>(pool,
    `SELECT pol.size, (pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0))::int AS qty,
            po.po_no, s.name AS supplier, po.expected_date
     FROM purchase_order_lines pol
     JOIN purchase_orders po ON po.id = pol.po_id
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN (SELECT po_line_id, SUM(quantity)::int AS qty FROM po_line_deliveries GROUP BY po_line_id) del
       ON del.po_line_id = pol.id
     WHERE pol.item_id=$1 AND po.status IN ('OPEN','PARTIALLY_DELIVERED','OVERDUE')
       AND (pol.quantity_ordered - pol.quantity_cancelled - COALESCE(del.qty,0)) > 0
     ORDER BY po.order_date`, [itemId]);

  const movements = await dq<Item360['movements'][number]>(pool,
    `SELECT im.id, im.created_at::text, im.business_date::text, im.movement_type, im.size,
            l.code AS location, im.qty, im.reason, im.source_type, im.source_id::text, im.reversal_of_id::text
     FROM inventory_movements im JOIN locations l ON l.id = im.location_id
     WHERE im.item_id=$1 ORDER BY im.created_at DESC LIMIT 100`, [itemId]);

  const findings = await dq<Item360['findings'][number]>(pool,
    `SELECT id, severity, type, title, created_at::text FROM findings
     WHERE item_id=$1 AND status='OPEN' ORDER BY created_at DESC LIMIT 20`, [itemId]);

  const aliases = await dq<Item360['aliases'][number]>(pool,
    `SELECT s.name AS supplier, a.supplier_description, a.status
     FROM supplier_item_aliases a JOIN suppliers s ON s.id = a.supplier_id
     WHERE a.item_id=$1 ORDER BY s.name`, [itemId]);

  const documents = await dq<Item360['documents'][number]>(pool,
    `SELECT d.id, d.ref_no, d.doc_type, d.document_date::text, d.status, SUM(dl.quantity)::int AS qty
     FROM document_lines dl JOIN documents d ON d.id = dl.document_id
     WHERE dl.item_id=$1
     GROUP BY d.id, d.ref_no, d.doc_type, d.document_date, d.status
     ORDER BY d.document_date DESC NULLS LAST, d.created_at DESC LIMIT 30`, [itemId]);

  return { item, sizes, stock, onOrder, movements, findings, aliases, documents };
}
