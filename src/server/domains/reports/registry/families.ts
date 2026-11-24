import type { MessageId } from '@/lib/reports/messages';

/** The groups reports are listed under, in the order the hub shows them. */
export const FAMILY_CODES = [
  'executive',
  'sales',
  'pos',
  'inventory',
  'finance',
  'tax',
  'customers',
  'vendors',
  'delivery',
  'projects',
  'people',
  'operations',
] as const;

export type FamilyCode = (typeof FAMILY_CODES)[number];

export const FAMILY_LABELS: Readonly<Record<FamilyCode, MessageId>> = {
  executive: 'family.executive.label',
  sales: 'family.sales.label',
  pos: 'family.pos.label',
  inventory: 'family.inventory.label',
  finance: 'family.finance.label',
  tax: 'family.tax.label',
  customers: 'family.customers.label',
  vendors: 'family.vendors.label',
  delivery: 'family.delivery.label',
  projects: 'family.projects.label',
  people: 'family.people.label',
  operations: 'family.operations.label',
};

export function isFamilyCode(value: string): value is FamilyCode {
  return (FAMILY_CODES as readonly string[]).includes(value);
}
