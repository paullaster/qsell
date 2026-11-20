import { notFound } from 'next/navigation';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminCustomerEditClient } from '@/components/admin/AdminCustomersClient';
import {
  customerCardAction,
  customerFieldsAction,
} from '@/server/domains/customers/manage-actions';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canPermission('customers:update'))) notFound();
  const cardPromise = customerCardAction(id);

  return (
    <SettingsFrame label="customer">
      <MissingAs404 result={cardPromise}>
        <AdminCustomerEditClient
          fieldsPromise={customerFieldsAction()}
          canEditPromise={Promise.resolve(true)}
          cardPromise={cardPromise}
        />
      </MissingAs404>
    </SettingsFrame>
  );
}
