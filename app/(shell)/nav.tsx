'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLinks({ items }: { items: { href: string; label: string; count?: number }[] }) {
  const path = usePathname();
  return (
    <nav className="px-2 pb-2 flex lg:block overflow-x-auto gap-1" aria-label="Main">
      {items.map((it) => {
        const active = it.href === '/' ? path === '/' : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href}
                className={`nav-item whitespace-nowrap ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}>
            <span>{it.label}</span>
            {it.count ? <span className="nav-count">{it.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
