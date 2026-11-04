import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RiderHome } from '@/components/rider/RiderHome';
import { RiderSkeleton } from '@/components/rider/RiderShell';
import { myRunsAction } from '@/server/domains/delivery/rider-app-actions';

export const metadata: Metadata = { title: 'My runs' };

export default function RiderPage() {
  const runs = myRunsAction();
  return (
    <Suspense fallback={<RiderSkeleton label="your runs" />}>
      <RiderHome runsPromise={runs} />
    </Suspense>
  );
}
