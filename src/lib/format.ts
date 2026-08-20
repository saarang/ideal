// Formatting + date parsing tuned for Indian conventions.

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const inNum = new Intl.NumberFormat('en-IN');

export function fmtINR(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (Number.isNaN(n)) return '—';
  return inr.format(n);
}

export function fmtNum(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (Number.isNaN(n)) return '—';
  return inNum.format(n);
}

/** DD-MM-YYYY for display. Accepts Date, ISO string or 'YYYY-MM-DD'. */
export function fmtDate(v: Date | string | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v.length === 10 ? v + 'T00:00:00' : v) : v;
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

export function fmtDateTime(v: Date | string | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${fmtDate(d)} ${hh}:${mi}`;
}

export interface ParsedDate { iso: string | null; confidence: number; raw: string; }

/**
 * Parse handwritten Indian date variants: 13-08-26, 13/08/2026, 5-7-26,
 * 19|7|26, 18.8.26, "26-07-2026". Day-first is assumed (DD-MM-YY[YY]).
 * Two-digit years map to 20YY. Returns null iso when unparseable.
 */
export function parseIndianDate(rawIn: string | null | undefined, today = new Date()): ParsedDate {
  const raw = (rawIn ?? '').trim();
  if (!raw) return { iso: null, confidence: 0, raw };
  const cleaned = raw.replace(/[|｜l]/g, '/').replace(/[.\\]/g, '-').replace(/\s+/g, '');
  const m = cleaned.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!m) return { iso: null, confidence: 0.2, raw };
  let [, d, mo, y] = m;
  let year = Number(y);
  if (y.length === 2) year = 2000 + year;
  const day = Number(d), month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { iso: null, confidence: 0.2, raw };
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1) return { iso: null, confidence: 0.2, raw };
  const iso = dt.toISOString().slice(0, 10);
  // Sanity: dates far in the future are suspicious for operational documents.
  const days = (dt.getTime() - today.getTime()) / 86_400_000;
  const confidence = days > 30 ? 0.5 : y.length === 2 ? 0.85 : 0.95;
  return { iso, confidence, raw };
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);
}

export function truncate(s: string | null | undefined, n = 60): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
