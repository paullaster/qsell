import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { isStaffRole } from '@/server/domains/auth/roles';

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
  if (!isStaffRole(session?.user.role)) {
    redirect('/login?callbackUrl=%2Fadmin');
  }
  if (session?.user.mustChangePassword === true) {
    redirect('/change-password?callbackUrl=%2Fadmin');
  }

  return (
    <AdminShell>
      {children}
      {modal}
      {create}
    </AdminShell>
  );
}
