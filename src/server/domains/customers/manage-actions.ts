'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { SettingsError, isUniqueViolation } from '@/server/domains/settings/errors';
import type { PageInput } from '@/server/domains/settings/paging';
import { accountTypeOf, blockOf } from '@/lib/customer-forms';
import type { CustomerLedgerEntryRow, CustomerRow, DimensionCodesProjection } from '@/server/db/drizzle/schema';

const PATHS = ['/admin/customers'];

/** The customer rules speak in words meant for the person ("already exists", "credit limit", "not found"). */
const friendly = (error: unknown): string | null => {
  if (isUniqueViolation(error)) return 'A customer or profile with that code or email already exists.';
  return error instanceof Error && /already exists|required|credit|not found|cannot|must/i.test(error.message) ? error.message : null;
};

/** The dimensions a customer can carry as defaults: only what the form needs (no values; they are searched). */
export async function customerFieldsAction() {
  return await runSetting('customers:read', async ({ companyId }) => {
    const contract = await getContainer().dimensionSets.listFieldContract(companyId);
    return contract.map((f) => ({ fieldName: f.fieldName, dimensionId: f.dimensionId, dimensionCode: f.dimensionCode, kind: f.kind }));
  });
}

/** One page of customers, 25 at a time, narrowed by text on the server. */
export async function customersPageAction(input: PageInput) {
  return await runSetting('customers:read', ({ companyId }) => getContainer().customers.pageCustomers(companyId, input));
}

/** One page of profiles, 25 at a time, narrowed by text on the server. */
export async function profilesPageAction(input: PageInput) {
  return await runSetting('customers:read', ({ companyId }) => getContainer().customers.pageProfiles(companyId, input));
}

export async function customerLedgerAction(id: string) {
  return await runSetting('customers:read', async ({ companyId }): Promise<CustomerLedgerEntryRow[]> => {
    const found = await getContainer().customers.getCustomer(companyId, id);
    if (found === null) throw new SettingsError('That customer does not exist.', 'NOT_FOUND');
    return found.ledger;
  });
}

/** The words for a profile already chosen on a customer card, so the picker can show them before it is opened. */
export async function profileLabelAction(id: string) {
  return await runSetting('customers:read', async ({ companyId }): Promise<string> => {
    const found = await getContainer().customers.getProfile(companyId, id);
    return found === null ? '' : `${found.code} — ${found.name}`;
  });
}

export interface CustomerInput {
  id?: string;
  profileId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  countyOrState: string | null;
  postalCode: string | null;
  country: string | null;
  accountType: string;
  creditLimit: number;
  paymentTermDays: number;
  blocked: string;
  transmitInvoicesToKra: boolean;
  buyerKraPin: string | null;
  notes: string | null;
  isActive: boolean;
  dimensionCodes: DimensionCodesProjection;
}

/** Saves a customer card. What the browser sent for the type and the block is read again here, never believed. */
export async function saveCustomerAction(input: CustomerInput) {
  return await runSetting(
    input.id === undefined ? 'customers:create' : 'customers:update',
    async ({ companyId }): Promise<CustomerRow> => {
      const { accountType, blocked, ...rest } = input;
      return await getContainer().customers.saveCustomer(companyId, { ...rest, accountType: accountTypeOf(accountType), blocked: blockOf(blocked) });
    },
    { paths: PATHS, friendly },
  );
}

export async function deleteCustomerAction(id: string) {
  return await runSetting(
    'customers:delete',
    async ({ companyId }) => {
      await getContainer().customers.deleteCustomer(companyId, id);
      return { deleted: true };
    },
    { paths: PATHS, friendly },
  );
}

export async function receivePaymentAction(customerId: string, amount: number, reference: string) {
  return await runSetting(
    'transactions:post',
    ({ companyId }) => getContainer().customers.receivePayment(companyId, customerId, { amount, reference }),
    { paths: [...PATHS, '/admin/transactions/ledger'], friendly },
  );
}

export interface ProfileInput {
  id?: string;
  code: string;
  name: string;
  description: string | null;
  accountType: string;
  creditLimit: number;
  paymentTermDays: number;
  transmitInvoicesToKra: boolean;
  isActive: boolean;
  dimensionCodes: DimensionCodesProjection;
}

export async function saveProfileAction(input: ProfileInput) {
  return await runSetting(
    'customers:update',
    ({ companyId }) => getContainer().customers.saveProfile(companyId, { ...input, accountType: accountTypeOf(input.accountType) }),
    { paths: PATHS, friendly },
  );
}
