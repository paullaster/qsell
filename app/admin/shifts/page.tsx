import type { Metadata } from 'next';
import { ShiftsClient } from '@/components/admin/shifts/ShiftsClient';
import { shiftsScreenAction } from '@/server/domains/selling/shifts/shift-actions';

export const metadata: Metadata = { title: 'Shifts' };

export default function ShiftsPage() {
  // The screen loads while it is drawn; the client reads it with use() inside Suspense.
  const first = shiftsScreenAction();
  return <ShiftsClient firstPromise={first} />;
}
