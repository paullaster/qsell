'use server';

import { getContainer } from '@/server/di/container';
import { runStock } from './action-support';
import { StockError } from './errors';

const PATHS = ['/admin/inventory/ledger', '/admin/inventory'];

/** Where the company stands in moving to the new stock ledger. */
export async function stockLedgerStatusAction() {
  return await runStock('stock:cutover', async (ctx) => await getContainer().stockCutover.status(ctx.companyId));
}

export async function startStockShadowAction() {
  return await runStock('stock:cutover', async (ctx) => {
    await getContainer().stockCutover.start(ctx.companyId, ctx.userId);
    return { done: true };
  }, PATHS);
}

/** Compares the new ledger with the old counters now, and keeps the result. */
export async function checkStockLedgerAction() {
  return await runStock('stock:cutover', async (ctx) => await getContainer().stockCutover.check(ctx.companyId, 'manual', ctx.userId), PATHS);
}

/** The switch itself. Atomic: if the two sides differ, nothing changes. */
export async function switchStockLedgerOnAction() {
  return await runStock('stock:cutover', async (ctx) => await getContainer().stockCutover.switchToLedger(ctx.companyId, ctx.userId), PATHS);
}

export async function switchStockLedgerOffAction(reason: unknown) {
  return await runStock('stock:cutover', async (ctx) => {
    if (typeof reason !== 'string') throw new StockError('Say why you are going back to the old way.', 'REASON_NEEDED');
    await getContainer().stockCutover.rollback(ctx.companyId, ctx.userId, reason);
    return { done: true };
  }, PATHS);
}
