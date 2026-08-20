'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function useUpload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(url: string, body: FormData): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(url, { method: 'POST', body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(String(json.error ?? `Upload failed (${res.status})`)); return null; }
      return json as Record<string, unknown>;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed'); return null;
    } finally { setBusy(false); }
  }
  return { busy, error, send, setError };
}

/* ── POS wizard ──────────────────────────────────────────────────────────── */

interface PreviewRow {
  rowNo: number; saleDate: string | null; receiptNo: string | null; posCode: string | null;
  itemName: string | null; size: string | null; quantity: number | null; isReturn: boolean;
  netAmount: number | null; problem: string | null; duplicate: boolean;
}
interface Preview {
  importId: string; filename: string; headers: string[]; totalRows: number; okRows: number;
  errorRows: number; duplicateRows: number; rows: PreviewRow[]; alreadyImportedFile: boolean;
  usedMap: Record<string, string | undefined>;
}

const MAP_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'posCode', label: 'POS item code' },
  { key: 'itemCode', label: 'Ideal item code' },
  { key: 'size', label: 'Size' },
  { key: 'date', label: 'Sale date' },
  { key: 'receiptNo', label: 'Receipt / bill no.' },
  { key: 'type', label: 'Sale / return marker' },
  { key: 'netAmount', label: 'Net amount' },
];

export function PosImportWizard() {
  const router = useRouter();
  const { busy, error, send, setError } = useUpload();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [committed, setCommitted] = useState<{ posted: number; blocked: number; skippedDuplicates: number; errors: number } | null>(null);

  async function doPreview(useMap?: Record<string, string>) {
    const f = fileRef.current?.files?.[0];
    if (!f) { setError('Choose the POS file first.'); return; }
    const fd = new FormData();
    fd.set('file', f);
    if (useMap) fd.set('map', JSON.stringify(useMap));
    const json = await send('/api/imports/pos/preview', fd);
    if (json) {
      const p = json as unknown as Preview;
      setPreview(p); setCommitted(null);
      setMap(Object.fromEntries(Object.entries(p.usedMap).filter(([, v]) => v)) as Record<string, string>);
    }
  }

  async function doCommit() {
    if (!preview) return;
    const fd = new FormData();
    fd.set('importId', preview.importId);
    const json = await send('/api/imports/pos/commit', fd);
    if (json) { setCommitted(json as never); router.refresh(); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".csv,.tsv,.xls,.xlsx" className="input !w-auto"
               onChange={() => { setPreview(null); setCommitted(null); }} />
        <button className="btn btn-primary" disabled={busy} onClick={() => doPreview()}>
          {busy ? 'Reading…' : 'Preview'}
        </button>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}

      {preview?.alreadyImportedFile && (
        <p className="text-sm" style={{ color: 'var(--warn)' }}>
          This exact file was already imported and posted — importing it again would double-count, so nothing was done.
        </p>
      )}

      {preview && !preview.alreadyImportedFile && (
        <div className="space-y-3">
          <div>
            <div className="section-title">Which column is which?</div>
            <div className="grid sm:grid-cols-4 gap-2">
              {MAP_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="lbl">{f.label}{f.required ? ' *' : ''}</label>
                  <select className="input" value={map[f.key] ?? ''}
                          onChange={(e) => setMap((m) => ({ ...m, [f.key]: e.target.value }))}>
                    <option value="">—</option>
                    {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary mt-2" disabled={busy}
                    onClick={() => doPreview(Object.fromEntries(Object.entries(map).filter(([, v]) => v)))}>
              Re-check with these columns
            </button>
          </div>

          <p className="text-sm">
            <span className="qty">{preview.totalRows}</span> rows —{' '}
            <span style={{ color: 'var(--good)' }}><span className="qty">{preview.okRows}</span> ready</span>,{' '}
            <span style={{ color: 'var(--ink-soft)' }}><span className="qty">{preview.duplicateRows}</span> already imported earlier (will be skipped)</span>,{' '}
            <span style={{ color: preview.errorRows ? 'var(--warn)' : 'var(--ink-soft)' }}><span className="qty">{preview.errorRows}</span> with problems</span>.
          </p>

          <div className="overflow-x-auto" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>#</th><th>Date</th><th>Receipt</th><th>Code</th><th>Item</th><th>Size</th><th className="num">Qty</th><th>Note</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 40).map((r) => (
                  <tr key={r.rowNo} style={r.problem ? { background: '#fbf6ea' } : r.duplicate ? { opacity: 0.55 } : undefined}>
                    <td className="qty">{r.rowNo}</td>
                    <td className="text-xs">{r.saleDate ?? '—'}</td>
                    <td className="text-xs">{r.receiptNo ?? '—'}</td>
                    <td className="qty text-xs">{r.posCode ?? '—'}</td>
                    <td className="text-sm">{r.itemName ?? <span style={{ color: 'var(--warn)' }}>not matched</span>}</td>
                    <td className="qty">{r.size ?? '—'}</td>
                    <td className="qty">{r.quantity != null ? (r.isReturn ? `+${r.quantity} (return)` : `−${r.quantity}`) : '—'}</td>
                    <td className="text-xs" style={{ color: r.problem ? 'var(--warn)' : 'var(--ink-soft)' }}>
                      {r.problem ?? (r.duplicate ? 'duplicate — skipped' : 'ok')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 40 && (
            <p className="text-xs" style={{ color: 'var(--ink-soft)' }}>Showing the first 40 rows; the full file is checked.</p>
          )}

          {!committed ? (
            <button className="btn btn-primary" disabled={busy || preview.okRows === 0} onClick={doCommit}>
              {busy ? 'Posting…' : `Post ${preview.okRows} sale(s) to stock`}
            </button>
          ) : (
            <p className="text-sm" style={{ color: 'var(--good)' }}>
              Posted {committed.posted} row(s). Skipped {committed.skippedDuplicates} duplicate(s)
              {committed.blocked > 0 && <>, {committed.blocked} blocked</>}
              {committed.errors > 0 && <>, {committed.errors} with problems (left unposted)</>}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── One-shot imports (products / opening stock) ─────────────────────────── */

export function SimpleImport({ endpoint, label, withDateAndLocation }: {
  endpoint: string; label: string; withDateAndLocation?: boolean;
}) {
  const router = useRouter();
  const { busy, error, send, setError } = useUpload();
  const fileRef = useRef<HTMLInputElement>(null);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [loc, setLoc] = useState<'SHOP' | 'GODOWN'>('SHOP');
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    const f = fileRef.current?.files?.[0];
    if (!f) { setError('Choose a file first.'); return; }
    const fd = new FormData();
    fd.set('file', f);
    if (withDateAndLocation) { fd.set('asOfDate', asOf); fd.set('location', loc); }
    const json = await send(endpoint, fd);
    if (json) { setResult(String(json.summary ?? 'Done.')); router.refresh(); }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".csv,.tsv,.xls,.xlsx" className="input !w-auto"
               onChange={() => setResult(null)} />
        {withDateAndLocation && (
          <>
            <input type="date" className="input !w-40" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            <select className="input !w-32" value={loc} onChange={(e) => setLoc(e.target.value as 'SHOP' | 'GODOWN')}>
              <option value="SHOP">Shop</option>
              <option value="GODOWN">Godown</option>
            </select>
          </>
        )}
        <button className="btn btn-primary" disabled={busy} onClick={run}>{busy ? 'Working…' : label}</button>
      </div>
      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      {result && <p className="text-sm" style={{ color: 'var(--good)' }}>{result}</p>}
    </div>
  );
}
