import type { Metadata } from 'next';
import { stockLocationsPageAction } from '@/server/domains/stock/location-actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { StockLocationsClient } from '@/components/admin/stock/StockLocationsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Stock locations' };

export default function StockLocationsPage() {
  // Both start now and run side by side; the frame shows at once.
  const firstPage = stockLocationsPageAction({});
  const canManage = canPermission('stock:locations_manage');
  return (
    <SettingsFrame label="stock locations">
      <StockLocationsClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
