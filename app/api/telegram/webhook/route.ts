/**
 * Telegram webhook. Register it with setWebhook and the same secret:
 *   curl "https://api.telegram.org/bot<token>/setWebhook?url=https://your.app/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
 * Telegram then sends X-Telegram-Bot-Api-Secret-Token with every update; a
 * ?secret= query parameter is accepted too for platforms that strip headers.
 * Always answers 200 so Telegram does not retry storms on our mistakes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleTelegramUpdate } from '@/src/lib/telegram/webhookHandler';
import { q } from '@/src/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && expected.trim()) {
    const header = req.headers.get('x-telegram-bot-api-secret-token');
    const query = req.nextUrl.searchParams.get('secret');
    if (header !== expected && query !== expected) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true, note: 'not json' });
  }

  try {
    const result = await handleTelegramUpdate(update as never);
    return NextResponse.json({ ok: true, handled: result.handled, ref: result.refNo ?? null });
  } catch (err) {
    // Never bounce Telegram: log and acknowledge.
    try {
      await q(`INSERT INTO processing_errors (stage, error, details) VALUES ('TELEGRAM_WEBHOOK',$1,$2)`,
        [err instanceof Error ? err.message : String(err), JSON.stringify(update).slice(0, 4000)]);
    } catch { /* ignore */ }
    return NextResponse.json({ ok: true, handled: false });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST Telegram updates here.' });
}
