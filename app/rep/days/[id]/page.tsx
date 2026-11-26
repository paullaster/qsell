import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RepDayClient } from '@/components/rep/RepDayClient';
import { RepSkeleton } from '@/components/rep/RepShell';
import { MissingAs404 } from '@/components/ui/missing-record';
import { dayScreenAction } from '@/server/domains/van-sales/actions';

export const metadata: Metadata = { title: 'My day' };

export default function RepDayPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => dayScreenAction(id));
  return (
    <Suspense fallback={<RepSkeleton label="your day" />}>
      <MissingAs404 result={view}>
        <RepDayClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
