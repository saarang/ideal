import crypto from 'crypto';
import sharp from 'sharp';
import { withTx, dq, dq1, q1, q } from '../db';
import { getStorage } from '../storage';
import { raiseFinding } from '../domain/findings';

export interface IngestFile {
  buffer: Buffer;
  filename?: string | null;
  mime?: string;
  telegramFileId?: string | null;
  telegramFileUniqueId?: string | null;
}

export interface IngestArgs {
  files: IngestFile[];
  captionTag?: string | null;
  source: 'TELEGRAM' | 'WEB_UPLOAD' | 'SEED';
  telegram?: { chatId: string; messageId: string; mediaGroupId?: string | null; uploader?: string | null } | null;
  uploadedBy?: string | null;   // user id for web uploads
  isDemo?: boolean;
}

export interface IngestResult {
  documentId: string;
  refNo: string;
  appendedToExisting: boolean;
  duplicate: boolean;
  duplicateOfRef?: string | null;
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Stage 1 — Ingestion. Stores originals untouched, detects duplicates by
 * Telegram file id and content hash, groups multi-photo Telegram albums into
 * one document, and queues the processing pipeline.
 */
export async function ingestImages(args: IngestArgs): Promise<IngestResult> {
  if (!args.files.length) throw new Error('No files to ingest');
  const storage = getStorage();

  // Multi-photo albums: append to the recent document with the same media group.
  if (args.telegram?.mediaGroupId) {
    const existing = await q1<{ id: string; ref_no: string }>(
      `SELECT id, ref_no FROM documents
       WHERE telegram_media_group_id = $1 AND created_at > now() - interval '10 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [args.telegram.mediaGroupId]);
    if (existing) {
      await withTx(async (tx) => {
        const maxPage = await dq1<{ m: number }>(tx, 'SELECT COALESCE(MAX(page_no),0) AS m FROM document_pages WHERE document_id=$1', [existing.id]);
        let n = (maxPage?.m ?? 0);
        for (const f of args.files) {
          n += 1;
          const hash = sha256(f.buffer);
          const key = `documents/${existing.id}/p${n}-original.jpg`;
          await storage.put(key, f.buffer);
          await dq(tx,
            `INSERT INTO document_pages (document_id, page_no, original_path, mime_type, sha256, telegram_file_id, telegram_file_unique_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [existing.id, n, key, f.mime ?? 'image/jpeg', hash, f.telegramFileId ?? null, f.telegramFileUniqueId ?? null]);
        }
        await dq(tx, `UPDATE processing_jobs SET next_stage='PREPARE', status='QUEUED', run_after=now() WHERE document_id=$1 AND status <> 'RUNNING'`, [existing.id]);
      });
      return { documentId: existing.id, refNo: existing.ref_no, appendedToExisting: true, duplicate: false };
    }
  }

  // Duplicate detection against previously stored pages.
  const firstHash = sha256(args.files[0].buffer);
  const dupBy = await q1<{ document_id: string; ref_no: string }>(
    `SELECT p.document_id, d.ref_no FROM document_pages p
     JOIN documents d ON d.id = p.document_id
     WHERE (p.sha256 = $1 OR (p.telegram_file_unique_id IS NOT NULL AND p.telegram_file_unique_id = $2))
       AND d.status <> 'DUPLICATE'
     ORDER BY p.created_at ASC LIMIT 1`,
    [firstHash, args.files[0].telegramFileUniqueId ?? '']);

  return withTx(async (tx) => {
    const doc = await dq1<{ id: string; ref_no: string }>(tx,
      `INSERT INTO documents (source, tag_raw, telegram_chat_id, telegram_message_id, telegram_media_group_id,
         telegram_uploader, uploaded_by, original_filename, is_demo, status, duplicate_of_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, ref_no`,
      [args.source, args.captionTag ?? null,
       args.telegram?.chatId ?? null, args.telegram?.messageId ?? null, args.telegram?.mediaGroupId ?? null,
       args.telegram?.uploader ?? null, args.uploadedBy ?? null,
       args.files[0].filename ?? null, args.isDemo ?? false,
       dupBy ? 'DUPLICATE' : 'RECEIVED', dupBy?.document_id ?? null]);

    let n = 0;
    for (const f of args.files) {
      n += 1;
      const key = `documents/${doc!.id}/p${n}-original.jpg`;
      await storage.put(key, f.buffer);
      await dq(tx,
        `INSERT INTO document_pages (document_id, page_no, original_path, mime_type, sha256, telegram_file_id, telegram_file_unique_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [doc!.id, n, key, f.mime ?? 'image/jpeg', sha256(f.buffer), f.telegramFileId ?? null, f.telegramFileUniqueId ?? null]);
    }

    if (dupBy) {
      await raiseFinding(tx, {
        type: 'POSSIBLE_DUPLICATE_DOCUMENT', severity: 'WARNING',
        title: `Duplicate upload of ${dupBy.ref_no}`,
        explanation: 'The same image (identical content hash or Telegram file id) was uploaded again. The duplicate is stored for reference but will not be processed or posted.',
        documentId: doc!.id, relatedDocumentIds: [dupBy.document_id],
        recommendedAction: 'No action needed unless this was meant to be a different document.',
        dedupKey: `dup:${doc!.id}`,
      });
    } else {
      await dq(tx, `INSERT INTO processing_jobs (document_id, next_stage) VALUES ($1, 'PREPARE')`, [doc!.id]);
    }
    return { documentId: doc!.id, refNo: doc!.ref_no, appendedToExisting: false, duplicate: !!dupBy, duplicateOfRef: dupBy?.ref_no ?? null };
  });
}

/**
 * Stage 2 — Image preparation. EXIF auto-rotation, gentle contrast
 * normalisation and a bounded resize. The original is never modified.
 */
export async function prepareDocument(documentId: string): Promise<void> {
  const storage = getStorage();
  const pages = await q<{ id: string; page_no: number; original_path: string }>(
    'SELECT id, page_no, original_path FROM document_pages WHERE document_id=$1 ORDER BY page_no', [documentId]);
  for (const p of pages) {
    const original = await storage.get(p.original_path);
    const meta = await sharp(original).metadata();
    const processed = await sharp(original)
      .rotate()                                    // honour EXIF orientation
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .normalize()                                 // stretch contrast for faint handwriting
      .jpeg({ quality: 88 })
      .toBuffer();
    const outMeta = await sharp(processed).metadata();
    const key = p.original_path.replace('-original', '-processed');
    await storage.put(key, processed);
    const rotation = meta.orientation && meta.orientation > 1 ? (meta.orientation === 6 ? 90 : meta.orientation === 8 ? 270 : meta.orientation === 3 ? 180 : 0) : 0;
    await q(`UPDATE document_pages SET processed_path=$2, width=$3, height=$4, rotation_applied=$5 WHERE id=$1`,
      [p.id, key, outMeta.width ?? null, outMeta.height ?? null, rotation]);
  }
}
