import { Pool, PoolClient } from 'pg';

const globalForDb = globalThis as unknown as { __pool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.__pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    globalForDb.__pool = new Pool({
      connectionString,
      max: 10,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? undefined
        : { rejectUnauthorized: false },
    });
  }
  return globalForDb.__pool;
}

// Convenience query helper.
export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

export async function q1<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run fn inside a transaction; rolls back on throw. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/** For scripts/workers so the process can exit cleanly. */
export async function closePool(): Promise<void> {
  if (globalForDb.__pool) {
    await globalForDb.__pool.end();
    globalForDb.__pool = undefined;
  }
}

export type Db = PoolClient | Pool;
export async function dq<T = any>(db: Db, text: string, params: any[] = []): Promise<T[]> {
  const res = await db.query(text, params);
  return res.rows as T[];
}
export async function dq1<T = any>(db: Db, text: string, params: any[] = []): Promise<T | null> {
  const rows = await dq<T>(db, text, params);
  return rows[0] ?? null;
}
