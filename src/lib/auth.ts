import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { q, q1 } from './db';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'STAFF' | 'VIEWER';
}

const COOKIE = 'ideal_session';
const SESSION_DAYS = 30;

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await q('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [userId, hashToken(token), expires]);
  return token;
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  jar.delete(COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  return q1<SessionUser>(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [hashToken(token)]);
}

/** Use in pages/layouts: redirects to /login when unauthenticated. */
export async function requireUser(minRole?: 'STAFF' | 'ADMIN'): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (minRole === 'ADMIN' && user.role !== 'ADMIN') redirect('/?denied=1');
  if (minRole === 'STAFF' && user.role === 'VIEWER') redirect('/?denied=1');
  return user;
}

/** Use in route handlers: throws 401/403 style errors instead of redirecting. */
export async function apiUser(minRole?: 'STAFF' | 'ADMIN'): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw Object.assign(new Error('Not signed in'), { status: 401 });
  if (minRole === 'ADMIN' && user.role !== 'ADMIN') throw Object.assign(new Error('Admin only'), { status: 403 });
  if (minRole === 'STAFF' && user.role === 'VIEWER') throw Object.assign(new Error('Read-only account'), { status: 403 });
  return user;
}

export async function verifyPassword(email: string, password: string) {
  const row = await q1<{ id: string; password_hash: string; is_active: boolean }>(
    'SELECT id, password_hash, is_active FROM users WHERE lower(email) = lower($1)', [email]);
  if (!row || !row.is_active) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  return ok ? row.id : null;
}

export function hashPassword(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

export { audit } from './audit';
