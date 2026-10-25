import { Suspense } from 'react';
import { creditableInvoicesAction } from '@/server/domains/vendors/credit-memo-portal-actions';
import { CreditStartClient } from '@/components/vendor/CreditStartClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const invoices = creditableInvoicesAction();
  return (
    <Suspense fallback={<PageSkeleton label="your invoices" />}>
      <CreditStartClient invoicesPromise={invoices} />
    </Suspense>
  );
}
