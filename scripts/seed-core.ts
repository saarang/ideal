/**
 * Core seed — the minimum a fresh install needs. Safe to re-run.
 *   npm run seed:core
 * Creates: SHOP + GODOWN locations, default settings, and an admin login
 * (admin@ideal.local / admin123 — change it after first login, or pass
 * ADMIN_EMAIL / ADMIN_PASSWORD env vars).
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { q, q1, closePool } from '../src/lib/db';

const DEFAULT_SETTINGS: Record<string, unknown> = {
  business_name: 'Ideal Uniforms',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  date_format: 'DD-MM-YYYY',
  negative_stock_policy: 'BLOCK',          // BLOCK | WARN_ALLOW
  overdue_delivery_days: 14,               // order → delivery follow-up window
  challan_invoice_wait_days: 10,           // challan → invoice reminder window
  recon_date_window_days: 7,               // how far apart papers of one receipt may be dated
  rounding_tolerance_inr: 1,               // ± tolerance when checking bill totals
  default_receipt_location: 'SHOP',        // where supplier receipts land by default
  auto_post_high_confidence: false,        // keep humans in the loop by default
  conf_high: 0.9,
  conf_medium: 0.75,                       // below this, a field goes to review
  classification_confirm_below: 0.8,       // below this, document type must be confirmed
  known_composite_sizes: ['12/14', '28/32', '14/16', '16/18'],
  plausible_size_min: 16,                  // numbers outside this range are more likely quantities
  plausible_size_max: 44,
};

async function main() {
  for (const [code, name] of [['SHOP', 'Shop (New Panvel)'], ['GODOWN', 'Godown']]) {
    await q(`INSERT INTO locations (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [code, name]);
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q(`INSERT INTO system_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]);
  }

  const email = process.env.ADMIN_EMAIL ?? 'admin@ideal.local';
  const password = process.env.ADMIN_PASSWORD ?? 'admin123';
  const existing = await q1<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
  if (!existing) {
    await q(`INSERT INTO users (email, name, role, password_hash) VALUES (lower($1),'Admin','ADMIN',$2)`,
      [email, bcrypt.hashSync(password, 10)]);
    console.log(`Admin created: ${email} / ${password}  ← change this password after first login`);
  } else {
    console.log(`Admin ${email} already exists — unchanged.`);
  }

  console.log('Core seed done: locations, settings, admin.');
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
