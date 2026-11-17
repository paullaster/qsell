import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccountSubpage } from '@/components/store/account/AccountSubpage';
import { MyGroupsClient } from '@/components/store/group/MyGroupsClient';
import { myGroupsAction } from '@/server/domains/pricing/package-group-actions';

export const metadata: Metadata = { title: 'My group orders', robots: { index: false, follow: false } };

export default function MyGroupsPage() {
  const groups = myGroupsAction();
  return (
    <AccountSubpage title="My group orders" intro="Group orders you started: who has chosen, and the order once you have placed it.">
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Loading your group orders…
          </p>
        }
      >
        <MyGroupsClient groups={groups} />
      </Suspense>
    </AccountSubpage>
  );
}
