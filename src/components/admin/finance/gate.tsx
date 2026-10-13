import type { ReactNode } from 'react';
import { financeOverviewAction } from '@/server/domains/finance/actions';
import { FinanceSetupCard } from './FinanceSetupCard';
import { LoadFailed } from './ui';

/**
 * Wraps every finance screen: shows the reason when the user may not see it, and the one-time
 * setup (choose a chart of accounts) until finance has been set up.
 */
export async function FinanceGate({
  children,
}: {
  children: (overview: Extract<Awaited<ReturnType<typeof financeOverviewAction>>, { ok: true }>['data']) => Promise<ReactNode> | ReactNode;
}) {
  const overview = await financeOverviewAction();
  if (!overview.ok) return <LoadFailed error={overview.error} />;
  if (!overview.data.setUp) {
    return <FinanceSetupCard templates={overview.data.templates} canApply={overview.data.can.applyTemplate} />;
  }
  return <>{await children(overview.data)}</>;
}
