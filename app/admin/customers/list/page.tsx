import { canPermission } from '@/server/domains/access-control/guard';
import {
  customerFieldsAction,
  customersPageAction,
} from '@/server/domains/customers/manage-actions';
import { AdminCustomersClient } from '@/components/admin/AdminCustomersClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function Page() {
  return (
    <SettingsFrame label="customers">
      <AdminCustomersClient
        fieldsPromise={customerFieldsAction()}
        firstPage={customersPageAction({})}
        canEditPromise={canPermission('customers:update')}
        canReceivePromise={canPermission('receipts:create')}
      />
    </SettingsFrame>
  );
}
