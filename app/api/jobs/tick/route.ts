/**
 * One "heartbeat" for serverless deploys: processes queued pipeline jobs,
 * sends pending Telegram summaries and (once an hour) runs the periodic
 * reconciliation scans. Point an external cron (Vercel Cron, cron-job.org,
 * GitHub Actions schedule…) at:
 *
 *   GET /api/jobs/tick?secret=<JOBS_TICK_SECRET>
 *
 * every minute. Where a long-running process is possible, `npm run worker`
 * does the same continuously and this route is unnecessary.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tick } from '@/src/lib/pipeline/runner';
import { runPeriodicScans } from '@/src/lib/pipeline/recon';
import { sendPendingSummaries } from '@/src/lib/telegram/webhookHandler';
import { q1 } from '@/src/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const expected = process.env.JOBS_TICK_SECRET;
  const given = req.nextUrl.searchParams.get('secret')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (expected && expected.trim() && given !== expected) {
    return NextResponse.json({ error: 'Wrong or missing secret' }, { status: 401 });
  }

  const out: Record<string, unknown> = {};
  out.jobs = await tick(10);
  out.summaries = await sendPendingSummaries();

  // Scans are cheap but chatty; once an hour is plenty.
  const last = await q1<{ value: string }>(`SELECT value::text AS value FROM system_settings WHERE key='last_scan_at'`);
  const lastAt = last ? Date.parse(JSON.parse(last.value)) : 0;
  if (!Number.isFinite(lastAt) || Date.now() - lastAt > 60 * 60_000) {
    out.scans = await runPeriodicScans();
    await q1(`INSERT INTO system_settings (key, value) VALUES ('last_scan_at', to_jsonb(now()::text))
              ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()::text)`);
  }

  return NextResponse.json({ ok: true, ...out });
}
