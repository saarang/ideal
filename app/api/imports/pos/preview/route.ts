import { NextRequest, NextResponse } from 'next/server';
import { apiUser } from '@/src/lib/auth';
import { parseTabular } from '@/src/lib/importers/csv';
import { guessColumnMap, previewPosImport, savedTemplate, PosColumnMap } from '@/src/lib/importers/posImport';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let user;
  try { user = await apiUser('STAFF'); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }); }

  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Attach the POS file.' }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());

    let map: PosColumnMap | null = null;
    const rawMap = form.get('map');
    if (typeof rawMap === 'string' && rawMap.trim()) {
      map = JSON.parse(rawMap) as PosColumnMap;
    } else {
      const headers = parseTabular(buffer, file.name).headers;
      map = (await savedTemplate()) ?? guessColumnMap(headers);
      // A saved template only helps if its columns exist in this file.
      if (map?.quantity && !headers.includes(map.quantity)) map = guessColumnMap(headers);
    }
    if (!map?.quantity) {
      const headers = parseTabular(buffer, file.name).headers;
      return NextResponse.json({
        importId: null, filename: file.name, headers, totalRows: 0, okRows: 0, errorRows: 0,
        duplicateRows: 0, rows: [], alreadyImportedFile: false, usedMap: map ?? {},
        error: 'Could not tell which column holds the quantity — pick it below and re-check.',
      }, { status: 400 });
    }

    const preview = await previewPosImport(buffer, file.name, map, user.id);
    return NextResponse.json({ ...preview, usedMap: map });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 400 });
  }
}
