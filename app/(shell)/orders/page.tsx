import Link from 'next/link';
import { q } from '@/src/lib/db';
import { createPoAction, cancelPoAction } from '@/app/actions';
import { ActionForm, Reveal } from '@/app/ui';
import { Empty, StatusChip, fmtDate } from '../../format';

export const dynamic = 'force-dynamic';

interface PoRow {
  id: string; po_no: string; supplier: string; order_date: string; expected_date: string | null;
  status: string; ordered: number; cancelled: number; delivered: number; lines: number;
}
interface PoLine {
  po_id: string; line_no: number; description_raw: string | null; item_name: string | null;
  size: string | null; quantity_ordered: number; quantity_cancelled: number; delivered: number;
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { f = 'open' } = await searchParams;
  const open = f !== 'all';

  const [pos, lines, suppliers] = await Promise.all([
    q<PoRow>(
      `SELECT po.id, po.po_no, s.name AS supplier, po.order_date, po.expected_date, po.status,
              COALESCE(SUM(pol.quantity_ordered),0)::int AS ordered,
              COALESCE(SUM(pol.quantity_cancelled),0)::int AS cancelled,
              COALESCE(SUM(v.delivered_qty),0)::int AS delivered,
              COUNT(pol.id)::int AS lines
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN purchase_order_lines pol ON pol.po_id = po.id
       LEFT JOIN v_po_line_delivered v ON v.po_line_id = pol.id
       ${open ? `WHERE po.status NOT IN ('DELIVERED','CANCELLED')` : ''}
       GROUP BY po.id, s.name
       ORDER BY po.order_date DESC, po.po_no DESC LIMIT 100`),
    q<PoLine>(
      `SELECT pol.po_id, pol.line_no, pol.description_raw, i.name AS item_name, pol.size,
              pol.quantity_ordered, pol.quantity_cancelled, COALESCE(v.delivered_qty,0)::int AS delivered
       FROM purchase_order_lines pol
       LEFT JOIN items i ON i.id = pol.item_id
       LEFT JOIN v_po_line_delivered v ON v.po_line_id = pol.id
       ORDER BY pol.po_id, pol.line_no`),
    q<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE is_active ORDER BY name`),
  ]);
  const linesByPo = new Map<string, PoLine[]>();
  for (const l of lines) {
    const arr = linesByPo.get(l.po_id) ?? [];
    arr.push(l); linesByPo.set(l.po_id, arr);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Purchase orders</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            What has been ordered from suppliers, and how much of it has actually arrived on paper.
          </p>
        </div>
        <nav className="flex gap-1" aria-label="Filter">
          <Link href="/orders" className={`btn ${open ? 'btn-primary' : 'btn-secondary'}`}>Open</Link>
          <Link href="/orders?f=all" className={`btn ${!open ? 'btn-primary' : 'btn-secondary'}`}>All</Link>
        </nav>
      </header>

      <Reveal label="Record a new order" className="card card-pad">
        <ActionForm action={createPoAction} resetOnSuccess className="grid sm:grid-cols-3 gap-2.5 mt-2">
          <div>
            <label className="lbl">Supplier</label>
            <select name="supplierId" className="input" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="lbl">Order date</label>
            <input name="orderDate" type="date" className="input" required defaultValue={new Date().toISOString().slice(0, 10)} />
          </div>
          <div>
            <label className="lbl">Expected by</label>
            <input name="expectedDate" type="date" className="input" />
          </div>
          <div className="sm:col-span-3">
            <label className="lbl">Lines — one per row, written as: description | size | quantity</label>
            <textarea name="lines" className="input font-mono" rows={4} required
                      placeholder={'Navy Blue Half Pant T.C. | 12/14 | 24\nNavy Blue Skirt | 15 | 12'} />
            <p className="text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>
              The description is matched to an item automatically where it clearly fits; otherwise the line stays as written and is matched when the goods arrive.
            </p>
          </div>
          <div className="sm:col-span-3">
            <button className="btn btn-primary" type="submit">Record order</button>
          </div>
        </ActionForm>
      </Reveal>

      {pos.length === 0 && <div className="card card-pad"><Empty>{open ? 'No open orders.' : 'No orders recorded yet.'}</Empty></div>}

      <div className="space-y-3">
        {pos.map((po) => {
          const net = po.ordered - po.cancelled;
          const pct = net > 0 ? Math.min(100, Math.round((po.delivered / net) * 100)) : 0;
          return (
            <div key={po.id} className="card card-pad">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <strong className="qty">{po.po_no}</strong>
                  <span className="text-sm">{po.supplier}</span>
                  <StatusChip status={po.status} />
                </div>
                <div className="text-xs" style={{ color: 'var(--ink-soft)' }}>
                  Ordered {fmtDate(po.order_date)}{po.expected_date && <> · expected {fmtDate(po.expected_date)}</>}
                </div>
              </div>

              <div className="mt-2 flex items-center gap-3">
                <div className="flex-1 h-2 rounded" style={{ background: 'var(--khaki-soft)' }}>
                  <div className="h-2 rounded" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--good)' : 'var(--khaki)' }} />
                </div>
                <span className="qty text-sm">{po.delivered} / {net} pcs</span>
              </div>

              <Reveal label={`Lines (${po.lines})`} className="mt-2">
                <table className="tbl mt-1">
                  <thead><tr><th>#</th><th>As ordered</th><th>Item</th><th>Size</th><th className="num">Ordered</th><th className="num">Arrived</th><th className="num">Awaited</th></tr></thead>
                  <tbody>
                    {(linesByPo.get(po.id) ?? []).map((l) => {
                      const lNet = l.quantity_ordered - l.quantity_cancelled;
                      return (
                        <tr key={l.line_no}>
                          <td className="qty">{l.line_no}</td>
                          <td className="text-sm">{l.description_raw ?? '—'}</td>
                          <td className="text-sm" style={{ color: 'var(--ink-soft)' }}>{l.item_name ?? 'not matched yet'}</td>
                          <td className="qty">{l.size ?? '—'}</td>
                          <td className="qty">{lNet}</td>
                          <td className="qty">{l.delivered}</td>
                          <td className="qty" style={l.delivered < lNet ? { color: 'var(--warn)' } : { color: 'var(--good)' }}>{Math.max(0, lNet - l.delivered)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Reveal>
              {po.status !== 'CANCELLED' && po.status !== 'DELIVERED' && (
                <div className="mt-2">
                  <ActionForm action={cancelPoAction} confirm={`Cancel ${po.po_no}? Anything not yet delivered will no longer be awaited.`} className="inline">
                    <input type="hidden" name="poId" value={po.id} />
                    <button className="btn btn-danger" type="submit">Cancel order</button>
                  </ActionForm>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
