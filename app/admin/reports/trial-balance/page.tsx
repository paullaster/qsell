import { Suspense } from 'react';
import { listFiscalAction, trialBalanceAction } from '@/server/domains/finance/actions';
import { TrialBalanceHost } from '@/components/admin/finance/TrialBalanceHost';
import { FinancePage } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';
import { trialBalanceRange } from '@/lib/ledger-forms';
import { businessDate } from '@/server/kernel/numbering/business-date';

export default function AdminTrialBalancePage() {
  const today = businessDate();
  // The range depends on the fiscal years, so the report starts as soon as they are known; the page itself does not wait.
  const range = listFiscalAction().then((years) => (years.ok ? trialBalanceRange(years.data, today) : { from: today, to: today }));
  const report = range.then(({ from, to }) => trialBalanceAction(from, to));
  return (
    <FinancePage label="the trial balance">
      <Suspense fallback={<PageSkeleton label="the trial balance" />}>
        <TrialBalanceHost range={range} report={report} />
      </Suspense>
    </FinancePage>
  );
}
