import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AdminShell } from '@/components/admin/AdminShell';
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

  const { superAdmin, permissions } = await myAccessSnapshot();

  return (
    <AdminShell access={{ superAdmin, permissions }}>
      {children}
      {modal}
      {create}
    </AdminShell>
  );
}
