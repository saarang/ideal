import { q } from '@/src/lib/db';
import { requireUser } from '@/src/lib/auth';
import { saveSettingAction, createUserAction, toggleUserAction, createPartyAction, purgeDemoAction } from '@/app/actions';
import { ActionForm, Reveal } from '@/app/ui';
import { Empty, fmtDateTime } from '../../format';

export const dynamic = 'force-dynamic';

interface SettingDef { key: string; label: string; help: string; kind: 'string' | 'number' | 'boolean' | 'json' }

const SETTING_DEFS: SettingDef[] = [
  { key: 'business_name', label: 'Business name', help: 'Shown in the header and on printed pages.', kind: 'string' },
  { key: 'overdue_delivery_days', label: 'Order overdue after (days)', help: 'An order with no expected date is flagged this many days after the order date.', kind: 'number' },
  { key: 'challan_invoice_wait_days', label: 'Challan → invoice wait (days)', help: 'A posted challan with no bill after this many days raises a reminder finding.', kind: 'number' },
  { key: 'recon_date_window_days', label: 'Reconciliation date window (days)', help: 'Papers from the same supplier within this many days are compared as one receipt group.', kind: 'number' },
  { key: 'rounding_tolerance_inr', label: 'Arithmetic tolerance (₹)', help: 'Differences up to this amount are treated as rounding, not an error.', kind: 'number' },
  { key: 'negative_stock_policy', label: 'Negative stock', help: 'BLOCK stops any posting that would take stock below zero. WARN_ALLOW posts it and raises a finding instead.', kind: 'string' },
  { key: 'default_receipt_location', label: 'Goods arrive at', help: 'SHOP or GODOWN — where supplier receipts are posted unless the paper says otherwise.', kind: 'string' },
  { key: 'auto_post_high_confidence', label: 'Auto-post confident documents', help: 'If on, a clean, fully-matched paper posts to stock without waiting for a person.', kind: 'boolean' },
  { key: 'conf_high', label: 'High-confidence threshold', help: '0–1. At or above this, a reading is treated as reliable.', kind: 'number' },
  { key: 'conf_medium', label: 'Medium-confidence threshold', help: '0–1. Below this, a line always goes to review.', kind: 'number' },
  { key: 'classification_confirm_below', label: 'Confirm document type below', help: '0–1. If the classifier is less sure than this, a person confirms the document type.', kind: 'number' },
  { key: 'known_composite_sizes', label: 'Composite sizes', help: 'JSON list of sizes that contain a slash and are one size, e.g. ["12/14","28/32"]. “28/5” stays size 28 × 5 pcs.', kind: 'json' },
  { key: 'plausible_size_min', label: 'Smallest plausible size', help: 'Numbers below this are not treated as garment sizes.', kind: 'number' },
  { key: 'plausible_size_max', label: 'Largest plausible size', help: 'Numbers above this are not treated as garment sizes.', kind: 'number' },
];

