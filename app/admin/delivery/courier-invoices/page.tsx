import type { Metadata } from 'next';
import { CourierInvoicesClient } from '@/components/admin/delivery/CourierInvoicesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { courierInvoicesScreenAction } from '@/server/domains/delivery/courier-invoice-actions';

export const metadata: Metadata = { title: 'Courier invoices' };

export default function CourierInvoicesPage() {
  const first = courierInvoicesScreenAction();
  return (
    <SettingsFrame label="the courier invoices">
      <CourierInvoicesClient firstPromise={first} />
    </SettingsFrame>
  );
}
