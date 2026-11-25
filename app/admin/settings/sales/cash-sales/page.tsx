import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { ReceiptHeadingSection } from '@/components/admin/settings/sales/ReceiptHeadingSection';
import { TillSettingsClient } from '@/components/admin/settings/sales/TillSettingsClient';
import { recordPrintScreenAction } from '@/server/domains/company/print-branding-actions';
import { tillSettingsScreenAction } from '@/server/domains/selling/cash-sales/till-actions';

export const metadata: Metadata = { title: 'Cash Sales settings' };

export default function CashSalesSettingsPage() {
  const first = tillSettingsScreenAction();
  const receipt = recordPrintScreenAction('cash_sale');
  return (
    <SettingsFrame label="cash sales settings">
      <div className="space-y-5">
        <TillSettingsClient firstPromise={first} />
        <SettingsFrame label="receipt heading">
          <ReceiptHeadingSection promise={receipt} record="cash_sale" />
        </SettingsFrame>
      </div>
    </SettingsFrame>
  );
}
