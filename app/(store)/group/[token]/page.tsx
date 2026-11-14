import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GroupOrderClient } from '@/components/store/group/GroupOrderClient';
import { groupViewAction } from '@/server/domains/pricing/package-group-actions';
import { isWellFormedGroupToken } from '@/lib/group-order';

export const metadata: Metadata = { title: 'Group order', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * A group order, by the link its organiser shared. A link that cannot be one of ours is turned away before anything is read; what is
 * shown is read after, with the page already on its way (the group's answer streams in behind the heading).
 */
export default async function GroupOrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isWellFormedGroupToken(token)) notFound();
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-8">
      <GroupOrderClient token={token} viewPromise={groupViewAction(token)} />
    </main>
  );
}
