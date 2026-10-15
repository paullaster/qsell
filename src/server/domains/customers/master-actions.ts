'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { auth } from '@/auth';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type {
  CustomerLedgerEntryRow,
  CustomerProfileRow,
  CustomerRow,
  DimensionCodesProjection,
} from '@/server/db/drizzle/schema';
import type { CustomerAccountType, CustomerBlock } from './master-service';

async function companyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

function master() {
  return getContainer().customers;
}

export async function listCustomerProfilesAction(): Promise<CustomerProfileRow[]> {
  await requirePermission('customers:read');
  return await master().listProfiles(await companyId());
}

export async function saveCustomerProfileAction(input: {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  accountType: CustomerAccountType;
  creditLimit: number;
  paymentTermDays: number;
  transmitInvoicesToKra: boolean;
  dimensionCodes?: DimensionCodesProjection;
  isActive?: boolean;
}): Promise<CustomerProfileRow> {
  await requirePermission('customers:update');
  const row = await master().saveProfile(await companyId(), input);
  revalidatePath('/admin/customers');
  return row;
}

export async function listTradeCustomersAction(): Promise<CustomerRow[]> {
  await requirePermission('customers:read');
  return await master().listCustomers(await companyId());
}

export async function getTradeCustomerAction(
  id: string,
): Promise<{ customer: CustomerRow; ledger: CustomerLedgerEntryRow[] } | null> {
  await requirePermission('customers:read');
  return await master().getCustomer(await companyId(), id);
}

export async function saveTradeCustomerAction(input: {
  id?: string;
  profileId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  countyOrState?: string | null;
  postalCode?: string | null;
  country?: string | null;
  accountType: CustomerAccountType;
  creditLimit: number;
  paymentTermDays: number;
  blocked?: CustomerBlock;
  transmitInvoicesToKra: boolean;
  buyerKraPin?: string | null;
  dimensionCodes?: DimensionCodesProjection;
  isActive?: boolean;
  notes?: string | null;
}): Promise<CustomerRow> {
  await requirePermission('customers:update');
  const row = await master().saveCustomer(await companyId(), input);
  revalidatePath('/admin/customers');
  return row;
}

export async function deleteTradeCustomerAction(id: string): Promise<void> {
  await requirePermission('customers:delete');
  await master().deleteCustomer(await companyId(), id);
  revalidatePath('/admin/customers');
}

export async function receiveCustomerPaymentAction(
  customerId: string,
  amount: number,
  reference: string,
): Promise<CustomerRow> {
  await requirePermission('transactions:post');
  const row = await master().receivePayment(await companyId(), customerId, { amount, reference });
  revalidatePath('/admin/customers');
  revalidatePath('/admin/transactions/ledger');
  return row;
}

export async function lookupCheckoutCustomerAction(email: string): Promise<{
  found: boolean;
  accountType: CustomerAccountType | null;
  name: string | null;
  blocked: boolean;
  creditLimit: number;
  balance: number;
  transmitInvoicesToKra: boolean;
}> {
  // Credit terms and balances are private: only the shopper signed in with this
  // email (or staff) may see them. Everyone else gets the same "no account" answer,
  // so the lookup can't be used to probe which emails are customers.
  const session = await auth();
  const isSelf = session?.user.email.toLowerCase() === email.trim().toLowerCase();
  const allowed = isSelf || session?.user.isStaff === true;
  const customer = allowed ? await master().lookupByEmail(await companyId(), email) : null;
  if (!customer?.isActive) {
    return {
      found: false,
      accountType: null,
      name: null,
      blocked: false,
      creditLimit: 0,
      balance: 0,
      transmitInvoicesToKra: true,
    };
  }
  return {
    found: true,
    accountType: customer.accountType as CustomerAccountType,
    name: customer.name,
    blocked: customer.blocked === 'invoice' || customer.blocked === 'all',
    creditLimit: Number(customer.creditLimit),
    balance: Number(customer.balance),
    transmitInvoicesToKra: customer.transmitInvoicesToKra,
  };
}

export async function customerSetupAction(): Promise<{
  customers: CustomerRow[];
  profiles: CustomerProfileRow[];
  fields: {
    fieldName: string;
    dimensionId: string;
    dimensionCode: string;
    kind: 'global' | 'shortcut';
    values: { code: string; name: string }[];
  }[];
}> {
  await requirePermission('customers:read');
  const id = await companyId();
  const [customerRows, profiles, contract] = await Promise.all([
    master().listCustomers(id),
    master().listProfiles(id),
    // Field metadata is part of the customer form, so read it directly rather than
    // through the settings actions (which would demand settings:read as well).
    getContainer().dimensionSets.listFieldContract(id),
  ]);
  const fields = await Promise.all(
    contract.map(async (field) => {
      const values = await getContainer().dimensions.listValues(field.dimensionId);
      return {
        fieldName: field.fieldName,
        dimensionId: field.dimensionId,
        dimensionCode: field.dimensionCode,
        kind: field.kind,
        values: values
          .filter((value) => value.isActive && !value.blocked)
          .map((value) => ({ code: value.code, name: value.name })),
      };
    }),
  );
  return { customers: customerRows, profiles, fields };
}
