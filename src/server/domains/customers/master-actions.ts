'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type {
  CustomerLedgerEntryRow,
  CustomerProfileRow,
  CustomerRow,
  DimensionCodesProjection,
} from '@/server/db/drizzle/schema';
import { listDimensionFieldContractAction, listDimensionValuesAction } from '@/server/domains/dimensions/actions';
import type { CustomerAccountType, CustomerBlock } from './master-service';

async function companyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

function master() {
  return getContainer().customers;
}

export async function listCustomerProfilesAction(): Promise<CustomerProfileRow[]> {
  return master().listProfiles(await companyId());
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
  const row = await master().saveProfile(await companyId(), input);
  revalidatePath('/admin/customers');
  return row;
}

export async function listTradeCustomersAction(): Promise<CustomerRow[]> {
  return master().listCustomers(await companyId());
}

export async function getTradeCustomerAction(
  id: string,
): Promise<{ customer: CustomerRow; ledger: CustomerLedgerEntryRow[] } | null> {
  return master().getCustomer(await companyId(), id);
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
  const row = await master().saveCustomer(await companyId(), input);
  revalidatePath('/admin/customers');
  return row;
}

export async function deleteTradeCustomerAction(id: string): Promise<void> {
  await master().deleteCustomer(await companyId(), id);
  revalidatePath('/admin/customers');
}

export async function receiveCustomerPaymentAction(
  customerId: string,
  amount: number,
  reference: string,
): Promise<CustomerRow> {
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
  const customer = await master().lookupByEmail(await companyId(), email);
  if (!customer || !customer.isActive) {
    return {
      found: false,
      accountType: null,
      name: null,
      blocked: false,
      creditLimit: 0,
      balance: 0,
      transmitInvoicesToKra: false,
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
  const id = await companyId();
  const [customerRows, profiles, contract] = await Promise.all([
    master().listCustomers(id),
    master().listProfiles(id),
    listDimensionFieldContractAction(),
  ]);
  const fields = await Promise.all(
    contract.map(async (field) => {
      const values = await listDimensionValuesAction(field.dimensionId);
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
