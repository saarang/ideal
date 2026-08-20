/**
 * Test database plumbing. Every test file runs against ideal_uniforms_test:
 * migrations are applied once per process, and resetDb() truncates all data
 * tables (keeping the schema) so each suite starts from a clean register.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://ideal:ideal@localhost:5432/ideal_uniforms_test';
process.env.AI_PROVIDER = 'mock';
process.env.TELEGRAM_MODE = 'mock';
process.env.STORAGE_DRIVER = 'local';
process.env.DATA_DIR = path.resolve('./data-test');

let migrated = false;

export async function migrateTestDb(): Promise<void> {
  if (migrated) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  }
  await pool.end();
  migrated = true;
}

/** Truncate every data table; keeps schema + sequences reset. */
export async function resetDb(): Promise<void> {
  await migrateTestDb();
  const { getPool } = await import('@/src/lib/db');
  const pool = getPool();
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`);
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (tables) await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  const { invalidateSettingsCache } = await import('@/src/lib/settings');
  invalidateSettingsCache();
}

export interface CoreIds {
  shopId: string; godownId: string; userId: string;
}

/** Locations + one admin + the settings the code reads. */
export async function seedCore(): Promise<CoreIds> {
  const { getPool } = await import('@/src/lib/db');
  const pool = getPool();
  const shop = await pool.query(`INSERT INTO locations (code, name) VALUES ('SHOP','Shop') RETURNING id`);
  const godown = await pool.query(`INSERT INTO locations (code, name) VALUES ('GODOWN','Godown') RETURNING id`);
  const user = await pool.query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ('t@t.local','Tester','ADMIN','x') RETURNING id`);
  const settings: Record<string, unknown> = {
    business_name: 'Ideal Uniforms', currency: 'INR', timezone: 'Asia/Kolkata', date_format: 'DD-MM-YYYY',
    overdue_delivery_days: 14, recon_date_window_days: 7, challan_invoice_wait_days: 10,
    rounding_tolerance_inr: 1, negative_stock_policy: 'BLOCK', default_receipt_location: 'SHOP',
    auto_post_high_confidence: false, conf_high: 0.9, conf_medium: 0.75, classification_confirm_below: 0.8,
    known_composite_sizes: ['12/14', '28/32', '14/16', '16/18'], plausible_size_min: 16, plausible_size_max: 44,
  };
  for (const [k, v] of Object.entries(settings)) {
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ($1,$2)`, [k, JSON.stringify(v)]);
  }
  return { shopId: shop.rows[0].id, godownId: godown.rows[0].id, userId: user.rows[0].id };
}

export async function makeItem(code: string, name: string, sizes: string[] = []): Promise<string> {
  const { getPool } = await import('@/src/lib/db');
  const pool = getPool();
  const cat = await pool.query(
    `INSERT INTO item_categories (name) VALUES ('Test') ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const item = await pool.query(
    `INSERT INTO items (code, name, category_id) VALUES ($1,$2,$3) RETURNING id`, [code, name, cat.rows[0].id]);
  for (const s of sizes) {
    await pool.query(`INSERT INTO item_sizes (item_id, size) VALUES ($1,$2)`, [item.rows[0].id, s]);
  }
  return item.rows[0].id;
}

export async function makeSupplier(code: string, name: string): Promise<string> {
  const { getPool } = await import('@/src/lib/db');
  const r = await getPool().query(`INSERT INTO suppliers (code, name) VALUES ($1,$2) RETURNING id`, [code, name]);
  return r.rows[0].id;
}

export async function closeDb(): Promise<void> {
  const { closePool } = await import('@/src/lib/db');
  await closePool();
}
