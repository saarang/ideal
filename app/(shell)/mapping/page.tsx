import Link from 'next/link';
import { q } from '@/src/lib/db';
import { mapLineAction, markLineNotStockAction } from '@/app/actions';
import { ActionForm } from '@/app/ui';
import { DocLink, Empty, fmtDate } from '../../format';

export const dynamic = 'force-dynamic';

interface UnmappedLine {
  id: string; raw_description: string | null; normalized_description: string | null;
  size_normalized: string | null; quantity: number | null;
  mapping_status: string; suggested_item_id: string | null; suggested_item_name: string | null;
  mapping_conf: string | null;
  document_id: string; ref_no: string; document_date: string | null;
  supplier: string | null; supplier_id: string | null;
  same_wording: number;
}

export default async function MappingPage() {
  const [lines, items, learned] = await Promise.all([
    q<UnmappedLine>(
      `SELECT dl.id, dl.raw_description, dl.normalized_description, dl.size_normalized, dl.quantity,
              dl.mapping_status, dl.item_id AS suggested_item_id, i.name AS suggested_item_name,
              dl.conf->>'mapping' AS mapping_conf,
              d.id AS document_id, d.ref_no, d.document_date, s.name AS supplier, d.supplier_id,
              (SELECT count(*) FROM document_lines dl2 JOIN documents d2 ON d2.id=dl2.document_id
                WHERE d2.supplier_id = d.supplier_id
                  AND lower(COALESCE(dl2.normalized_description, dl2.raw_description)) = lower(COALESCE(dl.normalized_description, dl.raw_description))
                  AND dl2.mapping_status IN ('UNMAPPED','AI_SUGGESTED'))::int AS same_wording
       FROM document_lines dl
       JOIN documents d ON d.id = dl.document_id
       LEFT JOIN items i ON i.id = dl.item_id
       LEFT JOIN suppliers s ON s.id = d.supplier_id
       WHERE dl.mapping_status IN ('UNMAPPED','AI_SUGGESTED')
         AND COALESCE(dl.quantity, 0) > 0
         AND d.status NOT IN ('DUPLICATE','ARCHIVED','POSTED')
       ORDER BY s.name NULLS LAST, lower(COALESCE(dl.normalized_description, dl.raw_description)), d.uploaded_at
       LIMIT 150`),
    q<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM items WHERE is_active ORDER BY code LIMIT 2000`),
    q<{ supplier: string; supplier_description: string; item: string; status: string }>(
      `SELECT s.name AS supplier, a.supplier_description, i.name AS item, a.status
       FROM supplier_item_aliases a
       JOIN suppliers s ON s.id = a.supplier_id
       JOIN items i ON i.id = a.item_id
       ORDER BY a.created_at DESC LIMIT 30`),
  ]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl">Mapping workbench</h1>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--ink-soft)' }}>
          Suppliers write item names their own way — “N.BLUE H.P.T.C. BHARI” is Sanjay’s wording for Navy Blue Half Pant T.C.
          Map a wording once with “remember” ticked and every future paper from that supplier maps itself.
        </p>
      </header>

      {lines.length === 0 && (
        <div className="card card-pad"><Empty>Every stock line on every paper is mapped. Nothing to teach.</Empty></div>
      )}

      <div className="space-y-3">
        {lines.map((l) => {
          const wording = l.normalized_description || l.raw_description || '(no description read)';
          return (
            <div key={l.id} className="card card-pad">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <strong className="text-sm">“{wording}”</strong>
                  <span className="text-xs ml-2" style={{ color: 'var(--ink-soft)' }}>
                    {l.supplier ?? 'Unknown supplier'} · paper <DocLink id={l.document_id} refNo={l.ref_no} />
                    {l.document_date && <> · {fmtDate(l.document_date)}</>}
                    {l.size_normalized && <> · size {l.size_normalized}</>}
                    {l.quantity != null && <> · {l.quantity} pcs</>}
                  </span>
                </div>
                {l.same_wording > 1 && (
                  <span className="chip">{l.same_wording} lines share this wording</span>
                )}
              </div>

              {l.mapping_status === 'AI_SUGGESTED' && l.suggested_item_name && (
                <p className="text-xs mt-1" style={{ color: 'var(--khaki)' }}>
                  Suggestion: {l.suggested_item_name}
                  {l.mapping_conf && <> ({Math.round(Number(l.mapping_conf) * 100)}% sure)</>} — confirm below or pick another item.
                </p>
              )}

              <ActionForm action={mapLineAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="lineId" value={l.id} />
                <select name="itemId" className="input !w-80" required defaultValue={l.suggested_item_id ?? ''}>
                  <option value="" disabled>Which stock item is this…</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}
                </select>
                <label className="text-sm flex items-center gap-1.5">
                  <input type="checkbox" name="saveAlias" defaultChecked /> remember this wording for {l.supplier ?? 'this supplier'}
                </label>
                <button className="btn btn-primary" type="submit">Map</button>
              </ActionForm>
              <ActionForm action={markLineNotStockAction} className="mt-1.5 inline">
                <input type="hidden" name="lineId" value={l.id} />
                <button className="btn btn-secondary" type="submit">Not a stock line (freight, note, total…)</button>
              </ActionForm>
            </div>
          );
        })}
      </div>

      {learned.length > 0 && (
        <section className="card card-pad">
          <div className="section-title">Recently learned wordings</div>
          <table className="tbl">
            <thead><tr><th>Supplier</th><th>They write</th><th>It means</th><th></th></tr></thead>
            <tbody>
              {learned.map((a, i) => (
                <tr key={i}>
                  <td className="text-sm">{a.supplier}</td>
                  <td className="text-sm">“{a.supplier_description}”</td>
                  <td className="text-sm">{a.item}</td>
                  <td><span className="chip">{a.status === 'USER_CONFIRMED' ? 'confirmed' : 'suggested'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
