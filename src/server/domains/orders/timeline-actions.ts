'use server';

import { AccessDeniedError, requirePermission } from '@/server/domains/access-control/guard';
import { drizzleDb } from '@/server/db/drizzle/client';
import { getContainer } from '@/server/di/container';
import { customerOrderTimeline, orderFlow, orderTimeline, type OrderFlow, type OrderTimelineView } from './timeline-read';

type Result<T> = { ok: true; data: T } | { ok: false; error: string; forbidden?: true };

/** Every stage of an order with its time. Anyone who may see orders sees the stages and times; who did it and why needs `orders:timeline`. */
export async function orderTimelineAction(orderId: unknown): Promise<Result<OrderTimelineView>> {
  try {
    await requirePermission('orders:read');
    if (typeof orderId !== 'string' || orderId.length === 0 || orderId.length > 100) return { ok: false, error: 'That order could not be found.' };
    const detailed = await requirePermission('orders:timeline').then(
      () => true,
      (error: unknown) => {
        if (error instanceof AccessDeniedError) return false;
        throw error;
      },
    );
    const view = await orderTimeline(drizzleDb, orderId, detailed);
    return view === null ? { ok: false, error: 'That order could not be found.' } : { ok: true, data: view };
  } catch (error) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    console.error('[orders] timeline', error);
    return { ok: false, error: 'The timeline could not be loaded just now.' };
  }
}

/** The funnel, failures and stuck orders. Needs `orders:timeline`. */
export async function orderFlowAction(days: unknown): Promise<Result<OrderFlow>> {
  try {
    await requirePermission('orders:timeline');
    const span = typeof days === 'number' && Number.isFinite(days) ? Math.min(90, Math.max(1, Math.trunc(days))) : 7;
    const company = await getContainer().companySettings.ensureSeeded();
    const { targets } = await getContainer().orderSla.settings(company.id);
    return { ok: true, data: await orderFlow(drizzleDb, span, new Date(), targets) };
  } catch (error) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'You do not have permission to do that.', forbidden: true };
    console.error('[orders] flow', error);
    return { ok: false, error: 'The order flow could not be loaded just now.' };
  }
}

/** Public: the stages of an order for someone who knows its number and the phone or email it was placed with. Nothing but plain stages and times. */
export async function trackedOrderTimelineAction(raw: unknown): Promise<Result<{ label: string; at: string }[]>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const { orderNumber, contact } = input;
  if (typeof orderNumber !== 'string' || typeof contact !== 'string' || orderNumber.length > 60 || contact.length > 254) return { ok: false, error: 'That order could not be found.' };
  try {
    const order = await getContainer().orders.findByNumberAndContact(orderNumber, contact);
    if (order === null) return { ok: false, error: 'That order could not be found.' };
    return { ok: true, data: await customerOrderTimeline(drizzleDb, order.id) };
  } catch (error) {
    console.error('[orders] tracked timeline', error);
    return { ok: false, error: 'The order could not be checked just now.' };
  }
}
