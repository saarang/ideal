import Link from 'next/link';
import { requireUser } from '@/src/lib/auth';
import { q1 } from '@/src/lib/db';
import { logoutAction } from '../actions';
import { Toaster } from '../ui';
import { NavLinks } from './nav';

export const dynamic = 'force-dynamic';

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const counts = await q1<{ review: number; tasks: number; findings: number }>(
    `SELECT
       (SELECT count(*) FROM documents WHERE status IN ('NEEDS_REVIEW','FAILED'))::int AS review,
       (SELECT count(*) FROM workflow_tasks WHERE status IN ('OPEN','IN_PROGRESS'))::int AS tasks,
       (SELECT count(*) FROM findings WHERE status='OPEN')::int AS findings`);

  const nav = [
    { href: '/', label: 'Dashboard' },
    { href: '/documents', label: 'Documents', count: counts?.review },
    { href: '/tasks', label: 'Tasks', count: counts?.tasks },
    { href: '/findings', label: 'Findings', count: counts?.findings },
    { href: '/stock', label: 'Stock' },
    { href: '/items', label: 'Items' },
    { href: '/orders', label: 'Orders' },
    { href: '/recon', label: 'Reconciliation' },
    { href: '/mapping', label: 'Mapping' },
    { href: '/imports', label: 'Imports' },
    { href: '/reports', label: 'Reports' },
    { href: '/settings', label: 'Settings' },
    ...(process.env.DEV_TOOLS === '1' ? [{ href: '/dev/telegram', label: 'Telegram simulator' }] : []),
  ];

  return (
    <div className="min-h-screen lg:flex">
      <aside className="lg:w-60 lg:min-h-screen border-b lg:border-b-0 lg:border-r shrink-0"
             style={{ borderColor: 'var(--rule)' , background: '#fbfaf6' }}>
        <div className="p-4 flex items-center justify-between lg:block">
          <Link href="/" className="block">
            <div className="display text-lg leading-tight font-bold">Ideal Uniforms</div>
            <div className="text-[11px] uppercase tracking-widest" style={{ color: 'var(--khaki)' }}>Stock register</div>
          </Link>
          <form action={logoutAction} className="lg:hidden">
            <button className="btn btn-secondary text-xs">Sign out</button>
          </form>
        </div>
        <NavLinks items={nav} />
        <div className="hidden lg:block p-4 mt-4 text-xs" style={{ color: 'var(--ink-soft)' }}>
          <div className="mb-2">{user.name} · {user.role.toLowerCase()}</div>
          <form action={logoutAction}>
            <button className="btn btn-secondary text-xs">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="flex-1 p-4 sm:p-6 max-w-6xl">{children}</main>
      <Toaster />
    </div>
  );
}
