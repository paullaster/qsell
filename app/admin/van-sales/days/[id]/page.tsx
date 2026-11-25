import type { Metadata } from 'next';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { DayDetailClient } from '@/components/admin/van-sales/DayDetailClient';
import { MissingAs404 } from '@/components/ui/missing-record';
import { dayScreenAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'Van day' };

export default function DayPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => dayScreenAction(id));
  return (
    <SettingsFrame label="the van day">
      <MissingAs404 result={view}>
        <DayDetailClient viewPromise={view} />
      </MissingAs404>
    </SettingsFrame>
  );
}
