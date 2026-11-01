import type { Metadata } from 'next';
import { stockMatrixAction } from '@/server/domains/stock/matrix-actions';
import { StockMatrixClient } from '@/components/admin/stock/StockMatrixClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export const metadata: Metadata = { title: 'Stock by location' };

export default function StockByLocationPage() {
  const firstPage = stockMatrixAction({});
  return (
    <SettingsFrame label="stock by location">
      <StockMatrixClient firstPage={firstPage} />
    </SettingsFrame>
  );
}
