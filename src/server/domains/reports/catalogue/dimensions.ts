import type { MessageId } from '@/lib/reports/messages';

/**
 * The ways a measure can be cut. A dimension is only listed on a measure (see `measures.ts`) when the cut makes
 * sense for it, which is what stops nonsense such as stock by salesperson. Codes are stable: reports, saved
 * views and exports refer to them.
 */
export const DIMENSION_CODES = [
  'date',
  'branch',
  'channel',
  'sales_type',
  'customer',
  'customer_group',
  'product',
  'category',
  'brand',
  'vendor',
  'salesperson',
  'payment_method',
  'delivery_zone',
  'rider',
] as const;

export type DimensionCode = (typeof DIMENSION_CODES)[number];

export interface DimensionDefinition {
  code: DimensionCode;
  labelId: MessageId;
  /** `time` is a calendar cut (day, week, month); `entity` is a record people know by name; `attribute` is a plain list of values. */
  kind: 'time' | 'entity' | 'attribute';
}

export const DIMENSIONS: Readonly<Record<DimensionCode, DimensionDefinition>> = {
  date: { code: 'date', labelId: 'dimension.date.label', kind: 'time' },
  branch: { code: 'branch', labelId: 'dimension.branch.label', kind: 'entity' },
  channel: { code: 'channel', labelId: 'dimension.channel.label', kind: 'attribute' },
  sales_type: { code: 'sales_type', labelId: 'dimension.sales_type.label', kind: 'attribute' },
  customer: { code: 'customer', labelId: 'dimension.customer.label', kind: 'entity' },
  customer_group: {
    code: 'customer_group',
    labelId: 'dimension.customer_group.label',
    kind: 'entity',
  },
  product: { code: 'product', labelId: 'dimension.product.label', kind: 'entity' },
  category: { code: 'category', labelId: 'dimension.category.label', kind: 'entity' },
  brand: { code: 'brand', labelId: 'dimension.brand.label', kind: 'attribute' },
  vendor: { code: 'vendor', labelId: 'dimension.vendor.label', kind: 'entity' },
  salesperson: { code: 'salesperson', labelId: 'dimension.salesperson.label', kind: 'entity' },
  payment_method: {
    code: 'payment_method',
    labelId: 'dimension.payment_method.label',
    kind: 'attribute',
  },
  delivery_zone: {
    code: 'delivery_zone',
    labelId: 'dimension.delivery_zone.label',
    kind: 'entity',
  },
  rider: { code: 'rider', labelId: 'dimension.rider.label', kind: 'entity' },
};

export function isDimensionCode(value: string): value is DimensionCode {
  return (DIMENSION_CODES as readonly string[]).includes(value);
}
