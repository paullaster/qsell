'use server';

import { db } from '@/server/db/store';
import { AuthService } from '@/server/domains/auth/service';
import type { CustomerAccount, CustomerAddress, Order } from '@/types/index';

export async function listCustomersAction(): Promise<CustomerAccount[]> {
  return db.getAllCustomers();
}

export const fetchUserProfilesAction = listCustomersAction;

export async function getCustomerAccountAction(
  customerId?: string,
): Promise<{ customer: CustomerAccount; orders: Order[] }> {
  const session = await AuthService.getSessionFromCookies();
  const id = customerId || session?.userId;
  if (!id) throw new Error('No customer session');

  const customer = db.getCustomerById(id);
  if (!customer) throw new Error('Customer not found');
  const orders = db.getCustomerOrders(id);
  return { customer, orders };
}

export async function updateCustomerProfileAction(
  customerId: string,
  updates: Partial<CustomerAccount>,
): Promise<CustomerAccount> {
  return db.updateCustomer(customerId, updates);
}

export async function addCustomerAddressAction(
  customerId: string,
  addressData: Omit<CustomerAddress, 'id'>,
): Promise<{ address: CustomerAddress; customer: CustomerAccount }> {
  const address = db.addCustomerAddress(customerId, addressData);
  const customer = db.getCustomerById(customerId)!;
  return { address, customer };
}

export async function updateCustomerAddressAction(
  customerId: string,
  addressId: string,
  updates: Partial<CustomerAddress>,
): Promise<{ address: CustomerAddress; customer: CustomerAccount }> {
  const address = db.updateCustomerAddress(customerId, addressId, updates);
  const customer = db.getCustomerById(customerId)!;
  return { address, customer };
}

export async function deleteCustomerAddressAction(
  customerId: string,
  addressId: string,
): Promise<{ success: boolean; customer: CustomerAccount }> {
  db.deleteCustomerAddress(customerId, addressId);
  const customer = db.getCustomerById(customerId)!;
  return { success: true, customer };
}

export async function setDefaultAddressAction(
  customerId: string,
  addressId: string,
): Promise<CustomerAccount> {
  return db.setDefaultAddress(customerId, addressId);
}

export async function listCustomerOrdersAction(customerId: string): Promise<Order[]> {
  return db.getCustomerOrders(customerId);
}
