import { customerSetupAction } from '@/server/domains/customers/master-actions';
import { AdminCustomersClient } from '@/components/admin/AdminCustomersClient';

export default function Page() {
  return <AdminCustomersClient setupPromise={customerSetupAction()} />;
}
