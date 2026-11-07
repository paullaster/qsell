import type { Metadata } from 'next';
import { DeliveryCostsClient } from '@/components/admin/delivery/DeliveryCostsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { payRulesAction } from '@/server/domains/delivery/cost-actions';

export const metadata: Metadata = { title: 'Delivery costs' };

export default function DeliveryCostsPage() {
  const rules = payRulesAction();
  return (
    <SettingsFrame label="delivery costs">
      <DeliveryCostsClient rulesPromise={rules} />
    </SettingsFrame>
  );
}
