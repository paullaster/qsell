
/**
 * Stock per location: the rules that need no database. Design: docs/architecture/stock-locations.md.
 */

/** Every kind of physical change of stock. A new kind is a code change with a test, never free text. */
export const STOCK_MOVEMENT_TYPES = [
  'receipt',
  'purchase_return',
  'receipt_reversal',
  'sale_issue',
  'sale_return',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'count_variance',
  'write_off',
  'opening',
  'delete_adjust',
  'cost_revaluation',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const LOCATION_KINDS = ['warehouse', 'store', 'van', 'quarantine', 'damaged', 'consignment_in', 'transit'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Kinds that never count toward what can be sold, whatever else is set on them. */
export const NEVER_SELLABLE_KINDS: readonly LocationKind[] = ['quarantine', 'damaged', 'transit'];

export const SALES_CHANNELS = ['ecommerce', 'sales_order', 'credit_sale', 'pos_cash_sale'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export function isLocationKind(value: unknown): value is LocationKind {
  return typeof value === 'string' && (LOCATION_KINDS as readonly string[]).includes(value);
}

export function isSalesChannel(value: unknown): value is SalesChannel {
  return typeof value === 'string' && (SALES_CHANNELS as readonly string[]).includes(value);
}

export function isMovementType(value: unknown): value is StockMovementType {
  return typeof value === 'string' && (STOCK_MOVEMENT_TYPES as readonly string[]).includes(value);
}

/** Journal rows of these kinds are holds or value changes, not physical stock, so they are not movements. */
export const NON_PHYSICAL_JOURNAL_TYPES: readonly string[] = ['order_reservation', 'order_cancellation_release', 'cost_change'];

/** The old journal's word for a change of stock, as the ledger says it. The same mapping lives in the database (`stock_movement_kind`). */
export function movementTypeOfJournal(changeType: string): StockMovementType | null {
  if (NON_PHYSICAL_JOURNAL_TYPES.includes(changeType)) return null;
  switch (changeType) {
    case 'order_fulfillment':
      return 'sale_issue';
    case 'purchase_order_receipt':
    case 'restock':
      return 'receipt';
    case 'purchase_receipt_reversal':
      return 'receipt_reversal';
    case 'purchase_return':
      return 'purchase_return';
    case 'credit_note_restock':
      return 'sale_return';
    case 'physical_audit':
      return 'count_variance';
    case 'damage_writeoff':
      return 'write_off';
    case 'product_deleted':
    case 'product_restored':
      return 'delete_adjust';
    default:
      return 'adjustment';
  }
}

export interface LocationInput {
  code: unknown;
  name: unknown;
  kind: unknown;
  branchId?: unknown;
  address?: unknown;
  isSellable?: unknown;
  sellsChannels?: unknown;
  fulfilsDelivery?: unknown;
  allowNegative?: unknown;
}

export interface CheckedLocation {
  code: string;
  name: string;
  kind: LocationKind;
  branchId: string | null;
  address: string;
  isSellable: boolean;
  sellsChannels: SalesChannel[];
  fulfilsDelivery: boolean;
  allowNegative: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

/** Checks a location as typed. A location of a kind that is never sold from cannot be set to sell, and says so. */
export function checkLocation(input: LocationInput): { ok: true; location: CheckedLocation } | { ok: false; error: string } {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!CODE.test(code)) return { ok: false, error: 'The code is 1 to 20 letters, digits, dashes or underscores, starting with a letter or digit.' };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > 120) return { ok: false, error: 'Give the location a name of up to 120 characters.' };
  if (!isLocationKind(input.kind)) return { ok: false, error: 'Choose what kind of location this is.' };
  const branchId = input.branchId === undefined || input.branchId === null || input.branchId === '' ? null : input.branchId;
  if (branchId !== null && (typeof branchId !== 'string' || !UUID.test(branchId))) return { ok: false, error: 'That branch could not be found.' };
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  if (address.length > 300) return { ok: false, error: 'Keep the address to 300 characters.' };
  const channelsRaw = input.sellsChannels === undefined ? [...SALES_CHANNELS] : input.sellsChannels;
  if (!Array.isArray(channelsRaw) || !channelsRaw.every(isSalesChannel)) return { ok: false, error: 'Choose from the known sales channels.' };
  const sellsChannels = [...new Set(channelsRaw)];
  const isSellable = input.isSellable === undefined ? true : input.isSellable;
  if (typeof isSellable !== 'boolean') return { ok: false, error: 'Say whether stock here can be sold.' };
  if (isSellable && NEVER_SELLABLE_KINDS.includes(input.kind)) return { ok: false, error: `Stock in a ${input.kind.replace('_', ' ')} location cannot be sold from there.` };
  const fulfilsDelivery = input.fulfilsDelivery === undefined ? true : input.fulfilsDelivery;
  const allowNegative = input.allowNegative === undefined ? false : input.allowNegative;
  if (typeof fulfilsDelivery !== 'boolean' || typeof allowNegative !== 'boolean') return { ok: false, error: 'Those options are on or off.' };
  return { ok: true, location: { code, name, kind: input.kind, branchId, address, isSellable, sellsChannels, fulfilsDelivery, allowNegative } };
}
