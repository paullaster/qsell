import type { Metadata } from 'next';
import { stockTransfersPageAction } from '@/server/domains/stock/transfer-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { TransfersClient } from '@/components/admin/stock/TransfersClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Stock transfers' };

export default function StockTransfersPage() {
  const firstPage = stockTransfersPageAction({});
  const canRequest = canPermission('stock:transfer_request');
  return (
    <SettingsFrame label="stock transfers">
      <TransfersClient firstPage={firstPage} canRequest={canRequest} />
    </SettingsFrame>
  );
}
