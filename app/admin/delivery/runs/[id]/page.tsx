import type { Metadata } from 'next';
import { RunDetailClient } from '@/components/admin/delivery/RunDetailClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';
import { runAction } from '@/server/domains/delivery/run-actions';

export const metadata: Metadata = { title: 'Delivery run' };

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => runAction(id));
  return (
    <SettingsFrame label="the run">
      <MissingAs404 result={view}>
        <RunDetailClient viewPromise={view} />
      </MissingAs404>
    </SettingsFrame>
  );
}
