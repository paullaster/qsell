import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/auth';
import { logoutAction } from '@/server/domains/auth/actions';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { buttonClass } from '@/components/ui/screen-kit';

// The portal is private to vendors and never indexed.
export const metadata: Metadata = { title: 'Vendor portal', robots: { index: false, follow: false } };

/**
 * The vendor portal's frame. The proxy already turns away anyone who is not a vendor; this checks again on the server so a
 * misconfigured proxy can never expose a page.
 */
export default async function VendorPortalLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const user = session?.user;
  if (user?.role !== 'vendor' || typeof user.vendorId !== 'string') redirect('/login?callbackUrl=%2Fvendor');
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface-raised">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm font-bold text-fg-strong">Vendor portal</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-muted">{user.name}</span>
            <ThemeToggle />
            <form action={logoutAction}>
              <input type="hidden" name="returnTo" value="/login" />
              <button type="submit" className={buttonClass}>Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
