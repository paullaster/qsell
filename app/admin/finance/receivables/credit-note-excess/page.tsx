import { creditNoteExcessWorklistAction } from '@/server/domains/finance/credit-note-actions';
import { CreditNoteExcessClient } from '@/components/admin/finance/CreditNoteExcessClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminCreditNoteExcessPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await creditNoteExcessWorklistAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <CreditNoteExcessClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
