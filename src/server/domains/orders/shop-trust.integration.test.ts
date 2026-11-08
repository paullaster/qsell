import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { has, nth, required } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';

/** What a shop visitor who has not proven who they are can and cannot do, against a real database.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('the shop does not trust a typed email (database)', () => {
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let companyId: string;
  let branchId: string;
  let productId: string;

  const card = (email: string, accountType: 'credit' | 'cash') =>
    c.customers.saveCustomer(companyId, { name: 'Real Name Ltd', email, phone: '0711000000', street: 's', city: 'c', countyOrState: 'x', country: 'KE', accountType, creditLimit: accountType === 'credit' ? 100000 : 0, paymentTermDays: 30, transmitInvoicesToKra: true, buyerKraPin: 'A000000000Z', dimensionCodes: { global: {}, shortcut: {} } });
  const place = async (email: string, method: string, over: Record<string, unknown> = {}) => {
    const { OrderWriteService } = await import('./write-service');
    return await OrderWriteService.createOrder({ branchId, orderNumber: `ST-${randomUUID()}`, customerName: 'Someone Else', customerEmail: email, customerPhone: '0799999999', shippingAddress: { street: 'x', city: 'y', countyOrState: 'z', country: 'KE' }, items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: method as 'mpesa_daraja', ...over });
  };
  const read = async (email: string) => nth(await db.select().from(schema.customers).where(eq(schema.customers.email, email)), 0);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Trust Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const itemTypeId = `it_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `T-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `TS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Trust product', slug: `t-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', stockQuantity: 50, taxRate: '0', isTaxInclusive: true });
  });

  it('a visitor who is not that customer cannot put an order on their credit account', async () => {
    const email = `credit-${randomUUID()}@x.test`;
    await card(email, 'credit');
    const refused = await place(email, 'on_account', { identityVerified: false });
    expect(refused).toMatchObject({ success: false, code: 'credit_limit' });
    expect(Number((await read(email)).balance)).toBe(0);
  });

  it('the customer themselves, signed in with that email, can', async () => {
    const email = `credit-${randomUUID()}@x.test`;
    await card(email, 'credit');
    const placed = await place(email, 'on_account', { identityVerified: true });
    expect(placed.success).toBe(true);
    expect(Number((await read(email)).balance)).toBe(100);
  });

  it('an order with a registered email from someone not signed in leaves the card as it was', async () => {
    const email = `cash-${randomUUID()}@x.test`;
    await card(email, 'cash');
    const placed = await place(email, 'mpesa_daraja', { identityVerified: false });
    expect(placed.success).toBe(true);
    const after = await read(email);
    expect(after).toMatchObject({ name: 'Real Name Ltd', phone: '0711000000', buyerKraPin: 'A000000000Z' });
  });

  it('a signed-in customer’s order does update their card, and staff orders are trusted', async () => {
    const email = `cash-${randomUUID()}@x.test`;
    await card(email, 'cash');
    await place(email, 'mpesa_daraja', { identityVerified: true });
    expect((await read(email)).name).toBe('Someone Else');
  });

  it('a payment cannot be taken again once the stock held for the order was given back', async () => {
    const { InventoryReservationService } = await import('@/server/domains/inventory/reservation-service');
    const placed = await place(`g-${randomUUID()}@x.test`, 'mpesa_daraja', { identityVerified: false });
    const id = required(placed.order, 'the order').id;
    expect(await InventoryReservationService.reholdOrder(id)).toEqual({ ok: true });
    await InventoryReservationService.releaseOrder(id, 'payment_callback_failed', 'payment:mpesa_daraja');
    const again = await InventoryReservationService.reholdOrder(id);
    expect(again.ok).toBe(false);
  });

  it('the shopper is written to that the order is held and, later, that the payment was received', async () => {
    const { sendOrderEmail } = await import('./order-emails');
    const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
    const email = `mail-${randomUUID()}@x.test`;
    const placed = await place(email, 'mpesa_daraja', { identityVerified: false, salesModule: 'ecommerce' });
    const id = required(placed.order, 'the order').id;
    expect(await sendOrderEmail(id, 'placed')).toBe('sent');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: email, subject: expect.stringContaining('We have your order') as string }));
    expect(await sendOrderEmail(id, 'paid')).toBe('sent');
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ subject: expect.stringContaining('Payment received') as string }));
    const noAddress = await place('', 'mpesa_daraja', { identityVerified: false, customerPhone: '0733000111', salesModule: 'ecommerce' });
    expect(await sendOrderEmail(required(noAddress.order, 'the order').id, 'placed')).toBe('no_address');
    send.mockRestore();
  });
});
