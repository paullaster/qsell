'use client';

import { use, type ReactNode } from 'react';
import type { TrackedOrder } from '@/lib/tracking-view';
import { TrackingView } from './TrackingView';

/** Reads the order's tracking data as it arrives, so the page itself is not held up by it. */
export function TrackingLoader({ order, heading }: { order: Promise<TrackedOrder | null>; heading?: ReactNode }) {
  const found = use(order);
  if (found === null) {
    return (
      <p role="alert" className="rounded-xl border border-line bg-surface-raised p-4 text-sm text-fg">
        This order could not be found.
      </p>
    );
  }
  return <TrackingView order={found} heading={heading} />;
}
