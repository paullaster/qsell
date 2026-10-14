import { Suspense, type ReactNode } from 'react';
import { financeOverviewAction } from '@/server/domains/finance/actions';
import { FinanceSetupCard } from './FinanceSetupCard';
import { LoadFailed, PageSkeleton } from './ui';

type Overview = Extract<Awaited<ReturnType<typeof financeOverviewAction>>, { ok: true }>['data'];

/**
 * Wraps every finance screen: shows the reason when the user may not see it, and the one-time
 * setup (choose a chart of accounts) until finance has been set up.
 */
export async function FinanceGate({ children }: { children: (overview: Overview) => Promise<ReactNode> | ReactNode }) {
  const overview = await financeOverviewAction();
  if (!overview.ok) return <LoadFailed error={overview.error} />;
  if (!overview.data.setUp) {
    return <FinanceSetupCard templates={overview.data.templates} canApply={overview.data.can.applyTemplate} />;
  }
  return await children(overview.data);
}

/**
 * A finance screen's frame. It returns at once with a loading state for this screen; the gate's
 * check and the screen's own data (started by the page before this renders, so they run side by
 * side, not one after the other) fill it in as they arrive.
 */
export function FinancePage({ label, children }: { label: string; children: ReactNode | ((overview: Overview) => ReactNode) }) {
  return (
    <Suspense fallback={<PageSkeleton label={label} />}>
      <FinanceGate>{(overview) => (typeof children === 'function' ? children(overview) : children)}</FinanceGate>
    </Suspense>
  );
}
