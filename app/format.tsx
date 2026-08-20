/** Server-safe display helpers shared by pages. */
import Link from 'next/link';

export const DOC_TYPE_LABEL: Record<string, string> = {
  ORDER_BOOK: 'Order book',
  SUPPLIER_DELIVERY_CHALLAN: 'Supplier challan',
  SUPPLIER_INVOICE: 'Supplier bill',
  INWARD_BOOK: 'Inward book (Aavak Vahi)',
  IDEAL_CUSTOMER_DELIVERY_CHALLAN: 'Ideal delivery challan',
  SHOP_TO_GODOWN_TRANSFER: 'Shop → Godown transfer',
  GODOWN_TO_SHOP_TRANSFER: 'Godown → Shop transfer',
  POS_SALES_FILE: 'POS sales file',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  UNKNOWN: 'Unclassified',
};

export const STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Received', PROCESSING: 'Reading…', NEEDS_REVIEW: 'Needs review',
  READY_TO_POST: 'Ready to post', POSTED: 'Posted to stock',
  LINKED_NO_POSTING: 'Linked (no posting)', DUPLICATE: 'Duplicate',
  FAILED: 'Failed', ARCHIVED: 'Archived',
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip-${status}`}>{STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</span>;
}

export function Stamp({ level }: { level: string }) {
  return <span className={`stamp stamp-${level}`}>{level}</span>;
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d.length === 10 ? d + 'T00:00:00' : d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function inr(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function DocLink({ id, refNo }: { id: string; refNo: string }) {
  return <Link href={`/documents/${id}`} className="link qty">{refNo}</Link>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm py-6 text-center" style={{ color: 'var(--ink-soft)' }}>{children}</p>;
}
