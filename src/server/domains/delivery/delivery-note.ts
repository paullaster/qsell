import { has } from '@/lib/values';
import type { CompanyProfile } from '@/server/ports/communications';
import type { DeliveryStatus } from '@/lib/delivery-document';
import type { DeliveryView } from './documents';
import { DeliveryError } from './errors';

/** Everything printed on a delivery note: plain data, so the layout can change without touching the rules. No prices: it travels with the goods. */
export interface DeliveryNoteDocument {
  company: CompanyProfile;
  number: string;
  orderNumber: string;
  status: DeliveryStatus;
  /** 'courier' or 'own_fleet', for the heading. */
  method: 'own_fleet' | 'courier';
  from: { branch: string };
  deliverTo: { name: string; phone: string | null; address: string[]; instructions: string | null };
  courier: { name: string; tracking: string | null } | null;
  lines: { sku: string; name: string; quantity: number }[];
  receivedBy: string | null;
  deliveredOn: string | null;
  printedOn: string;
}

const words = (view: DeliveryView, street: string | null): string[] => {
  const a = view.destination.address;
  return [street, a?.area, a?.town, a?.county].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
};

/**
 * The printable form of a delivery. A draft is not yet a delivery anyone is doing, and a cancelled one never was, so neither is
 * printed; everything from released on is. What is printed is what is to be carried: the count picked once it has been counted,
 * the plan before that. The order's phone and street are used when the delivery names no one else to receive it or no place of its own.
 */
export function buildDeliveryNote(view: DeliveryView, order: { customerPhone: string | null; street: string | null }, company: CompanyProfile, printedOn: string): DeliveryNoteDocument {
  if (view.status === 'draft') throw new DeliveryError('A draft is not a delivery yet. Release it, then print the note.', 'NOT_ALLOWED');
  if (view.status === 'cancelled') throw new DeliveryError('A cancelled delivery has no note.', 'NOT_ALLOWED');
  return {
    company,
    number: view.number,
    orderNumber: view.orderNumber,
    status: view.status,
    method: view.method,
    from: { branch: view.branch.name },
    deliverTo: { name: view.recipientName ?? view.customerName, phone: view.recipientPhone ?? order.customerPhone, address: words(view, order.street), instructions: view.notes },
    courier: has(view.courierName) ? { name: view.courierName, tracking: view.trackingNumber } : null,
    lines: view.lines.filter((l) => (l.picked ?? l.quantity) > 0).map((l) => ({ sku: l.sku, name: l.productName, quantity: l.picked ?? l.quantity })),
    receivedBy: view.receivedBy,
    deliveredOn: view.deliveredAt === null ? null : view.deliveredAt.slice(0, 10),
    printedOn,
  };
}

export const deliveryNoteFileName = (number: string): string => `delivery-note-${number.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`;
