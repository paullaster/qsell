import { canPermission } from '@/server/domains/access-control/guard';
import { VendorCreateModal } from '@/components/admin/vendors/VendorCreateModal';

export default async function VendorCreatePage() {
  // A security decision, so it is settled before the form is drawn.
  return <VendorCreateModal presentation="page" canActivate={await canPermission('vendors:create_active')} />;
}
