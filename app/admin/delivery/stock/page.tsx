import type { Metadata } from 'next';
import { StockTimingClient } from '@/components/admin/delivery/StockTimingClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { stockTimingAction } from '@/server/domains/delivery/document-actions';

export const metadata: Metadata = { title: 'Stock timing' };

export default function StockTimingPage() {
  const view = stockTimingAction();
  return (
    <SettingsFrame label="stock timing">
      <StockTimingClient viewPromise={view} />
    </SettingsFrame>
  );
}
