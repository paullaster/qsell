import { Suspense } from 'react';
import { creditNoteExcessWorklistAction } from '@/server/domains/finance/credit-note-actions';
import { CreditNoteExcessClient } from '@/components/admin/finance/CreditNoteExcessClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function Page() {

  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="credit note excess" />}>
          <CreditNoteExcessClient viewPromise={creditNoteExcessWorklistAction()} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
