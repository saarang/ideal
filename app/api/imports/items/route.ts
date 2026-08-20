import { NextRequest, NextResponse } from 'next/server';
import { apiUser } from '@/src/lib/auth';
import { importVasyErpProducts } from '@/src/lib/importers/itemImport';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let user;
  try { user = await apiUser('STAFF'); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }); }

  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Attach the product export file.' }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const r = await importVasyErpProducts(buffer, file.name, user.id);
    const summary =
      `Read ${r.rows} rows: ${r.itemsCreated} new item(s), ${r.itemsReused} already known, ` +
      `${r.sizesCreated} size(s) added` +
      (r.errors.length ? `; ${r.errors.length} row(s) skipped (first: row ${r.errors[0].row} — ${r.errors[0].error})` : '') + '.';
    return NextResponse.json({ ...r, summary });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Import failed' }, { status: 400 });
  }
}
