import type { DeliveryAction } from './delivery-document';
import type { DeliveryMethod } from './delivery-methods';
import { dispositionLabel } from './return-form';

/** When the stock of an order that is delivered leaves the shelf. */
export const ISSUE_MOMENTS = ['payment', 'dispatch', 'delivery'] as const;
export type IssueMoment = (typeof ISSUE_MOMENTS)[number];

export const isIssueMoment = (value: unknown): value is IssueMoment => typeof value === 'string' && (ISSUE_MOMENTS as readonly string[]).includes(value);

export const ISSUE_MOMENT_WORDS: Record<IssueMoment, { name: string; means: string }> = {
  payment: { name: 'When the order is paid', means: 'The stock is taken off the shelf as soon as the order is paid, as it always has been. A returned parcel stays with the order.' },
  dispatch: { name: 'When a delivery goes out', means: 'The stock stays on the shelf, held for the order, until a delivery carrying it is sent out. Only what that delivery carries leaves the shelf.' },
  delivery: { name: 'When a delivery arrives', means: 'The stock stays on the shelf, held for the order, until a delivery carrying it is delivered. Goods that come back never left the books.' },
};

/** The delivery step at which each later moment issues the stock. */
const ISSUING_ACTION: Record<Exclude<IssueMoment, 'payment'>, DeliveryAction> = { dispatch: 'dispatch', delivery: 'deliver' };

/** Whether this step issues the stock of the goods it carries. */
export const issuesAt = (moment: IssueMoment, action: DeliveryAction): boolean => moment !== 'payment' && ISSUING_ACTION[moment] === action;

/**
 * Whether payment should leave an order's stock held. Only orders that are delivered with a delivery document wait; an order that is
 * collected, or a visit, is issued when it is paid as before.
 */
export const heldAtPayment = (moment: IssueMoment, method: DeliveryMethod | null): boolean => moment !== 'payment' && (method === 'own_fleet' || method === 'courier');

/**
 * What happens to goods that come back with a returned delivery. The first three are the finance returns' own words and mean the
 * same: goods in good condition go back to the shelf, goods to be looked at go to a quarantine place, goods that are no use are
 * written off. `keep` is for a delivery only: the goods stay with the order, and nothing moves in stock.
 */
export const RETURN_DISPOSITIONS = ['return_to_stock', 'quarantine', 'scrap', 'keep'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];
export const isReturnDisposition = (value: unknown): value is ReturnDisposition => typeof value === 'string' && (RETURN_DISPOSITIONS as readonly string[]).includes(value);

export const DISPOSITION_WORDS: Record<ReturnDisposition, { name: string; means: string }> = {
  return_to_stock: { name: dispositionLabel('return_to_stock'), means: 'In good condition: counted back into stock, and held again for the order, which is still owed it.' },
  quarantine: { name: dispositionLabel('quarantine'), means: 'To be looked at before it is sold: counted into a quarantine place, never sold from there. The order is held a replacement from the shelf.' },
  scrap: { name: dispositionLabel('scrap'), means: 'No use: counted back and written off, so the sale is undone and the loss is recorded. The order is held a replacement from the shelf.' },
  keep: { name: 'Keep for the order', means: 'Stays with the order for another delivery. Nothing moves in stock.' },
};

/**
 * The choices for goods that came back, by what happened to their stock. Stock this delivery issued, and stock that was never issued
 * because the order is issued when it arrives, can go back, to quarantine or be written off. Stock that was issued some other way
 * (when the order was paid) is the order's own: it is kept for the order, and nothing else is offered.
 */
export function dispositionsFor(moment: IssueMoment, issuedHere: boolean): readonly ReturnDisposition[] {
  return issuedHere || moment === 'delivery' ? ['return_to_stock', 'quarantine', 'scrap'] : ['keep'];
}

export interface ReturnLineCheck {
  productId: string;
  quantity: number;
  disposition: string;
}

/** What could come back of a product on the delivery, and whether this delivery issued its stock. */
export interface ReturnableLine {
  could: number;
  issuedHere: boolean;
}

/** A plain-words problem with the lines of a return receipt, or null. */
export function returnProblem(moment: IssueMoment, back: ReadonlyMap<string, ReturnableLine>, lines: readonly ReturnLineCheck[]): string | null {
  if (lines.length === 0) return 'Say what came back.';
  const seen = new Set<string>();
  for (const line of lines) {
    const line0 = back.get(line.productId);
    if (line0 === undefined) return 'One of the products is not on this delivery.';
    if (seen.has(line.productId)) return 'A product can be received only once.';
    seen.add(line.productId);
    if (!Number.isFinite(line.quantity) || line.quantity < 0) return 'A quantity cannot be less than nothing.';
    if (line.quantity > line0.could) return `No more than ${String(line0.could)} of a product can come back.`;
    if (!isReturnDisposition(line.disposition) || !dispositionsFor(moment, line0.issuedHere).includes(line.disposition)) return 'Choose what is to be done with each product that came back.';
  }
  return null;
}
