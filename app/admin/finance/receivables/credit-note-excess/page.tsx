import { creditNoteExcessWorklistAction } from '@/server/domains/finance/credit-note-actions';
import { CreditNoteExcessClient } from '@/components/admin/finance/CreditNoteExcessClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = creditNoteExcessWorklistAction();
  return (
    <FinancePage label="credit note excess">
      <CreditNoteExcessClient viewPromise={view} />
    </FinancePage>
  );
}
