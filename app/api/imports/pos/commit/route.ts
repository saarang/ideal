import { NextRequest, NextResponse } from 'next/server';
import { apiUser } from '@/src/lib/auth';
import { commitPosImport } from '@/src/lib/importers/posImport';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let user;
  try { user = await apiUser('STAFF'); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }); }

  try {
    const form = await req.formData();
    const importId = String(form.get('importId') ?? '');
    if (!importId) return NextResponse.json({ error: 'Missing importId' }, { status: 400 });
    const result = await commitPosImport(importId, user.id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Commit failed' }, { status: 400 });
  }
}
