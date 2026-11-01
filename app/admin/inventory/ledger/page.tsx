import type { Metadata } from 'next';
import { stockLedgerStatusAction } from '@/server/domains/stock/cutover-actions';
import { StockLedgerClient } from '@/components/admin/stock/StockLedgerClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Stock ledger' };

export default function StockLedgerPage() {
  return (
    <SettingsFrame label="the stock ledger">
      <StockLedgerClient statusPromise={stockLedgerStatusAction()} />
    </SettingsFrame>
  );
}
