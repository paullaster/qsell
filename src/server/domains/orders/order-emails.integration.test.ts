import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { OrderWriteService } from './write-service';

/**
 * The mails about a web shop order, to the shopper and to the company's people, as set up in Email routing (database).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('web shop order mails (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let write: typeof OrderWriteService;
  let companyId: string;
  let branchId: string;
  let productId: string;
  const actor = { type: 'user' as const, id: 'order-emails-test' };
  const reason = { code: 'POLICY_CHANGE' };

  // A phone of its own: other tests search the orders list by phone in the same database.
  const phone = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const person = async (name: string) => {
    const [row] = await db.insert(schema.users).values({ email: `${name}-${randomUUID().slice(0, 6)}@acme.test`, passwordHash: 'x', name, role: 'manager' }).returning();
    if (row === undefined) throw new Error('no user');
    return row;
  };
  const place = async (customerEmail: string) => {
    const result = await write.createOrder({
      branchId,
      orderNumber: `OE-${randomUUID()}`,
      customerName: 'Amina Wanjiru',
      customerEmail,
      customerPhone: phone,
      shippingAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 2 }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    if (!result.success || result.order === undefined) throw new Error('order not placed');
    return result.order;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    write = (await import('./write-service')).OrderWriteService;
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await db.update(schema.companySettings).set({ email: 'info@acme.test' }).where(eq(schema.companySettings.id, companyId));
    const itemTypeId = `it_oe_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Order Mail Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `OE-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `OES-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Order mail tea', slug: `oe-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 50 });
  });

  afterAll(async () => {
    await db.delete(schema.emailRoutes).where(eq(schema.emailRoutes.companyId, companyId));
  });

  it('writes to the shopper as before, and tells nobody on the team until they have chosen to be told', async () => {
    const { sendOrderEmail } = await import('./order-emails');
    const order = await place(`shopper-${randomUUID().slice(0, 6)}@customer.test`);
    const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
    try {
      expect(await sendOrderEmail(order.id, 'placed')).toBe('sent');
      expect(send.mock.calls[0]?.[0]).toMatchObject({ to: order.customerEmail });
      expect(await sendOrderEmail(order.id, 'placed', 'staff')).toBe('off');
      expect(await sendOrderEmail(order.id, 'paid', 'staff')).toBe('off');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it('tells the people chosen, with copies and where replies go, when an order is placed or paid', async () => {
    const { sendOrderEmail } = await import('./order-emails');
    const a = await person('alpha');
    const b = await person('bravo');
    await c.emailRoutes.save(companyId, 'shop_order_placed_staff', { enabled: true, to: [{ kind: 'staff', userId: a.id }, { kind: 'staff', userId: b.id }], cc: [{ kind: 'company' }], replyTo: [{ kind: 'customer' }] }, actor, reason);
    await c.emailRoutes.save(companyId, 'shop_order_paid_staff', { enabled: true, to: [{ kind: 'staff', userId: a.id }] }, actor, reason);
    const order = await place(`shopper-${randomUUID().slice(0, 6)}@customer.test`);
    const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
    try {
      expect(await sendOrderEmail(order.id, 'placed', 'staff')).toBe('sent');
      const placed = send.mock.calls[0]?.[0];
      expect(placed).toMatchObject({ to: a.email, toMore: [b.email], cc: ['info@acme.test'], replyTo: [order.customerEmail] });
      expect(placed?.subject).toContain('New web shop order');
      expect(placed?.text).toContain(phone);
      expect(await sendOrderEmail(order.id, 'paid', 'staff')).toBe('sent');
      expect(send.mock.calls[1]?.[0]).toMatchObject({ to: a.email });
    } finally {
      send.mockRestore();
    }
  });

  it('still tells the team of an order whose shopper left no email address, and says there was nobody to write to for the shopper', async () => {
    const { sendOrderEmail } = await import('./order-emails');
    const order = await place('');
    const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
    try {
      expect(await sendOrderEmail(order.id, 'placed')).toBe('no_address');
      expect(await sendOrderEmail(order.id, 'placed', 'staff')).toBe('sent');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it('can be switched off or copied for the shopper too', async () => {
    const { sendOrderEmail } = await import('./order-emails');
    const copy = await person('copy');
    await c.emailRoutes.save(companyId, 'shop_order_paid_customer', { enabled: true, to: [{ kind: 'customer' }], bcc: [{ kind: 'staff', userId: copy.id }], replyTo: [{ kind: 'company' }] }, actor, reason);
    await c.emailRoutes.save(companyId, 'shop_order_placed_customer', { enabled: false }, actor, reason);
    const order = await place(`shopper-${randomUUID().slice(0, 6)}@customer.test`);
    const send = vi.spyOn(c.email, 'send').mockResolvedValue({ ok: true } as never);
    try {
      expect(await sendOrderEmail(order.id, 'placed')).toBe('off');
      expect(await sendOrderEmail(order.id, 'paid')).toBe('sent');
      expect(send.mock.calls[0]?.[0]).toMatchObject({ to: order.customerEmail, bcc: [copy.email], replyTo: ['info@acme.test'] });
    } finally {
      send.mockRestore();
    }
  });
});
