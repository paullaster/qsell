'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { StorefrontCustomerService } from '@/server/domains/customers/storefront-service';
import type { CustomerAddressRow } from '@/server/db/drizzle/schema';
import type { CustomerAccount, CustomerAddress, Order } from '@/types/index';
import type { CustomerAddressInput } from './master-service';

function mapAddress(row: CustomerAddressRow): CustomerAddress {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    street: row.street,
    city: row.city,
    countyOrState: row.countyOrState,
    postalCode: row.postalCode || undefined,
    country: row.country,
    isDefault: row.isDefault,
  };
}

async function companyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

function master() {
  return getContainer().customers;
}

function storefront() {
  return StorefrontCustomerService;
}

function firstNonEmpty(values: Array<string | null | undefined>, fallback = ''): string {
  return values.find((v) => v != null && v !== '') ?? fallback;
}

/**
 * Resolve the signed-in storefront shopper to a trade customer card + address book.
 * Identity comes only from the Auth.js session — never from a client-supplied id —
 * so one shopper can never read or change another shopper's account.
 */
async function resolveLoggedInAccount(): Promise<{
  account: CustomerAccount;
  tradeCustomerId: string;
} | null> {
  const session = await auth();
  const email = session?.user.email.toLowerCase().trim() ?? '';
  if (session?.user.role !== 'customer' || email === '') {
    return null;
  }

  const cid = await companyId();
  const storeId = session.user.customerStoreId ?? undefined;
  let account = (storeId !== undefined ? await storefront().findById(storeId) : null) ?? null;
  account ??= await storefront().findByEmailOrPhone(email);
  account ??= await storefront().ensure({
    name: firstNonEmpty([session.user.name, email.split('@')[0]], 'Customer'),
    email,
    phone: session.user.phone ?? '0700000000',
  });

  const phone = firstNonEmpty([account.phone, session.user.phone]);
  const trade = await master().ensureStorefrontCustomer(cid, {
    name: firstNonEmpty([account.name, session.user.name, account.email]),
    email: firstNonEmpty([account.email, email]),
    phone: phone === '' ? null : phone,
  });
  const addressRows = await master().listAddresses(trade.id);
  const merged: CustomerAccount = {
    ...account,
    name: trade.name || account.name,
    email: trade.email || account.email,
    phone: trade.phone || account.phone,
    tradeCustomerId: trade.id,
    customerNumber: trade.number,
    buyerKraPin: trade.buyerKraPin,
    addresses: addressRows.map(mapAddress),
  };
  return { account: merged, tradeCustomerId: trade.id };
}

/** Same identifiers the UI may pass back: the store account id or the trade customer id. */
function isOwnAccount(
  resolved: { account: CustomerAccount; tradeCustomerId: string },
  customerId: string | undefined,
): boolean {
  return (
    customerId === undefined ||
    customerId === resolved.account.id ||
    customerId === resolved.tradeCustomerId
  );
}

async function requireOwnAccount(customerId?: string): Promise<{
  account: CustomerAccount;
  tradeCustomerId: string;
}> {
  const resolved = await resolveLoggedInAccount();
  if (!resolved) throw new Error('Sign in to manage your account.');
  if (!isOwnAccount(resolved, customerId)) {
    throw new Error('You can only manage your own account.');
  }
  return resolved;
}

async function requireTradeCustomerId(customerId?: string): Promise<string> {
  return (await requireOwnAccount(customerId)).tradeCustomerId;
}

export async function listCustomersAction(): Promise<CustomerAccount[]> {
  await requirePermission('customers:read');
  return storefront().list();
}

export const fetchUserProfilesAction = listCustomersAction;

export async function getCustomerAccountAction(
  customerId?: string,
): Promise<{ customer: CustomerAccount | null; orders: Order[] }> {
  try {
    const resolved = await resolveLoggedInAccount();
    if (!resolved || !isOwnAccount(resolved, customerId)) {
      return { customer: null, orders: [] };
    }
    const orders = await getContainer().orders.listByUserId(resolved.account.id);
    const byEmail = resolved.account.email
      ? await getContainer().orders.listByUserId(resolved.account.email)
      : [];
    const merged = [...orders];
    for (const order of byEmail) {
      if (!merged.some((o) => o.id === order.id)) merged.push(order);
    }
    return { customer: resolved.account, orders: merged };
  } catch {
    return { customer: null, orders: [] };
  }
}

