'use server';

import { getContainer } from '@/server/di/container';
import { idOf, objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'BAD_INPUT' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/costs', '/admin/delivery/deliveries'];

/** What riders are paid. */
export async function payRulesAction() {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCosts.pay(ctx.companyId));
}

export async function setPayRulesAction(raw: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => dataOf(await getContainer().deliveryCosts.setPay({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** Costs, newest first. */
export async function costsPageAction(raw?: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCosts.list(ctx.companyId, objectOf(raw)));
}

/** The costs of one delivery, for its screen. Read with the delivery permission so the people who see the delivery see what it cost. */
export async function deliveryCostsAction(deliveryId: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCosts.forDelivery(ctx.companyId, idOf(deliveryId, 'delivery')));
}

/** What a courier charged for a delivery. */
export async function recordCourierChargeAction(raw: unknown) {
  return await runDelivery(
    'delivery_costs:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryCosts.recordCourier({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.deliveryId, 'delivery'), i));
    },
    PATHS,
  );
}

/** Fuel, a vehicle cost or another cost of running the fleet. */
export async function recordRunningCostAction(raw: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => dataOf(await getContainer().deliveryCosts.recordRunning({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** Takes a cost back, with a reason. */
export async function reverseCostAction(raw: unknown) {
  return await runDelivery(
    'delivery_costs:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return dataOf(await getContainer().deliveryCosts.reverse({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.costId, 'cost'), i));
    },
    PATHS,
  );
}

// ── The books and paying riders ──────────────────────────────────────────────────────────────────────────────────────

/** Where rider pay is booked, how much is waiting to be posted, what is owed to each rider, and the ways to pay. */
export async function costBooksAction() {
  return await runDelivery('delivery_costs:manage', async (ctx) => {
    const c = getContainer();
    const [accounts, owed, unposted] = await Promise.all([c.deliveryCostBooks.accounts(ctx.companyId), c.deliveryCostBooks.owed(ctx.companyId), c.deliveryCostBooks.unposted(ctx.companyId)]);
    return { accounts, owed, unposted };
  });
}

export async function setCostAccountsAction(raw: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => dataOf(await getContainer().deliveryCostBooks.setAccounts({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** Posts what is waiting now, instead of at the next minute. */
export async function postCostsNowAction() {
  return await runDelivery('delivery_costs:manage', async () => await getContainer().deliveryCostBooks.processDue(500), PATHS);
}

/** Pays a rider everything that is owed to them. */
export async function payRiderAction(raw: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => dataOf(await getContainer().deliveryCostBooks.pay({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

export async function payoutsPageAction(raw?: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => await getContainer().deliveryCostBooks.payouts(ctx.companyId, objectOf(raw)));
}

/** What delivery earned and cost over a stretch of days, and the cash riders hold now. */
export async function deliveryReportAction(raw?: unknown) {
  return await runDelivery('delivery_costs:manage', async (ctx) => {
    const c = getContainer();
    const i = objectOf(raw);
    const [report, held] = await Promise.all([c.deliveryReports.summary(ctx.companyId, i), c.doorPayments.balances(ctx.companyId, new Date().toISOString().slice(0, 10))]);
    return { ...dataOf(report), cashHeld: held.filter((h) => Number(h.balance) !== 0).map((h) => ({ riderId: h.riderId, name: h.name, balance: h.balance })) };
  });
}
