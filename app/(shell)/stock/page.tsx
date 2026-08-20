import Link from 'next/link';
import { q } from '@/src/lib/db';
import { requireUser } from '@/src/lib/auth';
import { createTransferAction, createAdjustmentAction, reverseMovementAction } from '@/app/actions';
import { ActionForm, Reveal } from '@/app/ui';
import { Empty, fmtDate, fmtDateTime } from '../../format';

export const dynamic = 'force-dynamic';

const MOVE_LABEL: Record<string, string> = {
  OPENING: 'Opening balance',
  SUPPLIER_RECEIPT: 'Received from supplier',
  CUSTOMER_ISSUE: 'Sent to customer',
  POS_SALE: 'POS sale',
  POS_RETURN: 'POS return',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
};

export default async function StockPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q: term = '' } = await searchParams;
  const like = `%${term.trim()}%`;

  const [matrix, items, moves] = await Promise.all([
    q<{ item_id: string; code: string; name: string; size: string; shop: number; godown: number; total: number }>(
      `SELECT i.id AS item_id, i.code, i.name, im.size,
              COALESCE(SUM(im.qty) FILTER (WHERE l.code='SHOP'),0)::int AS shop,
              COALESCE(SUM(im.qty) FILTER (WHERE l.code='GODOWN'),0)::int AS godown,
              SUM(im.qty)::int AS total
       FROM inventory_movements im
       JOIN items i ON i.id = im.item_id
       JOIN locations l ON l.id = im.location_id
       ${term.trim() ? `WHERE i.code ILIKE $1 OR i.name ILIKE $1` : ''}
       GROUP BY i.id, i.code, i.name, im.size
       ORDER BY i.code, NULLIF(regexp_replace(im.size, '\\D.*$', ''), '')::int NULLS LAST, im.size
       LIMIT 400`, term.trim() ? [like] : []),
    q<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM items WHERE is_active ORDER BY code LIMIT 2000`),
    q<{
      id: string; created_at: string; business_date: string; movement_type: string;
      code: string; name: string; size: string; location: string; qty: number;
      reason: string | null; reversal_of_id: string | null; reversed: boolean; created_by_name: string | null;
    }>(
      `SELECT im.id, im.created_at, im.business_date, im.movement_type, i.code, i.name, im.size,
              l.code AS location, im.qty, im.reason, im.reversal_of_id,
              EXISTS (SELECT 1 FROM inventory_movements r WHERE r.reversal_of_id = im.id) AS reversed,
              u.name AS created_by_name
       FROM inventory_movements im
       JOIN items i ON i.id = im.item_id
       JOIN locations l ON l.id = im.location_id
       LEFT JOIN users u ON u.id = im.created_by
       ORDER BY im.created_at DESC LIMIT 60`),
  ]);

  const isAdmin = user.role === 'ADMIN';

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Stock</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            Book stock per size at the shop and the godown, straight from the movement register.
          </p>
        </div>
        <form method="GET" className="flex gap-2 items-center">
          <input name="q" defaultValue={term} className="input !w-56" placeholder="Search item code or name…" />
          <button className="btn btn-secondary" type="submit">Search</button>
        </form>
      </header>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card card-pad">
          <div className="section-title">Move between shop and godown</div>
          <ActionForm action={createTransferAction} resetOnSuccess className="grid grid-cols-2 gap-2.5">
            <div className="col-span-2">
              <label className="lbl">Item</label>
              <select name="itemId" className="input" required defaultValue="">
                <option value="" disabled>Choose an item…</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}
              </select>
            </div>
            <div>
              <label className="lbl">Size (as printed, e.g. 28 or 12/14)</label>
              <input name="size" className="input" required placeholder="28" />
            </div>
            <div>
              <label className="lbl">Pieces</label>
              <input name="qty" type="number" min={1} className="input qty" required placeholder="0" />
            </div>
            <div>
              <label className="lbl">Direction</label>
              <select name="direction" className="input" defaultValue="G2S">
                <option value="G2S">Godown → Shop</option>
                <option value="S2G">Shop → Godown</option>
              </select>
            </div>
            <div>
              <label className="lbl">Date</label>
              <input name="date" type="date" className="input" defaultValue={new Date().toISOString().slice(0, 10)} />
            </div>
            <div className="col-span-2">
              <button className="btn btn-primary" type="submit">Record transfer</button>
            </div>
          </ActionForm>
        </section>

        <section className="card card-pad">
          <div className="section-title">Correction (adjustment)</div>
          {isAdmin ? (
            <ActionForm action={createAdjustmentAction} resetOnSuccess
                        confirm="An adjustment writes a permanent line in the register. Record it?"
                        className="grid grid-cols-2 gap-2.5">
              <div className="col-span-2">
                <label className="lbl">Item</label>
                <select name="itemId" className="input" required defaultValue="">
                  <option value="" disabled>Choose an item…</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}
                </select>
              </div>
              <div>
                <label className="lbl">Size</label>
                <input name="size" className="input" required placeholder="28" />
              </div>
              <div>
                <label className="lbl">Pieces (+ add / − reduce)</label>
                <input name="qty" type="number" className="input qty" required placeholder="-2" />
              </div>
              <div>
                <label className="lbl">Where</label>
                <select name="location" className="input" defaultValue="SHOP">
                  <option value="SHOP">Shop</option>
                  <option value="GODOWN">Godown</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="lbl">Reason (always written down)</label>
                <input name="reason" className="input" required placeholder="e.g. Physical count 14-08: two pieces damaged, discarded" />
              </div>
              <div className="col-span-2">
                <button className="btn btn-primary" type="submit">Record adjustment</button>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
              Only an admin can write stock corrections. Ask the owner to record it, or raise it as a note on the item.
            </p>
          )}
        </section>
      </div>

      <section className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr><th>Item</th><th>Size</th><th className="num">Shop</th><th className="num">Godown</th><th className="num">Total</th></tr>
          </thead>
          <tbody>
            {matrix.map((r) => (
              <tr key={`${r.item_id}:${r.size}`}>
                <td><Link className="link" href={`/items/${r.item_id}`}>{r.code}</Link> <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>{r.name}</span></td>
                <td className="qty">{r.size}</td>
                <td className="qty">{r.shop}</td>
                <td className="qty">{r.godown}</td>
                <td className="qty font-semibold" style={r.total < 0 ? { color: 'var(--bad)' } : undefined}>{r.total}</td>
              </tr>
            ))}
            {matrix.length === 0 && (
              <tr><td colSpan={5}><Empty>{term ? 'No stocked item matches that search.' : 'No stock on the books yet — post a document or import opening stock.'}</Empty></td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card card-pad">
        <div className="section-title">Movement register (latest 60)</div>
        <p className="text-xs mb-2" style={{ color: 'var(--ink-soft)' }}>
          The register is append-only: nothing is ever edited or deleted. A mistake is cancelled by a reversal line, and both stay visible.
        </p>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>When</th><th>What</th><th>Item</th><th>Size</th><th>Where</th><th className="num">Qty</th><th>Note</th>{isAdmin && <th></th>}</tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} style={m.movement_type === 'REVERSAL' || m.reversed ? { opacity: 0.65 } : undefined}>
                  <td className="text-xs whitespace-nowrap" style={{ color: 'var(--ink-soft)' }}>
                    {fmtDate(m.business_date)}<br />{fmtDateTime(m.created_at)}
                  </td>
                  <td className="text-sm">{MOVE_LABEL[m.movement_type] ?? m.movement_type}{m.reversed ? ' (reversed)' : ''}</td>
                  <td className="text-sm">{m.code}</td>
                  <td className="qty">{m.size}</td>
                  <td>{m.location}</td>
                  <td className="qty" style={m.qty < 0 ? { color: 'var(--bad)' } : { color: 'var(--good)' }}>{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
                  <td className="text-xs" style={{ color: 'var(--ink-soft)' }}>{m.reason ?? ''}{m.created_by_name ? ` · ${m.created_by_name}` : ''}</td>
                  {isAdmin && (
                    <td>
                      {!m.reversed && m.movement_type !== 'REVERSAL' && (
                        <Reveal label="Reverse">
                          <ActionForm action={reverseMovementAction}
                                      confirm="Write an opposite entry that cancels this line?"
                                      className="flex gap-2 items-center mt-1">
                            <input type="hidden" name="movementId" value={m.id} />
                            <input name="reason" className="input !w-48" required placeholder="Why (written down)" />
                            <button className="btn btn-danger" type="submit">Reverse</button>
                          </ActionForm>
                        </Reveal>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {moves.length === 0 && <tr><td colSpan={isAdmin ? 8 : 7}><Empty>No movements yet.</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
