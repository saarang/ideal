import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getItem360 } from '@/src/lib/item360';
import { addItemSizeAction } from '@/app/actions';
import { ActionForm } from '@/app/ui';
import { DOC_TYPE_LABEL, DocLink, Empty, Stamp, StatusChip, fmtDate, fmtDateTime, inr } from '../../../format';

export const dynamic = 'force-dynamic';

const MOVE_LABEL: Record<string, string> = {
  OPENING: 'Opening balance', SUPPLIER_RECEIPT: 'Received', CUSTOMER_ISSUE: 'Issued',
  POS_SALE: 'POS sale', POS_RETURN: 'POS return', TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in', ADJUSTMENT: 'Adjustment', REVERSAL: 'Reversal',
};

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getItem360(id);
  if (!d) notFound();

  const totalStock = d.stock.reduce((a, s) => a + s.total, 0);
  const totalOnOrder = d.onOrder.reduce((a, s) => a + s.qty, 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs" style={{ color: 'var(--ink-soft)' }}><Link href="/items" className="link">Items</Link> / {d.item.code}</p>
          <h1 className="text-2xl">{d.item.name}</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            {d.item.category ?? 'Uncategorised'}{d.item.colour ? ` · ${d.item.colour}` : ''} · counted in {d.item.uom.toLowerCase()}
            {!d.item.is_active && <span className="chip ml-2">inactive</span>}
          </p>
        </div>
        <div className="flex gap-3">
          <div className="card card-pad text-center">
            <div className="qty text-2xl font-semibold" style={totalStock < 0 ? { color: 'var(--bad)' } : undefined}>{totalStock}</div>
            <div className="text-xs" style={{ color: 'var(--ink-soft)' }}>in stock</div>
          </div>
          <div className="card card-pad text-center">
            <div className="qty text-2xl font-semibold">{totalOnOrder}</div>
            <div className="text-xs" style={{ color: 'var(--ink-soft)' }}>on order</div>
          </div>
        </div>
      </header>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card card-pad">
          <div className="section-title">Stock by size</div>
          <table className="tbl">
            <thead><tr><th>Size</th><th className="num">Shop</th><th className="num">Godown</th><th className="num">Total</th><th className="num">MRP</th></tr></thead>
            <tbody>
              {d.stock.map((s) => {
                const sz = d.sizes.find((x) => x.size === s.size);
                return (
                  <tr key={s.size}>
                    <td className="qty">{s.size}</td>
                    <td className="qty">{s.SHOP}</td>
                    <td className="qty">{s.GODOWN}</td>
                    <td className="qty font-semibold" style={s.total < 0 ? { color: 'var(--bad)' } : undefined}>{s.total}</td>
                    <td className="qty">{sz?.mrp ? inr(sz.mrp) : '—'}</td>
                  </tr>
                );
              })}
              {d.stock.length === 0 && <tr><td colSpan={5}><Empty>No sizes or stock recorded yet.</Empty></td></tr>}
            </tbody>
          </table>
          <ActionForm action={addItemSizeAction} resetOnSuccess className="flex gap-2 items-end mt-3">
            <input type="hidden" name="itemId" value={d.item.id} />
            <div>
              <label className="lbl">Add a size</label>
              <input name="size" className="input !w-28" placeholder="12/14" />
            </div>
            <button className="btn btn-secondary" type="submit">Add</button>
          </ActionForm>
        </section>

        <section className="card card-pad">
          <div className="section-title">On order from suppliers</div>
          {d.onOrder.length === 0 ? <Empty>Nothing outstanding on any purchase order.</Empty> : (
            <table className="tbl">
              <thead><tr><th>Order</th><th>Supplier</th><th>Size</th><th className="num">Awaited</th><th>Expected</th></tr></thead>
              <tbody>
                {d.onOrder.map((o, i) => (
                  <tr key={i}>
                    <td><Link className="link" href="/orders">{o.po_no}</Link></td>
                    <td className="text-sm">{o.supplier}</td>
                    <td className="qty">{o.size}</td>
                    <td className="qty">{o.qty}</td>
                    <td className="text-sm">{fmtDate(o.expected_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="section-title mt-5">How suppliers write it</div>
          {d.aliases.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
              No supplier wordings learned yet. When a paper line is mapped to this item with “remember this wording”, it appears here.
            </p>
          ) : (
            <ul className="space-y-1">
              {d.aliases.map((a, i) => (
                <li key={i} className="text-sm">
                  “{a.supplier_description}” <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>— {a.supplier} · {a.status === 'USER_CONFIRMED' ? 'confirmed' : 'suggested'}</span>
                </li>
              ))}
            </ul>
          )}

          {d.findings.length > 0 && (
            <>
              <div className="section-title mt-5">Open findings on this item</div>
              <ul className="space-y-1.5">
                {d.findings.map((f) => (
                  <li key={f.id} className="flex gap-2 items-start text-sm">
                    <Stamp level={f.severity} /><span>{f.title} <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>({fmtDate(f.created_at)})</span></span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="card card-pad">
        <div className="section-title">Papers mentioning this item</div>
        {d.documents.length === 0 ? <Empty>No documents yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Ref</th><th>Type</th><th>Date</th><th className="num">Qty</th><th>Status</th></tr></thead>
              <tbody>
                {d.documents.map((doc) => (
                  <tr key={doc.id}>
                    <td><DocLink id={doc.id} refNo={doc.ref_no} /></td>
                    <td>{DOC_TYPE_LABEL[doc.doc_type] ?? doc.doc_type}</td>
                    <td>{fmtDate(doc.document_date)}</td>
                    <td className="qty">{doc.qty}</td>
                    <td><StatusChip status={doc.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad">
        <div className="section-title">Movement register for this item</div>
        {d.movements.length === 0 ? <Empty>No movements yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Date</th><th>What</th><th>Size</th><th>Where</th><th className="num">Qty</th><th>Note</th></tr></thead>
              <tbody>
                {d.movements.map((m) => (
                  <tr key={m.id} style={m.movement_type === 'REVERSAL' ? { opacity: 0.65 } : undefined}>
                    <td className="text-xs whitespace-nowrap" style={{ color: 'var(--ink-soft)' }}>{fmtDate(m.business_date)}<br />{fmtDateTime(m.created_at)}</td>
                    <td className="text-sm">{MOVE_LABEL[m.movement_type] ?? m.movement_type}</td>
                    <td className="qty">{m.size}</td>
                    <td>{m.location}</td>
                    <td className="qty" style={m.qty < 0 ? { color: 'var(--bad)' } : { color: 'var(--good)' }}>{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
                    <td className="text-xs" style={{ color: 'var(--ink-soft)' }}>{m.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
