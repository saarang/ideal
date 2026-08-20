/** Small CSV/XLSX helpers for the import screens. */
import * as XLSX from 'xlsx';

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];   // values as trimmed strings; '' for blanks
  sheetName?: string;
}

/** Parse .csv/.xls/.xlsx bytes into headers + string rows (first sheet). */
export function parseTabular(buffer: Buffer, filename: string): ParsedTable {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error(`No sheets found in ${filename}`);
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
  if (aoa.length === 0) return { headers: [], rows: [], sheetName };

  // Header row = first row with at least two non-empty cells.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const nonEmpty = (aoa[i] as unknown[]).filter((c) => String(c ?? '').trim() !== '').length;
    if (nonEmpty >= 2) { headerIdx = i; break; }
  }
  const headers = (aoa[headerIdx] as unknown[]).map((h, i) => {
    const s = String(h ?? '').trim();
    return s || `Column ${i + 1}`;
  });
  const rows: Record<string, string>[] = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const arr = aoa[i] as unknown[];
    if (arr.every((c) => String(c ?? '').trim() === '')) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = String(arr[j] ?? '').trim(); });
    rows.push(row);
  }
  return { headers, rows, sheetName };
}

/** RFC-4180-ish CSV writer for report exports. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}

export function parseIntStrict(s: string): number | null {
  const cleaned = s.replace(/[, ]/g, '');
  if (!/^-?\d+$/.test(cleaned)) return null;
  return parseInt(cleaned, 10);
}

export function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[₹, ]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Accepts DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, and Excel serials. */
export function parseImportDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const dmy = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    let [, dd, mm, yy] = dmy;
    if (yy.length === 2) yy = `20${yy}`;
    const d = parseInt(dd, 10), m = parseInt(mm, 10), y = parseInt(yy, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }
  if (/^\d{5}$/.test(t)) { // Excel serial
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + parseInt(t, 10) * 86400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}
