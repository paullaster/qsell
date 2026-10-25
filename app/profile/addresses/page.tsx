import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccountSubpage } from '@/components/store/account/AccountSubpage';
import { AddressesClient } from '@/components/store/account/AddressesClient';
import { myAddressesAction } from '@/server/domains/customers/actions';

export const metadata: Metadata = {
  title: 'My addresses',
  robots: { index: false, follow: false },
};

export default function AddressesPage() {
  const first = myAddressesAction();
  return (
    <AccountSubpage title="My addresses" intro="Where we deliver your orders.">
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Loading your addresses…
          </p>
        }
      >
        <AddressesClient first={first} />
      </Suspense>
    </AccountSubpage>
  );
}
