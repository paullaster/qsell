'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type { PaymentCallbackEventRow } from '@/server/db/drizzle/schema';

/**
 * Callback dumps that still have no verdict (unclassified or errored while
 * being classified). The admin classifies them by hand — never automatically.
 */
export async function listCallbackEventsRequiringReviewAction(
  limit = 50,
): Promise<PaymentCallbackEventRow[]> {
  await requirePermission('transactions:read');
  return await getContainer().paymentCallbacks.listRequiringReview(limit);
}

/**
 * Re-run the provider adapter on a stored dump to decide success vs failure.
 */
export async function classifyCallbackEventAction(
  eventId: string,
): Promise<PaymentCallbackEventRow> {
  await requirePermission('transactions:reconcile');
  const row = await getContainer().paymentCallbacks.classify(eventId);
  revalidatePath('/admin/transactions/reconcile');
  return row;
}