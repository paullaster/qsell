'use server';

import { and, asc, eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { orderItems, stockLocations, stockReservations } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { canPermission } from '@/server/domains/access-control/guard';
import { idOf, runStock } from './action-support';
import { StockError } from './errors';

export interface OrderStockHold {
  id: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  quantity: number;
  consumed: number;
  released: number;
  state: string;
  createdAt: string;
  stateChangedAt: string;
  expiresAt: string | null;
  reason: string | null;
  /** Why this location, in words. */
  why: string | null;
}

export interface OrderStockLine {
  productId: string;
  productName: string;
  ordered: number;
  holds: OrderStockHold[];
}

export interface OrderStockView {
  /** Whether the new stock ledger is the truth: without it nothing is held per location and there is nothing to show. */
  ledgerOn: boolean;
  lines: OrderStockLine[];
  may: { resource: boolean };
}

const WHY: Record<string, string> = {
  whole_order_at_one_location: 'The whole order could come from here',
  line_at_one_location: 'This product could come from here',
  line_split_across_locations: 'No single place had enough, so it was split',
  re_sourced: 'Moved here by a person',
};

function whyOf(sourcing: Record<string, unknown>): string | null {
  const rule = typeof sourcing.rule === 'string' ? sourcing.rule : '';
  const base = WHY[rule] ?? null;
  const from = Array.isArray(sourcing.from) ? sourcing.from.filter((x): x is string => typeof x === 'string') : [];
  const why = typeof sourcing.reason === 'string' ? sourcing.reason : '';
  if (rule === 're_sourced') return `${base ?? ''}${from.length > 0 ? `, from ${from.join(', ')}` : ''}${why === '' ? '' : `: ${why}`}`;
  return base;
}

/** Where each line of an order is held, and the life of each hold. */
export async function orderStockAction(orderId: unknown) {
  return await runStock('stock:read', async (ctx): Promise<OrderStockView> => {
    if (typeof orderId !== 'string' || orderId === '' || orderId.length > 100) throw new StockError('That order could not be found.', 'NOT_FOUND');
    const ledgerOn = (await getContainer().stockSettings.get()).ledgerMode;
    const items = await drizzleDb.select({ productId: orderItems.productId, name: orderItems.productName, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, orderId));
    const holds = await drizzleDb
      .select({ h: stockReservations, code: stockLocations.code, name: stockLocations.name })
      .from(stockReservations)
      .innerJoin(stockLocations, eq(stockLocations.id, stockReservations.locationId))
      .where(and(eq(stockReservations.companyId, ctx.companyId), eq(stockReservations.refType, 'order'), eq(stockReservations.refId, orderId)))
      .orderBy(asc(stockReservations.createdAt), asc(stockReservations.id));
    const resource = await canPermission('orders:update');
    const lines: OrderStockLine[] = items.map((i) => ({
      productId: i.productId,
      productName: i.name,
      ordered: i.quantity,
      holds: holds
        .filter((x) => x.h.productId === i.productId)
        .map((x) => ({
          id: x.h.id,
          locationId: x.h.locationId,
          locationCode: x.code,
          locationName: x.name,
          quantity: x.h.quantity,
          consumed: x.h.consumed,
          released: x.h.released,
          state: x.h.state,
          createdAt: x.h.createdAt.toISOString(),
          stateChangedAt: x.h.stateChangedAt.toISOString(),
          expiresAt: x.h.expiresAt?.toISOString() ?? null,
          reason: x.h.reason,
          why: whyOf(x.h.sourcing),
        })),
    }));
    return { ledgerOn, lines, may: { resource } };
  });
}

/** Takes an order's stock for one product from another location, before it is picked. Needs the right to change the order. */
export async function resourceOrderStockAction(orderId: unknown, productId: unknown, toLocationId: unknown, reason: unknown) {
  return await runStock('orders:update', async (ctx) => {
    if (typeof orderId !== 'string' || orderId === '' || orderId.length > 100) throw new StockError('That order could not be found.', 'NOT_FOUND');
    if (typeof productId !== 'string' || productId === '' || productId.length > 100) throw new StockError('That product is not on the order.', 'NOT_FOUND');
    return await getContainer().stockReservations.resource({
      companyId: ctx.companyId,
      refType: 'order',
      refId: orderId,
      productId,
      toLocationId: idOf(toLocationId, 'location'),
      reason: typeof reason === 'string' ? reason : '',
      actor: ctx.userId,
    });
  }, ['/admin/orders']);
}

