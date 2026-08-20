import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/src/lib/auth';
import { getReport, reportToCsv } from '@/src/lib/reports';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { key } = await ctx.params;
  const def = getReport(key);
  if (!def) return NextResponse.json({ error: 'No such report' }, { status: 404 });

  const params: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => { params[k] = v; });

  const result = await def.run(params);
  const csv = reportToCsv(result);
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replaceAll('/', '-');
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${key}-${today}.csv"`,
    },
  });
}
