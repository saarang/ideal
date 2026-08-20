/**
 * Long-polling intake for TELEGRAM_MODE=real when the app has no public URL
 * (e.g. running on a shop PC). Uses getUpdates with a 25 s wait; remembers the
 * offset in system_settings so restarts do not re-process old messages.
 *
 *   TELEGRAM_MODE=real TELEGRAM_BOT_TOKEN=... npm run telegram:poll
 */
import 'dotenv/config';
import { getPool, dq, dq1 } from '../src/lib/db';
import { handleTelegramUpdate } from '../src/lib/telegram/webhookHandler';
import { closePool } from '../src/lib/db';

const OFFSET_KEY = 'telegram_poll_offset';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || (process.env.TELEGRAM_MODE ?? 'mock') !== 'real') {
    console.error('Set TELEGRAM_MODE=real and TELEGRAM_BOT_TOKEN before running the poller.');
    process.exit(1);
  }
  const pool = getPool();
  let running = true;
  process.on('SIGINT', () => { running = false; });

  const saved = await dq1<{ value: number }>(pool, `SELECT value FROM system_settings WHERE key=$1`, [OFFSET_KEY]);
  let offset = typeof saved?.value === 'number' ? saved.value : 0;
  console.log(`[poll] starting from offset ${offset}`);

  while (running) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=%5B%22message%22%5D`);
      const body = await res.json();
      if (!body?.ok) { console.error('[poll] getUpdates failed:', JSON.stringify(body).slice(0, 200)); await sleep(5000); continue; }
      for (const update of body.result ?? []) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          const r = await handleTelegramUpdate(update);
          if (r.handled) console.log(`[poll] update ${update.update_id}: ${r.reply ?? r.refNo ?? 'ok'}`);
        } catch (err) {
          console.error(`[poll] update ${update.update_id} failed:`, err instanceof Error ? err.message : err);
        }
        await dq(pool,
          `INSERT INTO system_settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
          [OFFSET_KEY, JSON.stringify(offset)]);
      }
    } catch (err) {
      console.error('[poll] network error:', err instanceof Error ? err.message : err);
      await sleep(5000);
    }
  }
  await closePool();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => { console.error(e); process.exit(1); });
