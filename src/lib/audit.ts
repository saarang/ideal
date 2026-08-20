import { q } from './db';

/** Append to the audit trail. Kept Next-free so workers/scripts can use it. */
export async function audit(
  actorId: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  before?: unknown,
  after?: unknown,
  actorType: 'USER' | 'SYSTEM' | 'TELEGRAM' = actorId ? 'USER' : 'SYSTEM',
) {
  await q(
    `INSERT INTO audit_events (actor_id, actor_type, action, entity_type, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorId, actorType, action, entityType ?? null, entityId ?? null,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}
