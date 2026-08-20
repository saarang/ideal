/**
 * Long-running worker: processes queued pipeline jobs, sends Telegram
 * summaries for finished documents, and runs the daily-style reconciliation
 * scans every 15 minutes. On serverless deploys, hit /api/jobs/tick from an
 * external cron instead (see DEPLOYMENT.md).
 *
 *   npm run worker
 */
import 'dotenv/config';
import { tick } from '../src/lib/pipeline/runner';
import { runPeriodicScans } from '../src/lib/pipeline/recon';
import { sendPendingSummaries } from '../src/lib/telegram/webhookHandler';
import { closePool } from '../src/lib/db';

const JOB_INTERVAL_MS = 3_000;
const SCAN_INTERVAL_MS = 15 * 60_000;

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

async function main() {
  console.log('[worker] started — Ctrl-C to stop');
  let lastScan = 0;
  while (running) {
    try {
      const { processed, failed } = await tick(5);
      if (processed || failed) console.log(`[worker] jobs: ${processed} ok, ${failed} failed`);
      const summaries = await sendPendingSummaries();
      if (summaries) console.log(`[worker] telegram summaries sent: ${summaries}`);
      if (Date.now() - lastScan > SCAN_INTERVAL_MS) {
        const scans = await runPeriodicScans();
        console.log('[worker] scans:', scans);
        lastScan = Date.now();
      }
    } catch (err) {
      console.error('[worker] tick error:', err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, JOB_INTERVAL_MS));
  }
  await closePool();
  console.log('[worker] stopped');
}

main().catch((e) => { console.error(e); process.exit(1); });
