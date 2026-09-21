'use server';

import { auth } from '@/auth';
import { db } from '@/server/db/store';
import { getContainer } from '@/server/di/container';
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

/**
 * Resolve the logged-in storefront shopper to a trade customer card + address book.
 * Keeps an in-memory CustomerAccount shell for order history / payment prefs.
 */
async function resolveLoggedInAccount(customerId?: string): Promise<{
  account: CustomerAccount;
  tradeCustomerId: string;
} | null> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase().trim();
  const isCustomer = session?.user?.role === 'customer';

  if (!customerId && (!session?.user || !isCustomer || !email)) {
    return null;
  }

  const cid = await companyId();
  const storeId = customerId || session?.user?.customerStoreId || undefined;
  let memory =
    (storeId ? db.getCustomerById(storeId) : null) ||
    (email ? db.getCustomerByEmailOrPhone(email) : null);

  if (!memory && email && isCustomer) {
    memory = db.createCustomer({
      id: session!.user.customerStoreId || undefined,
      name: session!.user.name || email.split('@')[0] || 'Customer',
      email,
      phone: session!.user.phone || '0700000000',
      role: 'customer',
      status: 'verified',
      addresses: [],
      paymentPreferences: {},
    });
  }

  if (!memory && customerId) {
    throw new Error('Customer not found');
  }
  if (!memory) return null;

  const trade = await master().ensureStorefrontCustomer(cid, {
    name: memory.name || session?.user?.name || memory.email,
    email: memory.email || email || '',
    phone: memory.phone || session?.user?.phone,
  });
  const addressRows = await master().listAddresses(trade.id);
  const account: CustomerAccount = {
    ...memory,
    name: trade.name || memory.name,
    email: trade.email || memory.email,
    phone: trade.phone || memory.phone,
    tradeCustomerId: trade.id,
    customerNumber: trade.number,
    buyerKraPin: trade.buyerKraPin,
    addresses: addressRows.map(mapAddress),
  };
  return { account, tradeCustomerId: trade.id };
}

async function requireTradeCustomerId(customerId?: string): Promise<string> {
  const resolved = await resolveLoggedInAccount(customerId);
  if (!resolved) throw new Error('Sign in to manage addresses.');
  if (customerId && resolved.account.id !== customerId && resolved.tradeCustomerId !== customerId) {
    // Allow address mutations when the client passes the trade customer id or store id.
    const cid = await companyId();
    const byId = await master().getCustomer(cid, customerId);
    if (byId) return byId.customer.id;
  }
  return resolved.tradeCustomerId;
}

export async function listCustomersAction(): Promise<CustomerAccount[]> {
  return db.getAllCustomers();
}

export const fetchUserProfilesAction = listCustomersAction;

export async function getCustomerAccountAction(
  customerId?: string,
): Promise<{ customer: CustomerAccount | null; orders: Order[] }> {
  try {
    const resolved = await resolveLoggedInAccount(customerId);
    if (!resolved) {
      if (customerId) throw new Error('Customer not found');
      return { customer: null, orders: [] };
    }
    const orders = db.getCustomerOrders(resolved.account.id);
    const byEmail = resolved.account.email
      ? db.getCustomerOrders(resolved.account.email)
      : [];
    const merged = [...orders];
    for (const order of byEmail) {
      if (!merged.some((o) => o.id === order.id)) merged.push(order);
    }
    return { customer: resolved.account, orders: merged };
  } catch (err) {
    if (customerId) throw err;
    return { customer: null, orders: [] };
  }
}

export async function updateCustomerProfileAction(
  customerId: string,
  updates: Partial<CustomerAccount>,
): Promise<CustomerAccount> {
  const memory = db.updateCustomer(customerId, updates);
  const cid = await companyId();
  const email = (updates.email || memory.email || '').toLowerCase().trim();
  if (!email) return memory;

  const existing = await master().lookupByEmail(cid, email);
  const trade = existing
    ? await master().saveCustomer(cid, {
        id: existing.id,
        profileId: existing.profileId,
        name: updates.name?.trim() || memory.name,
        email: existing.email,
        phone: updates.phone?.trim() || memory.phone,
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
        name: updates.name?.trim() || memory.name,
        email,
        phone: updates.phone?.trim() || memory.phone,
      });

  const addresses = await master().listAddresses(trade.id);
  return {
    ...memory,
    name: trade.name,
    phone: trade.phone || memory.phone,
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
    (storeCustomerId ? db.getCustomerById(storeCustomerId) : null) ||
    (found.customer.email ? db.getCustomerByEmailOrPhone(found.customer.email) : null);

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

export async function listCustomerOrdersAction(customerId: string): Promise<Order[]> {
  return db.getCustomerOrders(customerId);
}
