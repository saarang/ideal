/**
 * Create or update a login user.
 *   npm run user:create -- --email owner@ideal.example --name "Owner" --password secret --role ADMIN
 * Roles: ADMIN (settings, users, posting), STAFF (day-to-day), VIEWER (read-only).
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { q, q1, closePool } from '../src/lib/db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const name = arg('name') ?? email?.split('@')[0] ?? 'User';
  const password = arg('password');
  const role = (arg('role') ?? 'STAFF').toUpperCase();
  if (!email || !password) {
    console.error('Usage: npm run user:create -- --email you@x.com --password secret [--name "Full Name"] [--role ADMIN|STAFF|VIEWER]');
    process.exit(1);
  }
  if (!['ADMIN', 'STAFF', 'VIEWER'].includes(role)) {
    console.error(`Unknown role ${role}`); process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 10);
  const existing = await q1<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
  if (existing) {
    await q(`UPDATE users SET name=$2, password_hash=$3, role=$4, is_active=TRUE WHERE id=$1`,
      [existing.id, name, hash, role]);
    console.log(`Updated ${email} (${role}).`);
  } else {
    await q(`INSERT INTO users (email, name, password_hash, role) VALUES (lower($1),$2,$3,$4)`,
      [email, name, hash, role]);
    console.log(`Created ${email} (${role}).`);
  }
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
