import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { SalesOrderInput, SalesOrderLineInput } from './domain/sales-order-input';
import type { PlacedKind } from './sales-order-service';

/** The documents staff take by hand and the permissions that let a person change a price or give a discount on them. */
export type StaffDocument = Exclude<PlacedKind, 'pos_cash_sale'>;
const RIGHTS: Record<StaffDocument, { price: 'sales_orders:price' | 'credit_sales:price' | 'sales_invoices:price'; discount: 'sales_orders:discount' | 'credit_sales:discount' | 'sales_invoices:discount' }> = {
  sales_order: { price: 'sales_orders:price', discount: 'sales_orders:discount' },
  credit_sale: { price: 'credit_sales:price', discount: 'credit_sales:discount' },
  sales_invoice: { price: 'sales_invoices:price', discount: 'sales_invoices:discount' },
};

export interface LineRights {
  canPrice: boolean;
  canDiscount: boolean;
  /** The person may give discounts, but the company has not switched them on for their branch: the screen says so instead of hiding the control without a word. */
  discountSwitchedOff: boolean;
}

/** What this person may do to a line of this document: the permission for each, and for a discount also the company's setting for their branch. */
export async function lineRights(kind: StaffDocument, companyId: string, userId: string): Promise<LineRights> {
  const [canPrice, hasDiscount] = await Promise.all([canPermission(RIGHTS[kind].price), canPermission(RIGHTS[kind].discount)]);
  if (!hasDiscount) return { canPrice, canDiscount: false, discountSwitchedOff: false };
  const c = getContainer();
  const branchId = (await c.salesOrders.branchOf(userId)) ?? (await c.branches.getDefault(companyId))?.id ?? null;
  const offered = await c.sellingSettings.manualDiscountOffered(companyId, kind, branchId);
  return { canPrice, canDiscount: offered, discountSwitchedOff: !offered };
}

/**
 * Holds what the screen sent to what the person may do. A price typed by someone who may not change prices is dropped (the price lists
 * decide); a discount from someone who may not give one is refused in words, never dropped, so nobody is charged a price they did not expect.
 */
export function holdToRights(rights: LineRights, input: SalesOrderInput): { ok: true; input: SalesOrderInput } | { ok: false; error: string } {
  if (!rights.canDiscount && input.lines.some((l) => l.discount !== undefined)) return { ok: false, error: 'You cannot give a discount here. Remove the discount and try again.' };
  if (rights.canPrice || !input.lines.some((l) => l.unitPrice !== undefined)) return { ok: true, input };
  return { ok: true, input: { ...input, lines: input.lines.map(({ unitPrice: _dropped, ...rest }): SalesOrderLineInput => rest) } };
}

/** The total of the document as it will be placed, worked out by the same pricing as placing it. For the screen as lines are typed. */
export async function priceStaffDocument(kind: StaffDocument, companyId: string, userId: string, input: SalesOrderInput) {
  const held = holdToRights(await lineRights(kind, companyId, userId), input);
  if (!held.ok) return held;
  const c = getContainer();
  return await c.salesOrders.price(companyId, { userId, branchId: await c.salesOrders.branchOf(userId) }, held.input, kind);
}