export async function updateCustomerProfileAction(
  customerId: string,
  updates: Partial<CustomerAccount>,
): Promise<CustomerAccount> {
  const { account: existingAccount } = await requireOwnAccount(customerId);
  const cid = await companyId();
  // The email is the sign-in identity; it is never changed from the storefront, and
  // accepting it here would let a shopper overwrite someone else's customer card.
  const email = existingAccount.email.toLowerCase().trim();
  if (!email) return existingAccount;

  const existing = await master().lookupByEmail(cid, email);
  const trade = existing
    ? await master().saveCustomer(cid, {
        id: existing.id,
        profileId: existing.profileId,
        name: updates.name?.trim() || existingAccount.name,
        email: existing.email,
        phone: updates.phone?.trim() || existingAccount.phone,
        street: existing.street,
        city: existing.city,
        countyOrState: existing.countyOrState,
        postalCode: existing.postalCode,
        country: existing.country,
        accountType: existing.accountType === 'credit' ? 'credit' : 'cash',
        creditLimit: Number(existing.creditLimit),
        paymentTermDays: existing.paymentTermDays,
        blocked: (existing.blocked as 'none' | 'ship' | 'invoice' | 'all') || 'none',
        transmitInvoicesToKra: existing.transmitInvoicesToKra,
        buyerKraPin:
          updates.buyerKraPin !== undefined ? updates.buyerKraPin : existing.buyerKraPin,
        dimensionCodes: existing.dimensionCodes,
        isActive: existing.isActive,
        notes: existing.notes,
      })
    : await master().ensureStorefrontCustomer(cid, {
        name: updates.name?.trim() || existingAccount.name,
        email,
        phone: updates.phone?.trim() || existingAccount.phone,
      });

  const addresses = await master().listAddresses(trade.id);
  return {
    ...existingAccount,
    name: trade.name,
    phone: trade.phone || existingAccount.phone,
    tradeCustomerId: trade.id,
    customerNumber: trade.number,
    buyerKraPin: trade.buyerKraPin,
    addresses: addresses.map(mapAddress),
  };
}

async function reloadAccount(tradeCustomerId: string, storeCustomerId?: string): Promise<CustomerAccount> {
  const cid = await companyId();
  const found = await master().getCustomer(cid, tradeCustomerId);
  if (!found) throw new Error('Customer not found.');
  const addresses = (await master().listAddresses(tradeCustomerId)).map(mapAddress);
  const memory =
    (storeCustomerId ? await storefront().findById(storeCustomerId) : null) ??
    (found.customer.email ? await storefront().findByEmailOrPhone(found.customer.email) : null);

  if (memory) {
    return {
      ...memory,
      name: found.customer.name,
      email: found.customer.email || memory.email,
      phone: found.customer.phone || memory.phone,
      tradeCustomerId: found.customer.id,
      customerNumber: found.customer.number,
      buyerKraPin: found.customer.buyerKraPin,
      addresses,
    };
  }

  return {
    id: found.customer.id,
    name: found.customer.name,
    email: found.customer.email || '',
    phone: found.customer.phone || '',
    tradeCustomerId: found.customer.id,
    customerNumber: found.customer.number,
    buyerKraPin: found.customer.buyerKraPin,
    role: 'customer',
    status: 'verified',
    addresses,
    paymentPreferences: {},
    totalOrders: 0,
    totalSpend: 0,
    createdAt: found.customer.createdAt.toISOString(),
    updatedAt: found.customer.updatedAt.toISOString(),
  };
}

export async function addCustomerAddressAction(
  customerId: string,
  addressData: Omit<CustomerAddress, 'id'>,
): Promise<{ address: CustomerAddress; customer: CustomerAccount }> {
  const tradeId = await requireTradeCustomerId(customerId);
  const row = await master().addAddress(tradeId, addressData as CustomerAddressInput);
  const customer = await reloadAccount(tradeId, customerId);
  return { address: mapAddress(row), customer };
}

export async function updateCustomerAddressAction(
  customerId: string,
  addressId: string,
  updates: Partial<CustomerAddress>,
): Promise<{ address: CustomerAddress; customer: CustomerAccount }> {
  const tradeId = await requireTradeCustomerId(customerId);
  const row = await master().updateAddress(tradeId, addressId, updates);
  const customer = await reloadAccount(tradeId, customerId);
  return { address: mapAddress(row), customer };
}

export async function deleteCustomerAddressAction(
  customerId: string,
  addressId: string,
): Promise<{ success: boolean; customer: CustomerAccount }> {
  const tradeId = await requireTradeCustomerId(customerId);
  await master().deleteAddress(tradeId, addressId);
  const customer = await reloadAccount(tradeId, customerId);
  return { success: true, customer };
}

export async function setDefaultAddressAction(
  customerId: string,
  addressId: string,
): Promise<CustomerAccount> {
  const tradeId = await requireTradeCustomerId(customerId);
  await master().setDefaultAddress(tradeId, addressId);
  return reloadAccount(tradeId, customerId);
}

export async function listCustomerOrdersAction(customerId?: string): Promise<Order[]> {
  const { account } = await requireOwnAccount(customerId);
  return getContainer().orders.listByUserId(account.id);
}
