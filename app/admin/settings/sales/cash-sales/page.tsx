import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { TillSettingsClient } from '@/components/admin/settings/sales/TillSettingsClient';
import { tillSettingsScreenAction } from '@/server/domains/selling/cash-sales/till-actions';

export const metadata: Metadata = { title: 'Cash Sales settings' };

export default function CashSalesSettingsPage() {
  const first = tillSettingsScreenAction();
  return (
    <SettingsFrame label="cash sales settings">
      <TillSettingsClient firstPromise={first} />
    </SettingsFrame>
  );
}
