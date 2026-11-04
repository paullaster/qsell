import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RiderRunScreen } from '@/components/rider/RiderRunScreen';
import { RiderSkeleton } from '@/components/rider/RiderShell';
import { MissingAs404 } from '@/components/ui/missing-record';
import { myRunAction } from '@/server/domains/delivery/rider-app-actions';

export const metadata: Metadata = { title: 'Run' };

export default function RiderRunPage({ params }: { params: Promise<{ id: string }> }) {
  const run = params.then(({ id }) => myRunAction(id));
  return (
    <Suspense fallback={<RiderSkeleton label="the run" />}>
      <MissingAs404 result={run}>
        <RiderRunScreen runPromise={run} />
      </MissingAs404>
    </Suspense>
  );
}
