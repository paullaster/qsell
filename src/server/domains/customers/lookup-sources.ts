import { eq } from 'drizzle-orm';
import { customerProfiles } from '@/server/db/drizzle/schema';
import { ACCOUNT_TYPES, BLOCKS } from '@/lib/customer-forms';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

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
  select: { code: customerProfiles.code, accountType: customerProfiles.accountType, creditLimit: customerProfiles.creditLimit, paymentTermDays: customerProfiles.paymentTermDays, transmit: customerProfiles.transmitInvoicesToKra },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(customerProfiles.companyId, companyId), eq(customerProfiles.isActive, true)];
  },
  toOption: (row) => ({
    id: text(row.id),
    label: text(row.label),
    description: text(row.code),
    badge: row.accountType === 'credit' ? 'Credit' : null,
    meta: { accountType: text(row.accountType), creditLimit: text(row.creditLimit), paymentTermDays: text(row.paymentTermDays), transmit: row.transmit === true ? '1' : '' },
  }),
});

export const CUSTOMER_LOOKUP_SOURCES: LookupSource[] = [fixed('customer-account-types', ACCOUNT_TYPES), fixed('customer-blocks', BLOCKS), profiles];