export default async function SettingsPage() {
  const user = await requireUser();
  const isAdmin = user.role === 'ADMIN';

  const [settingRows, users, suppliers, customers, demoCounts] = await Promise.all([
    q<{ key: string; value: unknown; updated_at: string | null }>(`SELECT key, value, updated_at FROM system_settings ORDER BY key`),
    q<{ id: string; email: string; name: string; role: string; is_active: boolean; last_seen_at: string | null }>(
      `SELECT u.id, u.email, u.name, u.role, u.is_active,
              (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
       FROM users u ORDER BY u.created_at`),
    q<{ id: string; code: string; name: string; gstin: string | null; is_demo: boolean }>(
      `SELECT id, code, name, gstin, is_demo FROM suppliers WHERE is_active ORDER BY name`),
    q<{ id: string; code: string; name: string; is_demo: boolean }>(
      `SELECT id, code, name, is_demo FROM customers WHERE is_active ORDER BY name`),
    q<{ what: string; n: number }>(
      `SELECT 'documents' AS what, count(*)::int AS n FROM documents WHERE is_demo
       UNION ALL SELECT 'items', count(*)::int FROM items WHERE is_demo
       UNION ALL SELECT 'suppliers', count(*)::int FROM suppliers WHERE is_demo`),
  ]);
  const current = new Map(settingRows.map((r) => [r.key, r.value]));
  const demoTotal = demoCounts.reduce((a, r) => a + r.n, 0);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl">Settings</h1>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          Business rules, people who can log in, and the supplier / customer lists.
        </p>
      </header>

      <section className="card card-pad">
        <div className="section-title">Business rules</div>
        {!isAdmin && <p className="text-sm mb-2" style={{ color: 'var(--ink-soft)' }}>Only an admin can change these; shown here for reference.</p>}
        <div className="space-y-3">
          {SETTING_DEFS.map((s) => {
            const v = current.get(s.key);
            const display = typeof v === 'string' ? v : JSON.stringify(v);
            return (
              <div key={s.key} className="flex flex-wrap items-start gap-3 border-b pb-3" style={{ borderColor: 'var(--rule)' }}>
                <div className="flex-1 min-w-64">
                  <strong className="text-sm">{s.label}</strong>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--ink-soft)' }}>{s.help}</p>
                </div>
                {isAdmin ? (
                  <ActionForm action={saveSettingAction} className="flex items-center gap-2">
                    <input type="hidden" name="key" value={s.key} />
                    <input type="hidden" name="kind" value={s.kind} />
                    {s.kind === 'boolean' ? (
                      <select name="value" className="input !w-28" defaultValue={String(v ?? false)}>
                        <option value="true">on</option>
                        <option value="false">off</option>
                      </select>
                    ) : (
                      <input name="value" className={`input ${s.kind === 'json' ? '!w-72 font-mono' : '!w-44'}`}
                             defaultValue={display ?? ''} />
                    )}
                    <button className="btn btn-secondary" type="submit">Save</button>
                  </ActionForm>
                ) : (
                  <span className="qty text-sm">{display ?? '—'}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="card card-pad">
          <div className="section-title">People who can log in</div>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last signed in</th>{isAdmin && <th></th>}</tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={!u.is_active ? { opacity: 0.5 } : undefined}>
                  <td className="text-sm">{u.name}</td>
                  <td className="text-sm">{u.email}</td>
                  <td><span className="chip">{u.role.toLowerCase()}</span></td>
                  <td className="text-xs" style={{ color: 'var(--ink-soft)' }}>{u.last_seen_at ? fmtDateTime(u.last_seen_at) : 'never'}</td>
                  {isAdmin && (
                    <td>
                      <ActionForm action={toggleUserAction} className="inline">
                        <input type="hidden" name="userId" value={u.id} />
                        <button className="btn btn-secondary" type="submit">{u.is_active ? 'Deactivate' : 'Reactivate'}</button>
                      </ActionForm>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && (
            <Reveal label="Add a login" className="mt-3">
              <ActionForm action={createUserAction} resetOnSuccess className="grid sm:grid-cols-2 gap-2.5 mt-2">
                <div><label className="lbl">Name</label><input name="name" className="input" placeholder="Asha" /></div>
                <div><label className="lbl">Email</label><input name="email" type="email" className="input" required /></div>
                <div><label className="lbl">Password (they can change it later)</label><input name="password" className="input" required minLength={6} /></div>
                <div>
                  <label className="lbl">Role</label>
                  <select name="role" className="input" defaultValue="STAFF">
                    <option value="STAFF">Staff — can work papers and stock</option>
                    <option value="VIEWER">Viewer — can only look</option>
                    <option value="ADMIN">Admin — everything, incl. corrections</option>
                  </select>
                </div>
                <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create login</button></div>
              </ActionForm>
            </Reveal>
          )}
        </section>

        <section className="card card-pad">
          <div className="section-title">Suppliers &amp; customers</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--ink-soft)' }}>SUPPLIERS ({suppliers.length})</p>
              <ul className="space-y-1 max-h-56 overflow-y-auto pr-1">
                {suppliers.map((s) => (
                  <li key={s.id} className="text-sm">{s.name} <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>{s.code}{s.gstin ? ` · ${s.gstin}` : ''}</span></li>
                ))}
                {suppliers.length === 0 && <li className="text-sm" style={{ color: 'var(--ink-soft)' }}>None yet.</li>}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--ink-soft)' }}>CUSTOMERS ({customers.length})</p>
              <ul className="space-y-1 max-h-56 overflow-y-auto pr-1">
                {customers.map((c) => (
                  <li key={c.id} className="text-sm">{c.name} <span className="text-xs" style={{ color: 'var(--ink-soft)' }}>{c.code}</span></li>
                ))}
                {customers.length === 0 && <li className="text-sm" style={{ color: 'var(--ink-soft)' }}>None yet.</li>}
              </ul>
            </div>
          </div>
          <Reveal label="Add a supplier or customer" className="mt-3">
            <ActionForm action={createPartyAction} resetOnSuccess className="grid sm:grid-cols-3 gap-2.5 mt-2">
              <div>
                <label className="lbl">Kind</label>
                <select name="kind" className="input" defaultValue="supplier">
                  <option value="supplier">Supplier</option>
                  <option value="customer">Customer (school / institution)</option>
                </select>
              </div>
              <div><label className="lbl">Name</label><input name="name" className="input" required placeholder="Sanjay Dresses" /></div>
              <div><label className="lbl">Short code (optional)</label><input name="code" className="input" placeholder="SANJAY" /></div>
              <div className="sm:col-span-3"><button className="btn btn-primary" type="submit">Add</button></div>
            </ActionForm>
          </Reveal>
        </section>
      </div>

      <section className="card card-pad">
        <div className="section-title">Telegram intake</div>
        <p className="text-sm max-w-2xl">
          The shop’s Telegram group is connected through a bot. A photo of any challan, bill or aavak page sent to the
          group lands on the Documents page within a minute; a caption tag like <span className="qty">#bill</span>,{' '}
          <span className="qty">#challan</span>, <span className="qty">#aavak</span> or <span className="qty">#delivery</span>{' '}
          tells the system what it is up front (otherwise it works it out and asks only when unsure).
        </p>
        <p className="text-xs mt-2" style={{ color: 'var(--ink-soft)' }}>
          Set-up (one time, by whoever deploys): create a bot with @BotFather, put its token in TELEGRAM_BOT_TOKEN with
          TELEGRAM_MODE=real, point the webhook at /api/telegram/webhook (or run the poller where no public URL exists),
          and restrict TELEGRAM_ALLOWED_CHAT_ID to the shop group. Full steps are in docs/DEPLOYMENT.md.
        </p>
      </section>

      {isAdmin && demoTotal > 0 && (
        <section className="card card-pad" style={{ borderLeft: '4px solid var(--warn)' }}>
          <div className="section-title">Demo data</div>
          <p className="text-sm">
            The walkthrough data is still loaded ({demoCounts.map((d) => `${d.n} ${d.what}`).join(', ')}).
            Once the real lists are imported, clear it in one go — real data is untouched.
          </p>
          <ActionForm action={purgeDemoAction} confirm="Remove every demo document, item, supplier, order and movement? Real data stays." className="mt-2">
            <button className="btn btn-danger" type="submit">Clear demo data</button>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
