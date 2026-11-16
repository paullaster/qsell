import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccountSubpage } from '@/components/store/account/AccountSubpage';
import { MyQuoteRequestsClient } from '@/components/store/product/MyQuoteRequestsClient';
import { myQuoteRequestsAction } from '@/server/domains/pricing/package-quote-actions';

export const metadata: Metadata = { title: 'My quote requests', robots: { index: false, follow: false } };

export default function MyQuoteRequestsPage() {
  const requests = myQuoteRequestsAction();
  return (
    <AccountSubpage title="My quote requests" intro="Quotes you asked for on the shop, and where each one stands.">
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Loading your quote requests…
          </p>
        }
      >
        <MyQuoteRequestsClient requests={requests} />
      </Suspense>
    </AccountSubpage>
  );
}
