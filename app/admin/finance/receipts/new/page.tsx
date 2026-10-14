import { Suspense } from 'react';
import { receiptFormOptionsAction, receiptPresetCustomerAction } from '@/server/domains/finance/receivables/actions';
import { walletFormOptionsAction } from '@/server/domains/finance/wallet-actions';
import { NewReceiptClient } from '@/components/admin/finance/NewReceiptClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function AdminNewReceiptPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  // Arriving from a customer's statement (?customer=<their number>): that customer is already chosen.
  const { customer } = await searchParams;
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the receipt form" />}>
          <NewReceiptClient
            optionsPromise={receiptFormOptionsAction()}
            presetPromise={customer === undefined || customer === '' ? null : receiptPresetCustomerAction(customer)}
            walletPromise={walletFormOptionsAction()}
          />
        </Suspense>
      )}
    </FinanceGate>
  );
}
