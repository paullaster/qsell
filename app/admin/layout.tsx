import { AdminShell } from '@/components/admin/AdminShell';

export default function AdminLayout({
  children,
  modal,
  create,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  create: React.ReactNode;
}) {
  return (
    <AdminShell>
      {children}
      {modal}
      {create}
    </AdminShell>
  );
}
