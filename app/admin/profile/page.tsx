import { getSessionAction } from '@/server/domains/auth/actions';
import { AdminProfileClient } from '@/components/admin/AdminProfileClient';

export default async function AdminProfilePage() {
  const sessionPromise = getSessionAction();
  
  return <AdminProfileClient sessionPromise={sessionPromise as any} />;
}
