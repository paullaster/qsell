import { AdminShell } from '@/components/admin/AdminShell';
import { ensureAdminSessionAction } from '@/server/domains/auth/actions';

export default async function AdminLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  await ensureAdminSessionAction();

  return (
    <AdminShell>
      {children}
      {modal}
    </AdminShell>
  );
}
