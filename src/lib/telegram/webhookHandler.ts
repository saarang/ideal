/**
 * Handle one Telegram update. Photos and image documents become ingested
 * documents (largest photo size is used); the sender gets a short, plain
 * acknowledgement. A follow-up summary with findings is sent by the worker
 * once processing finishes (see worker.ts → sendPendingSummaries).
 *
 * Replies never expose stack traces or internals — problems become "we
 * couldn't read this photo, please retype/resend" style messages, and the
 * detail lands in processing_errors for staff.
 */
import { getPool, dq, dq1 } from '../db';
import { ingestImages } from '../pipeline/ingest';
import { parseCaptionTag } from './tags';
import { getTelegram, TgMessage, TgUpdate } from './transport';

const IMAGE_MIME = /^image\/(jpe?g|png|webp|heic|heif)$/i;

export interface HandleResult {
  handled: boolean;
  documentId?: string;
  refNo?: string;
  reply?: string;
}

export async function handleTelegramUpdate(update: TgUpdate): Promise<HandleResult> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return { handled: false };

  const chatId = String(msg.chat.id);
  const allowed = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  if (allowed && allowed.trim() && chatId !== allowed.trim()) {
    // Quietly ignore strangers; do not reveal that a system exists here.
    return { handled: false };
  }
  const tg = getTelegram();

  // Plain text commands.
  if (msg.text && !msg.photo && !msg.document) {
    const t = msg.text.trim().toLowerCase();
    if (t === '/start' || t === '/help') {
      await tg.sendMessage(chatId,
        'Send a photo of any challan, bill, inward-book or order-book page and I will read it into the stock system.\n' +
        'Optional caption tags: #bill #challan #inward #order #ideal_challan #shop_to_godown #godown_to_shop.\n' +
        'You can send several photos of the same paper as one album.');
      return { handled: true, reply: 'help' };
    }
    return { handled: false };
  }

  let buffer: Buffer | null = null;
  let filename = 'telegram.jpg';
  let fileId: string | null = null;
  let fileUniqueId: string | null = null;

  try {
    if (msg.photo && msg.photo.length > 0) {
      const largest = [...msg.photo].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      fileId = largest.file_id;
      fileUniqueId = largest.file_unique_id;
      const got = await tg.getFile(largest.file_id);
      buffer = got.buffer; filename = got.filename;
    } else if (msg.document) {
      if (!IMAGE_MIME.test(msg.document.mime_type ?? '')) {
        await tg.sendMessage(chatId,
          'I can only read photos (JPG/PNG). For POS exports, please use the website: Imports → POS sales.');
        return { handled: true, reply: 'unsupported' };
      }
      fileId = msg.document.file_id;
      fileUniqueId = msg.document.file_unique_id;
      const got = await tg.getFile(msg.document.file_id);
      buffer = got.buffer;
      filename = msg.document.file_name ?? got.filename;
    } else {
      return { handled: false };
    }
  } catch (err) {
    await dq(getPool(), `INSERT INTO processing_errors (stage, error, details) VALUES ('TELEGRAM_DOWNLOAD',$1,$2)`,
      [err instanceof Error ? err.message : String(err), JSON.stringify({ chatId, messageId: msg.message_id })]);
    await tg.sendMessage(chatId, 'Sorry, I could not download that photo. Please send it again.');
    return { handled: true, reply: 'download-failed' };
  }

  const uploader = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || msg.from?.username || null;
  const parsedTag = parseCaptionTag(msg.caption ?? '');

  try {
    const result = await ingestImages({
      files: [{ buffer: buffer!, filename, telegramFileId: fileId, telegramFileUniqueId: fileUniqueId }],
      captionTag: parsedTag?.tag ?? null,
      source: 'TELEGRAM',
      telegram: {
        chatId,
        messageId: String(msg.message_id),
        mediaGroupId: msg.media_group_id ?? null,
        uploader,
      },
    });

    let reply: string;
    if (result.duplicate) {
      reply = `Looks like this photo was already sent earlier (${result.duplicateOfRef ?? 'existing document'}). I have not recorded it twice.`;
    } else if (result.appendedToExisting) {
      reply = `Added this photo to ${result.refNo}.`;
    } else {
      reply = `Got it 📄 Saved as ${result.refNo}${parsedTag ? ` (${parsedTag.docType.replace(/_/g, ' ').toLowerCase()})` : ''}. Reading it now — I will reply here when it is done.`;
    }
    // For albums, ack only the first photo to avoid spamming the group.
    if (!result.appendedToExisting) await tg.sendMessage(chatId, reply);
    return { handled: true, documentId: result.documentId, refNo: result.refNo, reply };
  } catch (err) {
    await dq(getPool(), `INSERT INTO processing_errors (stage, error, details) VALUES ('TELEGRAM_INGEST',$1,$2)`,
      [err instanceof Error ? err.message : String(err), JSON.stringify({ chatId, messageId: msg.message_id })]);
    await tg.sendMessage(chatId, 'Something went wrong saving that photo. The team has been notified — please try once more.');
    return { handled: true, reply: 'ingest-failed' };
  }
}

/**
 * Send processing summaries for Telegram documents that finished the pipeline
 * but have not been summarised yet. Sent-state is tracked in audit_events so
 * each document is summarised exactly once.
 */
export async function sendPendingSummaries(): Promise<number> {
  const pool = getPool();
  const { documentSummaryText } = await import('../pipeline/post');
  const tg = getTelegram();
  const rows = await dq<{ id: string; telegram_chat_id: string }>(pool,
    `SELECT d.id, d.telegram_chat_id
     FROM documents d
     WHERE d.source='TELEGRAM' AND d.telegram_chat_id IS NOT NULL
       AND d.status IN ('NEEDS_REVIEW','READY_TO_POST','FAILED')
       AND NOT EXISTS (
         SELECT 1 FROM audit_events a
         WHERE a.entity_type='document' AND a.entity_id=d.id AND a.action='TELEGRAM_SUMMARY_SENT')
     ORDER BY d.created_at
     LIMIT 10`);
  let sent = 0;
  for (const r of rows) {
    const doc = await dq1<{ status: string }>(pool, `SELECT status FROM documents WHERE id=$1`, [r.id]);
    let text: string;
    if (doc?.status === 'FAILED') {
      text = 'I could not read one of the photos automatically. Staff will check it on the website — nothing has been added to stock yet.';
    } else {
      text = await documentSummaryText(r.id);
      const appUrl = process.env.APP_BASE_URL;
      if (appUrl) text += `\nReview: ${appUrl}/documents/${r.id}`;
    }
    await tg.sendMessage(r.telegram_chat_id, text);
    await dq(pool,
      `INSERT INTO audit_events (actor_type, action, entity_type, entity_id) VALUES ('SYSTEM','TELEGRAM_SUMMARY_SENT','document',$1)`,
      [r.id]);
    sent++;
  }
  return sent;
}
