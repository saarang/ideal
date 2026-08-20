import { Db, dq } from './db';
import { getPool } from './db';

export interface Settings {
  business_name: string;
  currency: string;
  timezone: string;
  date_format: string;
  overdue_delivery_days: number;
  recon_date_window_days: number;
  challan_invoice_wait_days: number;
  rounding_tolerance_inr: number;
  negative_stock_policy: 'BLOCK' | 'WARN_ALLOW';
  default_receipt_location: string;
  auto_post_high_confidence: boolean;
  conf_high: number;
  conf_medium: number;
  classification_confirm_below: number;
  known_composite_sizes: string[];
  plausible_size_min: number;
  plausible_size_max: number;
}

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(db: Db = getPool(), fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.value;
  const rows = await dq<{ key: string; value: any }>(db, 'SELECT key, value FROM system_settings');
  const map: any = {};
  for (const r of rows) map[r.key] = r.value;
  const value = map as Settings;
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettingsCache() { cache = null; }

export async function setSetting(db: Db, key: string, value: unknown, userId?: string) {
  await dq(db,
    `INSERT INTO system_settings(key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId ?? null]);
  invalidateSettingsCache();
}
