/**
 * Pipeline runner. A document travels PREPARE → CLASSIFY → EXTRACT → VALIDATE
 * → MATCH → STATUS. Each stage is retried up to max_attempts; every attempt is
 * logged to document_processing_runs, failures land in processing_errors and
 * flip the document to FAILED (staff can reprocess from the UI).
 *
 * Jobs are claimed with FOR UPDATE SKIP LOCKED so the web tick endpoint and a
 * long-running worker can safely coexist.
 */
import { getPool, dq, dq1, withTx } from '../db';
import { prepareDocument } from './ingest';
import { classifyDocument, extractDocument } from './stages';
import { validateDocument } from './validate';
import { matchDocument } from './match';
import { refreshDocumentStatus } from './status';

export type Stage = 'PREPARE' | 'CLASSIFY' | 'EXTRACT' | 'VALIDATE' | 'MATCH' | 'STATUS';
const ORDER: Stage[] = ['PREPARE', 'CLASSIFY', 'EXTRACT', 'VALIDATE', 'MATCH', 'STATUS'];

const HANDLERS: Record<Stage, (documentId: string) => Promise<unknown>> = {
  PREPARE: prepareDocument,
  CLASSIFY: classifyDocument,
  EXTRACT: extractDocument,
  VALIDATE: validateDocument,
  MATCH: matchDocument,
  STATUS: refreshDocumentStatus,
};

function nextStage(stage: Stage): Stage | null {
  const i = ORDER.indexOf(stage);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

async function runStage(documentId: string, stage: Stage, attempt: number): Promise<void> {
  const pool = getPool();
  const run = await dq1<{ id: string }>(pool,
    `INSERT INTO document_processing_runs (document_id, stage, status, attempt)
     VALUES ($1,$2,'RUNNING',$3) RETURNING id`, [documentId, stage, attempt]);
  try {
    const out = await HANDLERS[stage](documentId);
    await dq(pool,
      `UPDATE document_processing_runs SET status='SUCCEEDED', finished_at=now(), log=$2 WHERE id=$1`,
      [run!.id, out ? JSON.stringify(out) : null]);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await dq(pool,
      `UPDATE document_processing_runs SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1`,
      [run!.id, msg]);
    throw err;
  }
}

/**
 * Run the whole pipeline synchronously from a given stage (used by seeds,
 * tests and the "Reprocess" button). Failures are recorded, not thrown.
 */
export async function runPipeline(documentId: string, from: Stage = 'PREPARE'): Promise<{ ok: boolean; failedStage?: Stage; error?: string }> {
  const pool = getPool();
  let stage: Stage | null = from;
  while (stage) {
    try {
      await runStage(documentId, stage, 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await dq(pool,
        `INSERT INTO processing_errors (document_id, stage, error) VALUES ($1,$2,$3)`,
        [documentId, stage, msg]);
      await dq(pool,
        `UPDATE documents SET status='FAILED'
         WHERE id=$1 AND status NOT IN ('POSTED','DUPLICATE','LINKED_NO_POSTING','ARCHIVED')`,
        [documentId]);
      return { ok: false, failedStage: stage, error: msg };
    }
    stage = nextStage(stage);
  }
  return { ok: true };
}

/** Queue (or requeue) the pipeline for a document, starting at a stage. */
export async function enqueue(documentId: string, stage: Stage = 'PREPARE', delaySeconds = 0): Promise<void> {
  await dq(getPool(),
    `INSERT INTO processing_jobs (document_id, next_stage, run_after)
     VALUES ($1,$2, now() + make_interval(secs => $3))`,
    [documentId, stage, delaySeconds]);
}

/**
 * Claim and run up to `limit` queued jobs. Each job advances its document one
 * stage; on success the follow-up stage is queued, so long documents progress
 * across ticks and one slow OCR does not starve the queue.
 */
export async function tick(limit = 5): Promise<{ processed: number; failed: number }> {
  const pool = getPool();
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < limit; i++) {
    const job = await withTx(async (client) => {
      const j = await dq1<{ id: string; document_id: string; next_stage: Stage; attempts: number; max_attempts: number }>(client,
        `SELECT id, document_id, next_stage, attempts, max_attempts FROM processing_jobs
         WHERE status='QUEUED' AND run_after <= now()
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!j) return null;
      await dq(client,
        `UPDATE processing_jobs SET status='RUNNING', locked_at=now(), attempts=attempts+1 WHERE id=$1`, [j.id]);
      return j;
    });
    if (!job) break;

    try {
      await runStage(job.document_id, job.next_stage, job.attempts + 1);
      await dq(pool, `UPDATE processing_jobs SET status='DONE' WHERE id=$1`, [job.id]);
      const follow = nextStage(job.next_stage);
      if (follow) await enqueue(job.document_id, follow);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attemptsUsed = job.attempts + 1;
      if (attemptsUsed >= job.max_attempts) {
        await dq(pool, `UPDATE processing_jobs SET status='FAILED', last_error=$2 WHERE id=$1`, [job.id, msg]);
        await dq(pool, `INSERT INTO processing_errors (document_id, stage, error) VALUES ($1,$2,$3)`,
          [job.document_id, job.next_stage, msg]);
        await dq(pool,
          `UPDATE documents SET status='FAILED'
           WHERE id=$1 AND status NOT IN ('POSTED','DUPLICATE','LINKED_NO_POSTING','ARCHIVED')`,
          [job.document_id]);
      } else {
        // Exponential-ish backoff: 30s, 120s.
        await dq(pool,
          `UPDATE processing_jobs SET status='QUEUED', locked_at=NULL, last_error=$2,
             run_after = now() + make_interval(secs => $3)
           WHERE id=$1`,
          [job.id, msg, attemptsUsed * attemptsUsed * 30]);
      }
      failed++;
    }
  }
  return { processed, failed };
}
