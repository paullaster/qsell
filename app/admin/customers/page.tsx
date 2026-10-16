import { customerFieldsAction, customersPageAction } from '@/server/domains/customers/manage-actions';
import { AdminCustomersClient } from '@/components/admin/AdminCustomersClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function Page() {
  // Nothing is awaited here: the dimension fields and the first page of customers start together.
  return (
    <SettingsFrame label="customers">
      <AdminCustomersClient fieldsPromise={customerFieldsAction()} firstPage={customersPageAction({})} />
    </SettingsFrame>
  );
}
