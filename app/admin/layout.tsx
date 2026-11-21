import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { BusinessTimeZoneProvider } from '@/components/business-time';
import { getContainer } from '@/server/di/container';
import { myAccessSnapshot } from '@/server/domains/access-control/guard';

/** The console is never listed by search engines. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Defence in depth behind proxy.ts: never render the admin shell for a
 * non-staff session, even if a request reaches here without passing the proxy.
 * Server actions carry their own permission guards.
 */
export default async function AdminLayout({
  children,
  modal,
  create,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  create: React.ReactNode;
}) {
  const session = await auth();
  if (session?.user.isStaff !== true) {
    redirect('/login?callbackUrl=%2Fadmin');
  }
  if (session?.user.mustChangePassword === true) {
    redirect('/change-password?callbackUrl=%2Fadmin');
  }

  // The company row is read once for the whole request (the pages below reuse it), and says which time zone every time on screen is written in.
  const [{ superAdmin, permissions }, company] = await Promise.all([myAccessSnapshot(), getContainer().companySettings.ensureSeeded()]);

  return (
    <BusinessTimeZoneProvider timeZone={company.timezone}>
      <AdminShell access={{ superAdmin, permissions }}>
        {children}
        {modal}
        {create}
      </AdminShell>
    </BusinessTimeZoneProvider>
  );
}
