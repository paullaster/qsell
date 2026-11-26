/**
 * Drops: pre-sold orders delivered from the van on a van day (docs/architecture/van-sales.md §4.6). The rules for planning one, in words. Pure.
 */
import { roundQty } from '@/lib/decimal';

export const DROP_STATES = ['planned', 'delivered', 'partly', 'refused', 'failed'] as const;
export type DropState = (typeof DROP_STATES)[number];
export const DROP_STATE_WORDS: Record<DropState, string> = { planned: 'To deliver', delivered: 'Delivered', partly: 'Part delivered', refused: 'Refused', failed: 'Not delivered' };

/** Where an order's stock is, for a drop: on the shelf at the warehouse, sent with the load, held on the van, or not there. */
export const DROP_STOCK = ['at_warehouse', 'on_the_way', 'on_van', 'short'] as const;
export type DropStock = (typeof DROP_STOCK)[number];
export const DROP_STOCK_WORDS: Record<DropStock, string> = {
  at_warehouse: 'At the warehouse, not loaded yet',
  on_the_way: 'On its way to the van',
  on_van: 'On the van',
  short: 'Not on the van: the load came short',
};

export const readDropState = (value: string): DropState => DROP_STATES.find((s) => s === value) ?? 'planned';
export const readDropStock = (value: string): DropStock => DROP_STOCK.find((s) => s === value) ?? 'at_warehouse';

/** The orders that cannot be delivered: closed, or already delivered. */
const CLOSED_ORDER = ['cancelled', 'refunded', 'failed', 'delivered', 'completed'];

export interface DropFacts {
  dayStatus: string;
  /** The day has a van and its route takes both kinds of work. */
  vanAndOrders: boolean;
  order: {
    number: string;
    salesModule: string;
    status: string;
    approvalStatus: string | null;
    /** The customer is on the day's visits. */
    customerOnDay: boolean;
    /** How the order is to be delivered, if it has been planned: only own riders can be delivered by a rep. */
    deliveryMethod: string | null;
    alreadyOnADrop: boolean;
    hasLines: boolean;
    /** The order still holds stock at a place: stock already issued or given back cannot be carried on the van. */
    holdsStock: boolean;
  };
}

/** Why an order cannot be added to a day's deliveries, or null when it can. A day can take drops until it goes out. */
export function dropAddProblem(f: DropFacts): string | null {
  if (f.dayStatus !== 'planned' && f.dayStatus !== 'loading') return 'Deliveries are added before the day goes out, so they can be loaded.';
  if (!f.vanAndOrders) return 'Only a day with a van, on a route that sells from the van and takes orders, delivers orders from the van.';
  const o = f.order;
  if (o.salesModule !== 'sales_order') return `${o.number} is not a sales order, so it is not delivered from the van.`;
  if (CLOSED_ORDER.includes(o.status)) return `${o.number} is ${o.status === 'cancelled' ? 'cancelled' : 'closed'}, so there is nothing to deliver.`;
  if (o.approvalStatus === 'pending' || o.approvalStatus === 'rejected' || o.approvalStatus === 'draft') return `${o.number} is waiting for approval, so it cannot be delivered yet.`;
  if (!o.customerOnDay) return `The customer of ${o.number} is not on this day's visits. Add the customer to the visits first.`;
  if (o.deliveryMethod !== null && o.deliveryMethod !== 'own_fleet') return `${o.number} is set to be delivered another way, so it is not delivered from the van.`;
  if (o.alreadyOnADrop) return `${o.number} is already on a delivery.`;
  if (!o.hasLines) return `${o.number} has nothing on it to deliver.`;
  if (!o.holdsStock) return `${o.number} no longer holds stock at the warehouse (it was issued when it was paid, or given back), so it cannot be carried on the van. Set the stock to be issued at delivery, under Stock settings, for orders that go on a van.`;
  return null;
}

/** What the day's deliveries need loaded, per product: the lines of the orders still to be loaded. */
export function dropNeeds(lines: readonly { productId: string; quantity: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.productId, roundQty((out.get(l.productId) ?? 0) + l.quantity));
  return out;
}

/** Whether a drop can be taken off the day: only while its stock has not left the warehouse. */
export const dropRemovable = (state: DropState, stock: DropStock): boolean => state === 'planned' && stock === 'at_warehouse';

// ── Delivering at the visit ───────────────────────────────────────────────────────────────────────────────────

export interface DeliverFacts {
  dayStatus: string;
  visitStatus: string;
  state: DropState;
  stock: DropStock;
  customerName: string;
  orderNumber: string;
}

/** Why a delivery cannot be made, closed or refused now, or null when it can: the day is out, the rep is at the customer, the stock is on the van. */
export function deliverProblem(f: DeliverFacts, needsStock = true): string | null {
  if (f.dayStatus !== 'out') return 'Deliveries are made while the day is out on the route.';
  if (f.state !== 'planned') return `${f.orderNumber} has already been dealt with.`;
  if (f.visitStatus !== 'arrived') return `Arrive at ${f.customerName} before delivering to them.`;
  if (needsStock && f.stock !== 'on_van') return `${f.orderNumber} is not on the van, so it cannot be delivered. ${DROP_STOCK_WORDS[f.stock]}.`;
  return null;
}

/** Who received the goods: a name of 2 to 120 characters. */
export function readReceivedBy(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < 2) return { ok: false, error: 'Say who received the goods.' };
  if (name.length > 120) return { ok: false, error: 'Keep the name to 120 characters.' };
  return { ok: true, name };
}

export const CLOSE_STATES = ['refused', 'failed'] as const;
export type CloseState = (typeof CLOSE_STATES)[number];
