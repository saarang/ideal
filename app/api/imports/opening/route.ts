import { NextRequest, NextResponse } from 'next/server';
import { apiUser } from '@/src/lib/auth';
import { importOpeningStock } from '@/src/lib/importers/itemImport';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let user;
  try { user = await apiUser('STAFF'); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }); }

  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Attach the counted-stock sheet.' }, { status: 400 });
    const asOfDate = String(form.get('asOfDate') ?? '').trim() || new Date().toISOString().slice(0, 10);
    const location = String(form.get('location') ?? 'SHOP') === 'GODOWN' ? 'GODOWN' : 'SHOP';
    const buffer = Buffer.from(await file.arrayBuffer());
    const r = await importOpeningStock(buffer, file.name, { asOfDate, defaultLocation: location, userId: user.id });
    const summary =
      `Posted ${r.posted} opening line(s) at ${location} dated ${asOfDate.split('-').reverse().join('-')}; ` +
      `${r.skipped} skipped` +
      (r.errors.length ? ` (first problem: row ${r.errors[0].row} — ${r.errors[0].error})` : '') + '.';
    return NextResponse.json({ ...r, summary });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Import failed' }, { status: 400 });
  }
}
