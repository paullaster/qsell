import Link from 'next/link';
import type { ReactNode } from 'react';

/** The frame of the rep app: a header with the way home and out, and room for one thing at a time on a phone. */
export function RepShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface text-fg">
      <header className="sticky top-0 z-10 border-b border-line bg-surface-raised pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-2">
          <Link href="/rep" className="inline-flex min-h-11 items-center text-base font-bold text-fg-strong">Rep app</Link>
          <form method="post" action="/api/rep/sign-out">
            <button type="submit" className="min-h-11 rounded-lg px-3 text-sm font-semibold text-fg-muted hover:bg-surface">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-4">{children}</main>
    </div>
  );
}

/** Shown while a screen's data is on its way, so the frame is never empty. */
export function RepSkeleton({ label }: { label: string }) {
  return <p role="status" className="rounded-xl border border-line bg-surface-raised p-6 text-center text-sm text-fg-muted">Loading {label}…</p>;
}
