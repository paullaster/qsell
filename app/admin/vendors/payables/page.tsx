import { Suspense } from 'react';
import { advancesOutstandingAction, ageingAction, lastPayablesRevaluationAction, payablesCheckAction } from '@/server/domains/vendors/payment-actions';
import { PayablesClient } from '@/components/admin/vendors/PayablesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = ageingAction();
  const check = payablesCheckAction();
  const revaluation = lastPayablesRevaluationAction();
  const advances = advancesOutstandingAction();
  return (
    <Suspense fallback={<PageSkeleton label="what we owe" />}>
      <PayablesClient initialPromise={initial} checkPromise={check} revaluationPromise={revaluation} advancesPromise={advances} />
    </Suspense>
  );
}
