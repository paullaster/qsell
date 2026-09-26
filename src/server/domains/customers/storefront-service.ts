import { getContainer } from '@/server/di/container';
import type { CustomerRow } from '@/server/db/drizzle/schema';
import type { CustomerAccount } from '@/types/index';

/**
 * Storefront customer accounts, served from the `customers` / `customer_profiles`
 * tables instead of the legacy in-memory `db.customers` Map.
 *
 * Trade customers and storefront accounts share the `customers` table; the
 * storefront view is derived by joining the linked profile when one exists.
 */
async function companyId(): Promise<string> {
  return (await getContainer().companySettings.ensureSeeded()).id;
}

export class StorefrontCustomerService {
  private static toAccount(customer: CustomerRow): CustomerAccount {
    return {
      id: customer.id,
      tradeCustomerId: customer.id,
      customerNumber: customer.number,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
      totalOrders: 0,
      totalSpend: 0,
      name: customer.name,
      email: customer.email ?? '',
      phone: customer.phone ?? '',
      role: 'customer',
      status: customer.blocked === 'none' ? 'active' : 'suspended',
      addresses: [],
      paymentPreferences: { preferredMethod: 'mpesa_daraja' },
    };
  }

  static async findById(id: string): Promise<CustomerAccount | null> {
    const cid = await companyId();
    const found = await getContainer().customers.getCustomer(cid, id);
    return found ? this.toAccount(found.customer) : null;
  }

  static async findByEmailOrPhone(identifier: string): Promise<CustomerAccount | null> {
    const value = identifier.trim().toLowerCase();
    if (!value) return null;

    const cid = await companyId();
    const container = getContainer();

    const byEmail = await container.customers.lookupByEmail(cid, value);
    if (byEmail) return this.toAccount(byEmail);

    const all = await container.customers.listCustomers(cid);
    const byPhone = all.find((c) => c.phone?.trim() === identifier.trim());
    return byPhone ? this.toAccount(byPhone) : null;
  }

  /** Idempotently creates (or refreshes) the storefront account for a login. */
  static async ensure(input: {
    id?: string | null;
    name: string;
    email: string;
    phone?: string | null;
  }): Promise<CustomerAccount> {
    const cid = await companyId();
    const customer = await getContainer().customers.ensureStorefrontCustomer(cid, {
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
    });
    return this.toAccount(customer);
  }

  static async list(): Promise<CustomerAccount[]> {
    const cid = await companyId();
    const rows = await getContainer().customers.listCustomers(cid);
    return rows.map((row) => this.toAccount(row));
  }
}
