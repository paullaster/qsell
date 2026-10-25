import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { has, nth } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as mod_server_domains_orders_write_service from './write-service';

/** A guest checkout with no email, against a real database.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('guest checkout without an email (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let OrderWriteService: typeof mod_server_domains_orders_write_service.OrderWriteService;
  let companyId: string;
  let branchId: string;
  let productId: string;
  const phone = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  const checkout = (over: Record<string, unknown> = {}) =>
    OrderWriteService.createOrder({
      branchId,
      // Explicit, because this test database holds many companies that each number from 1.
      orderNumber: `GUEST-${randomUUID()}`,
      customerName: 'Guest Buyer',
      customerEmail: '',
      customerPhone: phone,
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 1 }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      ...over,
    });

  const cardsWithPhone = async () =>
    (await db.select().from(schema.customers).where(eq(schema.customers.phone, phone))).filter(
      (row) => row.companyId === companyId,
    );

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ OrderWriteService } = await import('./write-service'));
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Guest Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const itemTypeId = `it_guest_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id: productId,
      sku: `G-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `GS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Guest product',
      slug: `guest-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '50',
      stockQuantity: 100,
      taxRate: '0',
      isTaxInclusive: true,
    });
  });

  it('places the order with no email and keeps it as an empty string', async () => {
    const result = await checkout();
    expect(result.success).toBe(true);
    const saved = nth(await db.select().from(schema.orders).where(eq(schema.orders.id, result.order?.id ?? '')), 0);
    expect(saved.customerEmail).toBe('');
    expect(saved.customerPhone).toBe(phone);
  });

  it('keeps one customer card for the same guest phone across orders, with no email on it', async () => {
    expect((await checkout()).success).toBe(true);
    const cards = await cardsWithPhone();
    expect(cards).toHaveLength(1);
    expect(nth(cards, 0).email).toBeNull();
  });

  it('refuses an email that is not one, and tidies one that is', async () => {
    expect(await checkout({ customerEmail: 'not-an-email' })).toMatchObject({ success: false, error: expect.stringMatching(/valid email/i) as string });
    const tidy = await checkout({ customerEmail: `  Guest-${randomUUID()}@Example.COM ` });
    expect(tidy.success).toBe(true);
    expect(tidy.order?.customerEmail).toMatch(/^guest-[0-9a-f-]+@example\.com$/);
  });

  it('does not email an invoice for an order with no email', async () => {
    const result = await checkout();
    const orderId = result.order?.id ?? '';
    await expect(c.invoices.generateAndEmail(orderId, 'tax_invoice')).rejects.toThrow(/no email address/i);
  });
});
