import type { Metadata } from 'next';
import { stockCountsPageAction } from '@/server/domains/stock/count-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { CountsClient } from '@/components/admin/stock/CountsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Stock counts' };

export default function StockCountsPage() {
  const firstPage = stockCountsPageAction({});
  const canCount = canPermission('stock:count');
  return (
    <SettingsFrame label="stock counts">
      <CountsClient firstPage={firstPage} canCount={canCount} />
    </SettingsFrame>
  );
}
