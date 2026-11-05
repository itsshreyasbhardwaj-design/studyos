'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Command Center' },
  { href: '/focus', label: 'Focus' },
  { href: '/planner', label: 'Planner' },
  { href: '/subjects', label: 'Subjects' },
  { href: '/revision', label: 'Revision' },
  { href: '/graph', label: 'Knowledge Graph' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/report', label: 'Daily Report' },
];

export function Nav({
  dueCount,
  orientation = 'vertical',
}: {
  dueCount: number;
  orientation?: 'vertical' | 'horizontal';
}) {
  const pathname = usePathname();
  const horizontal = orientation === 'horizontal';
  return (
    <nav
      className={horizontal ? 'flex gap-1 overflow-x-auto' : 'flex flex-col gap-0.5'}
      aria-label="Main"
    >
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors ${horizontal ? 'whitespace-nowrap' : 'justify-between'}`}
            style={{
              background: active ? 'var(--surface-hover)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-dim)',
              fontWeight: active ? 500 : 400,
            }}
          >
            <span>{link.label}</span>
            {link.href === '/revision' && dueCount > 0 && (
              <span
                className="rounded-full px-1.5 text-[11px] tabular-nums"
                style={{ background: 'var(--color-accent-dim)', color: 'white' }}
              >
                {dueCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
