'use client';

import { use } from 'react';
import type { trialBalanceAction } from '@/server/domains/finance/actions';
import { TrialBalanceClient } from './TrialBalanceClient';

/** Waits for the year in force, then hands its dates and the report to the screen. */
export function TrialBalanceHost({ range, report }: { range: Promise<{ from: string; to: string }>; report: ReturnType<typeof trialBalanceAction> }) {
  const { from, to } = use(range);
  return <TrialBalanceClient initialPromise={report} from={from} to={to} />;
}
