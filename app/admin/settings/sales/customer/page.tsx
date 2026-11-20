import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { CustomerCreditSettingsClient } from '@/components/admin/settings/sales/CustomerCreditSettingsClient';
import { customerCreditSettingsScreenAction } from '@/server/domains/customers/credit-settings-actions';

export const metadata: Metadata = { title: 'Customer credit' };

export default function CustomerCreditSettingsPage() {
  const first = customerCreditSettingsScreenAction();
  return (
    <SettingsFrame label="customer credit settings">
      <CustomerCreditSettingsClient firstPromise={first} />
    </SettingsFrame>
  );
}
