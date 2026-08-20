/**
 * DEV ONLY (DEV_TOOLS=1): simulate a Telegram photo message without a real
 * bot. Accepts an uploaded image (or a server-side sample path), writes it to
 * DATA_DIR/dev-uploads and feeds a synthetic update through the exact same
 * handler the real webhook uses; in mock transport mode the local file path
 * doubles as the file_id. The pipeline then runs inline so the result is
 * visible immediately without a worker.
 */
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { apiUser } from '@/src/lib/auth';
import { handleTelegramUpdate } from '@/src/lib/telegram/webhookHandler';
import { runPipeline } from '@/src/lib/pipeline/runner';
import { q } from '@/src/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (process.env.DEV_TOOLS !== '1') return NextResponse.json({ error: 'Dev tools are off' }, { status: 404 });
  if ((process.env.TELEGRAM_MODE ?? 'mock') === 'real') {
    return NextResponse.json({ error: 'Simulator only works with TELEGRAM_MODE=mock' }, { status: 400 });
  }
  let user;
  try { user = await apiUser('STAFF'); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }); }

  try {
    const form = await req.formData();
    const caption = String(form.get('caption') ?? '').trim();
    const sender = String(form.get('sender') ?? 'Simulator').trim() || 'Simulator';

    let filePath: string;
    const file = form.get('file');
    const samplePath = String(form.get('samplePath') ?? '').trim();
    if (file instanceof File && file.size > 0) {
      const dir = path.resolve(process.env.DATA_DIR || './data', 'dev-uploads');
      await fs.mkdir(dir, { recursive: true });
      filePath = path.join(dir, `${Date.now()}-${file.name.replace(/[^\w.\-]+/g, '_')}`);
      await fs.writeFile(filePath, Buffer.from(await file.arrayBuffer()));
    } else if (samplePath) {
      filePath = path.resolve(samplePath);
      await fs.access(filePath);
    } else {
      return NextResponse.json({ error: 'Attach a photo or pick a sample.' }, { status: 400 });
    }

    const update = {
      update_id: Date.now(),
      message: {
        message_id: Date.now() % 1_000_000,
        date: Math.floor(Date.now() / 1000),
        chat: { id: process.env.TELEGRAM_ALLOWED_CHAT_ID || 'dev-chat', type: 'group', title: 'Ideal Uniforms (simulated)' },
        from: { id: 1, first_name: sender },
        caption: caption || undefined,
        photo: [{ file_id: filePath, file_unique_id: `dev-${Date.now()}`, width: 1000, height: 1400 }],
      },
    };

    const result = await handleTelegramUpdate(update as never);
    let pipeline: unknown = null;
    if (result.documentId) {
      pipeline = await runPipeline(result.documentId, 'PREPARE');
      await q(`UPDATE processing_jobs SET status='DONE' WHERE document_id=$1 AND status='QUEUED'`, [result.documentId]);
    }
    const replies = await q<{ text: string }>(
      `SELECT text FROM telegram_outbox ORDER BY created_at DESC LIMIT 3`);
    return NextResponse.json({
      ok: true, documentId: result.documentId ?? null, refNo: result.refNo ?? null,
      pipeline, botReplies: replies.map((r) => r.text).reverse(), by: user.name,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Simulation failed' }, { status: 400 });
  }
}
