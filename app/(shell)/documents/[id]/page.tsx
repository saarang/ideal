import Link from 'next/link';
import { notFound } from 'next/navigation';
import { q, q1 } from '@/src/lib/db';
import { refreshDocumentStatus } from '@/src/lib/pipeline/status';
import { DOC_TYPE_LABEL, DocLink, Empty, Stamp, StatusChip, fmtDate, fmtDateTime, inr } from '../../../format';
import { ActionButton, ActionForm, Reveal } from '../../../ui';
import {
  confirmDocTypeAction, confirmSuggestionsAction, mapLineAction, markDuplicateAction,
  markLineNotStockAction, notDuplicateAction, postDocumentAction, reprocessAction,
  updateHeaderAction, updateLineAction,
} from '../../../actions';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await q1<any>(
    `SELECT d.*, s.name AS supplier_name, c.name AS customer_name,
            dup.ref_no AS duplicate_of_ref
     FROM documents d
     LEFT JOIN suppliers s ON s.id = d.supplier_id
     LEFT JOIN customers c ON c.id = d.customer_id
     LEFT JOIN documents dup ON dup.id = d.duplicate_of_id
     WHERE d.id = $1`, [id]);
  if (!doc) notFound();

  const [pages, lines, findings, tasks, runs, items, suppliers, customers, statusInfo, groupDocs] = await Promise.all([
    q<{ id: string; page_no: number; processed_path: string | null; original_path: string }>(
      `SELECT id, page_no, processed_path, original_path FROM document_pages WHERE document_id=$1 ORDER BY page_no`, [id]),
    q<any>(
      `SELECT dl.*, i.name AS item_name, i.code AS item_code
       FROM document_lines dl LEFT JOIN items i ON i.id = dl.item_id
       WHERE dl.document_id=$1 ORDER BY dl.line_no, dl.sub_no`, [id]),
    q<any>(`SELECT * FROM findings WHERE document_id=$1 ORDER BY created_at DESC`, [id]),
    q<any>(`SELECT * FROM workflow_tasks WHERE document_id=$1 AND status IN ('OPEN','IN_PROGRESS') ORDER BY created_at`, [id]),
    q<any>(`SELECT stage, status, attempt, started_at, finished_at, error FROM document_processing_runs
            WHERE document_id=$1 ORDER BY started_at DESC LIMIT 12`, [id]),
    q<{ id: string; name: string; code: string }>(`SELECT id, name, code FROM items WHERE is_active ORDER BY name`),
    q<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE is_active ORDER BY name`),
    q<{ id: string; name: string }>(`SELECT id, name FROM customers WHERE is_active ORDER BY name`),
    refreshDocumentStatus(id).catch(() => ({ status: doc.status, blockers: [] as string[] })),
    q<{ id: string; ref_no: string; doc_type: string; role: string }>(
      `SELECT d2.id, d2.ref_no, d2.doc_type, rcd2.role
       FROM reconciliation_case_documents rcd
       JOIN reconciliation_case_documents rcd2 ON rcd2.case_id = rcd.case_id AND rcd2.document_id <> rcd.document_id
       JOIN documents d2 ON d2.id = rcd2.document_id
       WHERE rcd.document_id = $1`, [id]),
  ]);

  const isStockDoc = ['SUPPLIER_DELIVERY_CHALLAN','SUPPLIER_INVOICE','INWARD_BOOK','IDEAL_CUSTOMER_DELIVERY_CHALLAN','SHOP_TO_GODOWN_TRANSFER','GODOWN_TO_SHOP_TRANSFER'].includes(doc.doc_type);
  const suggested = lines.filter((l: any) => l.mapping_status === 'AI_SUGGESTED').length;
  const partyIsSupplier = ['SUPPLIER_DELIVERY_CHALLAN','SUPPLIER_INVOICE','INWARD_BOOK','ORDER_BOOK'].includes(doc.doc_type);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl qty">{doc.ref_no}</h1>
            <StatusChip status={statusInfo.status} />
            {doc.is_demo && <span className="chip">demo</span>}
          </div>
          <p className="text-sm mt-1" style={{ color: 'var(--ink-soft)' }}>
            {DOC_TYPE_LABEL[doc.doc_type] ?? doc.doc_type}
            {doc.supplier_name ? ` · from ${doc.supplier_name}` : doc.customer_name ? ` · to ${doc.customer_name}` : ''}
            {' · '}received {fmtDateTime(doc.uploaded_at)}
            {doc.telegram_uploader ? ` by ${doc.telegram_uploader} (Telegram)` : doc.source === 'SEED' ? ' (demo seed)' : ''}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {statusInfo.status === 'READY_TO_POST' && (
            <ActionButton action={postDocumentAction} values={{ documentId: id }} className="btn btn-primary"
              confirm="Post this document to stock? Movements are permanent (mistakes are fixed with reversals).">
              Post to stock
            </ActionButton>
          )}
          <ActionButton action={reprocessAction} values={{ documentId: id, from: 'EXTRACT' }} className="btn btn-secondary">
            Re-read photo
          </ActionButton>
        </div>
      </header>

      {statusInfo.status === 'NEEDS_REVIEW' && statusInfo.blockers.length > 0 && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--warn)' }}>
          <div className="font-medium mb-1">Before this can post:</div>
          <ul className="text-sm list-disc pl-5 space-y-0.5">
            {statusInfo.blockers.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}
      {statusInfo.status === 'DUPLICATE' && (
        <div className="card card-pad flex items-center justify-between gap-3" style={{ borderLeft: '4px solid var(--rule-strong)' }}>
          <span className="text-sm">Marked duplicate{doc.duplicate_of_ref ? <> of <span className="qty">{doc.duplicate_of_ref}</span></> : ''} — nothing here will post.</span>
          <ActionButton action={notDuplicateAction} values={{ documentId: id }}>This is not a duplicate</ActionButton>
        </div>
      )}
      {statusInfo.status === 'LINKED_NO_POSTING' && (
        <div className="card card-pad text-sm" style={{ borderLeft: '4px solid var(--info)' }}>
          This paper describes goods that were already added to stock via a linked document
          {groupDocs.length > 0 && <> ({groupDocs.map((g, i) => <span key={g.id}>{i > 0 && ', '}<DocLink id={g.id} refNo={g.ref_no} /></span>)})</>}.
          It is kept for the record; nothing posted twice.
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* ── The photo ── */}
        <section className="card card-pad space-y-3">
          <div className="section-title">Photo{pages.length > 1 ? `s (${pages.length})` : ''}</div>
          {pages.map((p) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={p.id} src={`/api/files/${encodeURIComponent(p.processed_path ?? p.original_path)}`}
                 alt={`Page ${p.page_no} of ${doc.ref_no}`}
                 className="w-full rounded border" style={{ borderColor: 'var(--rule)' }} />
          ))}
          {pages.length === 0 && <Empty>No image stored for this document.</Empty>}
          {doc.raw_text && (
            <Reveal label="What the reader saw (raw text)">
              <pre className="text-xs whitespace-pre-wrap p-3 rounded" style={{ background: 'var(--khaki-soft)' }}>{doc.raw_text}</pre>
            </Reveal>
          )}
        </section>

        {/* ── Header ── */}
        <section className="card card-pad space-y-4">
          <div className="section-title">Details</div>

          {(doc.doc_type === 'UNKNOWN' || (doc.classification_confidence != null && Number(doc.classification_confidence) < 0.8 && doc.classification_source !== 'USER')) && (
            <div className="p-3 rounded" style={{ background: 'var(--khaki-soft)' }}>
              <div className="text-sm mb-2">
                The reader thinks this is <b>{DOC_TYPE_LABEL[doc.predicted_type ?? doc.doc_type] ?? 'unclear'}</b>
                {doc.classification_confidence != null && <> ({Math.round(Number(doc.classification_confidence) * 100)}% sure)</>}.
                {doc.classification_signals && <span className="block text-xs mt-1" style={{ color: 'var(--ink-soft)' }}>Why: {doc.classification_signals}</span>}
              </div>
              <ActionForm action={confirmDocTypeAction} className="flex gap-2">
                <input type="hidden" name="documentId" value={id} />
                <select name="docType" defaultValue={doc.predicted_type ?? doc.doc_type} className="input flex-1">
                  {Object.entries(DOC_TYPE_LABEL).filter(([k]) => k !== 'UNKNOWN' && k !== 'POS_SALES_FILE').map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <button className="btn btn-primary">Confirm type</button>
              </ActionForm>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <HeaderField id={id} label="Document number" field="document_number" value={doc.document_number} />
            <HeaderField id={id} label="Document date" field="document_date" value={doc.document_date?.slice?.(0, 10) ?? doc.document_date} type="date"
                         hint={doc.document_date_raw ? `written: ${doc.document_date_raw}` : undefined} />
            {partyIsSupplier ? (
              <PartyField id={id} label="Supplier" field="supplier_id" value={doc.supplier_id} options={suppliers}
                          hint={doc.supplier_name_raw ? `written: ${doc.supplier_name_raw}${doc.supplier_confidence != null ? ` (${Math.round(doc.supplier_confidence * 100)}%)` : ''}` : undefined} />
            ) : doc.doc_type === 'IDEAL_CUSTOMER_DELIVERY_CHALLAN' ? (
              <PartyField id={id} label="Customer" field="customer_id" value={doc.customer_id} options={customers}
                          hint={doc.customer_name_raw ? `written: ${doc.customer_name_raw}` : undefined} />
            ) : <div />}
            <div>
              <dt className="lbl">Handwritten total</dt>
              <dd className="qty">{doc.handwritten_total_qty ?? '—'} pc</dd>
            </div>
            <div>
              <dt className="lbl">Calculated from lines</dt>
              <dd className="qty">{doc.calculated_total_qty ?? '—'} pc</dd>
            </div>
            {doc.grand_total != null && (
              <div>
                <dt className="lbl">Bill total</dt>
                <dd className="qty">{inr(doc.grand_total)}</dd>
              </div>
            )}
            {doc.overall_confidence != null && (
              <div>
                <dt className="lbl">Read confidence</dt>
                <dd className="qty">{Math.round(Number(doc.overall_confidence) * 100)}%</dd>
              </div>
            )}
          </dl>

          {doc.notes && <p className="text-xs p-2 rounded" style={{ background: 'var(--khaki-soft)' }}>Notes from the page: {doc.notes}</p>}

          {groupDocs.length > 0 && statusInfo.status !== 'LINKED_NO_POSTING' && (
            <p className="text-sm">
              Linked papers for the same delivery:{' '}
              {groupDocs.map((g, i) => <span key={g.id}>{i > 0 && ', '}<DocLink id={g.id} refNo={g.ref_no} /> <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>({g.role.toLowerCase()})</span></span>)}
            </p>
          )}

          <Reveal label="More actions">
            <div className="flex flex-wrap gap-2 items-center">
              <ActionForm action={markDuplicateAction} className="flex gap-2 items-center"
                          confirm="Mark this whole document as a duplicate? Its tasks and findings will be closed.">
                <input type="hidden" name="documentId" value={id} />
                <input name="ofRef" placeholder="Duplicate of (e.g. DOC-000012)" className="input w-56" />
                <button className="btn btn-danger">Mark duplicate</button>
              </ActionForm>
              <ActionButton action={reprocessAction} values={{ documentId: id, from: 'PREPARE' }}>
                Full re-process (from photo)
              </ActionButton>
            </div>
          </Reveal>
        </section>
      </div>

      {/* ── Lines ── */}
      {isStockDoc || doc.doc_type === 'ORDER_BOOK' ? (
        <section className="card">
          <div className="card-pad pb-0 flex flex-wrap items-center justify-between gap-2">
            <div className="section-title mb-0">Lines as read from the page</div>
            {suggested > 0 && statusInfo.status !== 'POSTED' && (
              <ActionButton action={confirmSuggestionsAction} values={{ documentId: id }} className="btn btn-primary">
                Accept {suggested} suggested item match{suggested > 1 ? 'es' : ''}
              </ActionButton>
            )}
          </div>
          <div className="overflow-x-auto p-2">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>Written on page</th><th>Item in register</th><th>Size</th><th className="num">Qty</th><th className="num">Rate</th><th></th></tr>
              </thead>
              <tbody>
                {lines.map((l: any) => <LineRow key={l.id} l={l} items={items} posted={statusInfo.status === 'POSTED'} />)}
                {lines.length === 0 && <tr><td colSpan={7}><Empty>No lines were read from this page.</Empty></td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── Findings & tasks for this document ── */}
      {(findings.length > 0 || tasks.length > 0) && (
        <section className="card card-pad">
          <div className="section-title">Checks on this document</div>
          <ul className="space-y-2 text-sm">
            {findings.map((f: any) => (
              <li key={f.id} className="flex gap-2 items-start">
                <Stamp level={f.severity} />
                <div className="flex-1">
                  <span className={f.status !== 'OPEN' ? 'line-through opacity-60' : ''}>{f.title}</span>
                  {f.explanation && f.status === 'OPEN' && <div className="text-xs mt-0.5" style={{ color: 'var(--ink-soft)' }}>{f.explanation}</div>}
                </div>
              </li>
            ))}
          </ul>
          {(findings.some((f: any) => f.status === 'OPEN')) && (
            <Link href="/findings" className="link text-sm inline-block mt-3">Resolve on the findings page →</Link>
          )}
        </section>
      )}

      {/* ── Processing history ── */}
      <Reveal label="Processing history" className="text-sm">
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Stage</th><th>Result</th><th>When</th><th>Detail</th></tr></thead>
            <tbody>
              {runs.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.stage}</td>
                  <td><span className={`chip chip-${r.status === 'SUCCEEDED' ? 'POSTED' : r.status === 'FAILED' ? 'FAILED' : 'PROCESSING'}`}>{r.status.toLowerCase()}</span></td>
                  <td className="text-xs">{fmtDateTime(r.started_at)}</td>
                  <td className="text-xs" style={{ color: 'var(--bad)' }}>{r.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </div>
  );
}

function HeaderField({ id, label, field, value, type = 'text', hint }: {
  id: string; label: string; field: string; value: string | null; type?: string; hint?: string;
}) {
  return (
    <div>
      <dt className="lbl">{label}</dt>
      <dd>
        <ActionForm action={updateHeaderAction} className="flex gap-1.5">
          <input type="hidden" name="documentId" value={id} />
          <input type="hidden" name="field" value={field} />
          <input name="value" type={type} defaultValue={value ?? ''} className="input" />
          <button className="btn btn-secondary" title="Save">✓</button>
        </ActionForm>
        {hint && <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>{hint}</div>}
      </dd>
    </div>
  );
}

function PartyField({ id, label, field, value, options, hint }: {
  id: string; label: string; field: string; value: string | null;
  options: { id: string; name: string }[]; hint?: string;
}) {
  return (
    <div>
      <dt className="lbl">{label}</dt>
      <dd>
        <ActionForm action={updateHeaderAction} className="flex gap-1.5">
          <input type="hidden" name="documentId" value={id} />
          <input type="hidden" name="field" value={field} />
          <select name="value" defaultValue={value ?? ''} className="input">
            <option value="">— not set —</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className="btn btn-secondary" title="Save">✓</button>
        </ActionForm>
        {hint && <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>{hint}</div>}
      </dd>
    </div>
  );
}

function LineRow({ l, items, posted }: { l: any; items: { id: string; name: string; code: string }[]; posted: boolean }) {
  const needsReview = l.review_status === 'NEEDS_REVIEW';
  const conf = l.conf ?? {};
  return (
    <tr style={needsReview ? { background: '#fbf6ea' } : undefined}>
      <td className="qty text-xs">{l.line_no}.{l.sub_no}</td>
      <td>
        <div>{l.raw_description ?? <span style={{ color: 'var(--ink-soft)' }}>{l.raw_text ?? '—'}</span>}</div>
        {l.notes && <div className="text-xs mt-0.5" style={{ color: 'var(--warn)' }}>{l.notes}</div>}
        {conf.description != null && Number(conf.description) < 0.6 && (
          <div className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>hard to read ({Math.round(conf.description * 100)}%)</div>
        )}
      </td>
      <td>
        {posted ? (
          <span>{l.item_name ?? '—'}</span>
        ) : l.mapping_status === 'USER_CONFIRMED' && l.item_name ? (
          <span>{l.item_name} <span className="stamp stamp-OK">✓</span></span>
        ) : l.mapping_status === 'NOT_REQUIRED' ? (
          <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>not a stock line</span>
        ) : (
          <ActionForm action={mapLineAction} className="space-y-1">
            <input type="hidden" name="lineId" value={l.id} />
            <div className="flex gap-1.5">
              <select name="itemId" defaultValue={l.item_id ?? ''} className="input min-w-40">
                <option value="">{l.mapping_status === 'AI_SUGGESTED' ? 'suggestion below…' : 'choose item…'}</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              <button className="btn btn-secondary">Map</button>
            </div>
            {l.mapping_status === 'AI_SUGGESTED' && l.item_name && (
              <div className="text-xs" style={{ color: 'var(--info)' }}>suggested: {l.item_name}</div>
            )}
            <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--ink-soft)' }}>
              <input type="checkbox" name="saveAlias" defaultChecked /> remember this wording for this supplier
            </label>
          </ActionForm>
        )}
      </td>
      <td>
        {posted ? <span className="qty">{l.size_normalized ?? '—'}</span> : (
          <ActionForm action={updateLineAction} className="flex gap-1">
            <input type="hidden" name="lineId" value={l.id} />
            <input name="size" defaultValue={l.size_normalized ?? ''} placeholder={l.size_raw ?? 'size'} className="input w-20 qty" />
            <button className="btn btn-secondary" title="Save size">✓</button>
          </ActionForm>
        )}
        {l.size_raw && l.size_raw !== l.size_normalized && (
          <div className="text-[11px]" style={{ color: 'var(--ink-soft)' }}>written: {l.size_raw}</div>
        )}
      </td>
      <td className="qty">
        {posted ? (l.quantity ?? '—') : (
          <ActionForm action={updateLineAction} className="flex gap-1 justify-end">
            <input type="hidden" name="lineId" value={l.id} />
            <input name="quantity" type="number" min={1} defaultValue={l.quantity ?? ''} className="input w-16 qty text-right" />
            <button className="btn btn-secondary" title="Save qty">✓</button>
          </ActionForm>
        )}
      </td>
      <td className="qty text-xs">{l.unit_rate ? inr(l.unit_rate) : '—'}</td>
      <td>
        {!posted && l.mapping_status !== 'NOT_REQUIRED' && (
          <ActionButton action={markLineNotStockAction} values={{ lineId: l.id }} className="btn btn-secondary text-xs"
                        confirm="Mark this line as not a stock line (totals, headings, cut cloth …)? It will be ignored for posting.">
            skip
          </ActionButton>
        )}
      </td>
    </tr>
  );
}
