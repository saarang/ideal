import Link from 'next/link';
import { q } from '@/src/lib/db';
import { createItemAction } from '@/app/actions';
import { ActionForm, Reveal } from '@/app/ui';
import { Empty } from '../../format';

export const dynamic = 'force-dynamic';

export default async function ItemsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: term = '' } = await searchParams;
  const like = `%${term.trim()}%`;

  const items = await q<{
    id: string; code: string; name: string; category: string | null; colour: string | null;
    is_active: boolean; sizes: number; stock: number; aliases: number;
  }>(
    `SELECT i.id, i.code, i.name, c.name AS category, i.colour, i.is_active,
            (SELECT count(*) FROM item_sizes s WHERE s.item_id=i.id)::int AS sizes,
            COALESCE((SELECT SUM(qty) FROM inventory_movements m WHERE m.item_id=i.id),0)::int AS stock,
            (SELECT count(*) FROM supplier_item_aliases a WHERE a.item_id=i.id)::int AS aliases
     FROM items i LEFT JOIN item_categories c ON c.id=i.category_id
     ${term.trim() ? `WHERE i.code ILIKE $1 OR i.name ILIKE $1` : ''}
     ORDER BY i.code LIMIT 300`, term.trim() ? [like] : []);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Items</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            The master list of what the shop stocks. Open an item for its full story — stock, orders, papers, supplier wordings.
          </p>
        </div>
        <form method="GET" className="flex gap-2 items-center">
          <input name="q" defaultValue={term} className="input !w-56" placeholder="Search code or name…" />
          <button className="btn btn-secondary" type="submit">Search</button>
        </form>
      </header>

      <Reveal label="Add a new item" className="card card-pad">
        <ActionForm action={createItemAction} resetOnSuccess className="grid sm:grid-cols-2 gap-2.5 mt-2">
          <div>
            <label className="lbl">Name (as the shop calls it)</label>
            <input name="name" className="input" required placeholder="Navy Blue Half Pant T.C." />
          </div>
          <div>
            <label className="lbl">Code (short, unique)</label>
            <input name="code" className="input" required placeholder="IU-NB-HPTC" />
          </div>
          <div>
            <label className="lbl">Category</label>
            <input name="category" className="input" placeholder="Shorts" />
          </div>
          <div>
            <label className="lbl">Sizes (comma-separated)</label>
            <input name="sizes" className="input" placeholder="12/14, 15, 16, 17" />
          </div>
          <div className="sm:col-span-2">
            <button className="btn btn-primary" type="submit">Create item</button>
          </div>
        </ActionForm>
      </Reveal>

      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Category</th><th className="num">Sizes</th><th className="num">Stock</th><th className="num">Supplier wordings</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} style={!i.is_active ? { opacity: 0.55 } : undefined}>
                <td className="qty"><Link className="link" href={`/items/${i.id}`}>{i.code}</Link></td>
                <td>{i.name}{!i.is_active && <span className="chip ml-2">inactive</span>}</td>
                <td className="text-sm" style={{ color: 'var(--ink-soft)' }}>{i.category ?? '—'}</td>
                <td className="qty">{i.sizes}</td>
                <td className="qty" style={i.stock < 0 ? { color: 'var(--bad)' } : undefined}>{i.stock}</td>
                <td className="qty">{i.aliases}</td>
                <td><Link className="btn btn-secondary" href={`/items/${i.id}`}>Open</Link></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={7}><Empty>{term ? 'No item matches.' : 'No items yet — add one above or import the VasyERP product list on the Imports page.'}</Empty></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
