'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { VendorPortalRole } from '@/server/db/drizzle/schema';

interface PortalLink {
  href: string;
  label: string;
  roles?: readonly VendorPortalRole[];
}

const LINKS: readonly PortalLink[] = [
  { href: '/vendor', label: 'Home' },
  { href: '/vendor/profile', label: 'My profile' },
  { href: '/vendor/prequalification', label: 'Prequalification' },
  { href: '/vendor/rfqs', label: 'Requests for quotation' },
  { href: '/vendor/orders', label: 'Purchase orders' },
  { href: '/vendor/invoices', label: 'Invoices', roles: ['owner', 'finance'] },
  { href: '/vendor/credits', label: 'Credit notes', roles: ['owner', 'finance'] },
  { href: '/vendor/payments', label: 'Payments', roles: ['owner', 'finance'] },
  { href: '/vendor/team', label: 'Team', roles: ['owner'] },
];

/** A persistent, responsive route menu so portal pages never become dead ends. */
export function VendorPortalNavigation({ role }: { role: VendorPortalRole }) {
  const pathname = usePathname();
  const visible = LINKS.filter((link) => link.roles === undefined || link.roles.includes(role));
  return (
    <nav aria-label="Vendor portal" className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap gap-1 px-3 py-2 sm:px-4">
        {visible.map((link) => {
          const active = link.href === '/vendor' ? pathname === link.href : pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium transition-colors ${active ? 'bg-indigo-600 text-white' : 'text-fg-muted hover:bg-hover hover:text-fg-strong'}`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
