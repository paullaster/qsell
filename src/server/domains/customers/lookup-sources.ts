import { eq, sql } from 'drizzle-orm';
import { customerProfiles, dimensionValues, dimensions } from '@/server/db/drizzle/schema';
import { ACCOUNT_TYPES, BLOCKS } from '@/lib/customer-forms';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const fixed = (key: string, list: readonly { id: string; label: string }[]) =>
  staticSource({
    key,
    permission: 'customers:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map((c) => ({ ...c, description: null }));
    },
  });

/** The profiles a new customer can start from (they carry the account type and terms). */
const profiles = tableSource({
  key: 'customer-profiles',
  permission: 'customers:read',
  table: customerProfiles,
  id: customerProfiles.id,
  label: customerProfiles.name,
  searchColumns: [customerProfiles.name, customerProfiles.code],
  select: { code: customerProfiles.code, accountType: customerProfiles.accountType, creditLimit: customerProfiles.creditLimit, paymentTermDays: customerProfiles.paymentTermDays, transmit: customerProfiles.transmitInvoicesToKra, codes: customerProfiles.dimensionCodes },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(customerProfiles.companyId, companyId), eq(customerProfiles.isActive, true)];
  },
  toOption: (row) => ({
    id: text(row.id),
    label: text(row.label),
    description: text(row.code),
    badge: row.accountType === 'credit' ? 'Credit' : null,
    meta: { accountType: text(row.accountType), creditLimit: text(row.creditLimit), paymentTermDays: text(row.paymentTermDays), transmit: row.transmit === true ? '1' : '', dimensions: JSON.stringify(row.codes ?? {}) },
  }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The open values of one dimension (the `dimension` filter) as a customer's default; the value's code is the choice. */
const dimensionChoices = tableSource({
  key: 'customer-dimension-values',
  permission: 'customers:read',
  table: dimensionValues,
  id: dimensionValues.code,
  label: dimensionValues.code,
  searchColumns: [dimensionValues.code, dimensionValues.name],
  select: { name: dimensionValues.name },
  scope: ({ companyId, filters }) => {
    const { dimension, ...rest } = filters;
    if (Object.keys(rest).length > 0 || dimension === undefined || !UUID.test(dimension)) throw new LookupFilterError('Choose the dimension first.');
    return [
      eq(dimensionValues.dimensionId, dimension),
      eq(dimensionValues.isActive, true),
      eq(dimensionValues.blocked, false),
      sql`exists (select 1 from ${dimensions} where ${dimensions.id} = ${dimensionValues.dimensionId} and ${dimensions.companyId} = ${companyId})`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} — ${text(row.name)}`, description: null, badge: null }),
});

export const CUSTOMER_LOOKUP_SOURCES: LookupSource[] = [dimensionChoices, fixed('customer-account-types', ACCOUNT_TYPES), fixed('customer-blocks', BLOCKS), profiles];
