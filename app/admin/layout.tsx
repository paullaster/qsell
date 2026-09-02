import { AdminShell } from '@/components/admin/AdminShell';

export default function AdminLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <AdminShell>
      {children}
      {modal}
    </AdminShell>
  );
}
