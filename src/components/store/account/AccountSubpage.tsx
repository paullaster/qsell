import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

/**
 * The frame of every screen under "My account": a way back to the account and to the shop at the top,
 * the heading, and the content. Plain markup with no logic, so it renders on the server.
 */
export function AccountSubpage({
  title,
  intro,
  back = { href: '/profile', label: 'My account' },
  children,
}: {
  title: string;
  intro?: string;
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="text-fg">
      <div className="mx-auto max-w-4xl space-y-6 py-2 sm:py-4">
        <nav
          aria-label="Account navigation"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <Link
            href={back.href}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm font-medium text-fg hover:bg-hover hover:text-fg-strong"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to {back.label}
          </Link>
          <Link
            href="/"
            className="inline-flex min-h-10 items-center px-2 text-sm text-indigo-600 hover:underline"
          >
            Continue shopping
          </Link>
        </nav>
        <header>
          <h1 className="text-2xl font-bold text-fg-strong sm:text-3xl">{title}</h1>
          {intro === undefined ? null : <p className="mt-1 text-sm text-fg-muted">{intro}</p>}
        </header>
        {children}
      </div>
    </div>
  );
}
