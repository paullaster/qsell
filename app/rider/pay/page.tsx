import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RiderPayScreen } from '@/components/rider/RiderPayScreen';
import { RiderSkeleton } from '@/components/rider/RiderShell';
import { myPayAction } from '@/server/domains/delivery/rider-app-actions';

export const metadata: Metadata = { title: 'My pay' };

export default function RiderPayPage() {
  const pay = myPayAction();
  return (
    <Suspense fallback={<RiderSkeleton label="your pay" />}>
      <RiderPayScreen payPromise={pay} />
    </Suspense>
  );
}
