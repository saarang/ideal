import { q } from '@/src/lib/db';
import { Empty, fmtDateTime } from '../../format';
import { PosImportWizard, SimpleImport } from './wizard';

export const dynamic = 'force-dynamic';

export default async function ImportsPage() {
  const past = await q<{
    id: string; filename: string; status: string; row_count: number; ok_count: number;
    error_count: number; created_at: string; posted_at: string | null; by_name: string | null;
  }>(
    `SELECT p.id, p.filename, p.status, p.row_count, p.ok_count, p.error_count,
            p.created_at, p.posted_at, u.name AS by_name
     FROM pos_imports p LEFT JOIN users u ON u.id = p.imported_by
     ORDER BY p.created_at DESC LIMIT 25`);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl">Imports</h1>
        <p className="text-sm max-w-2xl" style={{ color: 'var(--ink-soft)' }}>
          Bring in the POS sales file, the VasyERP product list, or a physical-count opening stock sheet.
          Every import is previewed first, and the same file or the same sale is never counted twice.
        </p>
      </header>

      <section className="card card-pad">
        <div className="section-title">POS sales (CSV / Excel from VasyERP)</div>
        <PosImportWizard />
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card card-pad">
          <div className="section-title">Product list (VasyERP export)</div>
          <p className="text-xs mb-2" style={{ color: 'var(--ink-soft)' }}>
            Creates items and sizes from the product export. Names like “NH TRACK PANT GREEN 28” become the item
            “NH TRACK PANT GREEN” with size 28; the 7-digit code is kept for POS matching.
          </p>
          <SimpleImport endpoint="/api/imports/items" label="Import products" />
        </section>

        <section className="card card-pad">
          <div className="section-title">Opening stock (physical count)</div>
          <p className="text-xs mb-2" style={{ color: 'var(--ink-soft)' }}>
            A sheet with the item code (or POS code), size and counted quantity. Posts one opening-balance
            line per row on the chosen date. Safe to re-run: rows already posted are skipped.
          </p>
          <SimpleImport endpoint="/api/imports/opening" label="Import opening stock" withDateAndLocation />
        </section>
      </div>

      <section className="card card-pad">
        <div className="section-title">Past POS imports</div>
        {past.length === 0 ? <Empty>No POS files imported yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>File</th><th className="num">Rows</th><th className="num">OK</th><th className="num">Problems</th><th>Status</th><th>When</th></tr></thead>
              <tbody>
                {past.map((p) => (
                  <tr key={p.id}>
                    <td className="text-sm">{p.filename}</td>
                    <td className="qty">{p.row_count}</td>
                    <td className="qty">{p.ok_count}</td>
                    <td className="qty" style={p.error_count > 0 ? { color: 'var(--warn)' } : undefined}>{p.error_count}</td>
                    <td><span className={`chip chip-${p.status === 'POSTED' ? 'POSTED' : 'PROCESSING'}`}>{p.status.toLowerCase()}</span></td>
                    <td className="text-xs" style={{ color: 'var(--ink-soft)' }}>
                      {fmtDateTime(p.created_at)}{p.by_name ? ` · ${p.by_name}` : ''}
                    </td>
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
