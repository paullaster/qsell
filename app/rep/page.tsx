import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RepHome } from '@/components/rep/RepHome';
import { RepSkeleton } from '@/components/rep/RepShell';
import { myDaysAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'My days' };

export default function RepPage() {
  const days = myDaysAction();
  return (
    <Suspense fallback={<RepSkeleton label="your days" />}>
      <RepHome daysPromise={days} />
    </Suspense>
  );
}
