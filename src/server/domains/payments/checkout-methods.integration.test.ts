import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/**
 * A customer paying at checkout goes through the payment method of the order's branch: the
 * provider's credentials are used, and the order is pinned to the method so the books post to
 * its bank account and G/L account.   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('checkout through payment methods (database)', () => {
  type Db = import('@/server/db/drizzle/client').DrizzleDb;
  let db: Db;
  let schema: typeof import('@/server/db/drizzle/schema');
  let fin: import('@/server/domains/finance').FinanceServices;
  let service: import('./service').PaymentService;
  let companyId: string;
  let ctx: import('@/server/domains/finance/errors').FinanceContext;
  let branchA: import('@/server/db/drizzle/schema').BranchRow;
  let branchB: import('@/server/db/drizzle/schema').BranchRow;
  let providerId: string;
  let methodA: string;
  let methodB: string;
  const seen: { creds: Record<string, string>; baseUrl: string }[] = [];
  const run = randomUUID().slice(0, 6).toUpperCase();
  let seq = 0;

  const order = async (branchId: string) => {
    seq += 1;
    const id = `co_${run}_${seq}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, payment_status)
      VALUES (${id}, ${`CO-${run}-${seq}`}, 'u', ${branchId}::uuid, 'n', 'e@x.io', '254700000001', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 100, 16, 0, 116, 'mpesa_daraja', 'pending')`);
    return { id, number: `CO-${run}-${seq}` };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { getContainer } = await import('@/server/di/container');
    const { PaymentService } = await import('./service');
    const { PaymentRegistry } = await import('./registry');
    const c = getContainer();
    fin = c.finance;
    // The provider's own adapter is replaced by one that only records what it was given.
    const fake = {
      code: 'mpesa_daraja' as const,
      capabilities: ['collect'] as const,
      async initiate(_input: unknown, creds: Record<string, string>, _settings: unknown, baseUrl: string) {
        seen.push({ creds, baseUrl });
        return { status: 'pending' as const, providerReference: 'CHK1', customerMessage: 'STK sent' };
      },
      async handleCallback() {
        return { ok: true, status: 'successful' as const };
      },
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
    };
    service = new PaymentService(db, new PaymentRegistry([fake]));
    const [company] = await db.insert(schema.companySettings).values({ legalName: 'CK', tradingName: 'CK', email: 'a@b.c', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P', publicBaseUrl: 'https://shop.example' }).returning();
    companyId = company.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    ctx = { companyId, actor: { type: 'user', id: 'tester' }, origin: { surface: 'test', action: 'run' } };
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
    [branchA, branchB] = await Promise.all(['A', 'B'].map(async (n) => (await db.insert(schema.branches).values({ companyId, code: `CK${run}${n}`, name: `Branch ${n}`, isDefault: false }).returning())[0]));
    providerId = (await fin.paymentProviders.create(ctx, { providerCode: 'mpesa_daraja', displayName: 'M-Pesa Checkout' })).id;
    await fin.paymentProviders.setCredentials(ctx, providerId, { consumerKey: 'K', consumerSecret: 'S', passkey: 'P', shortcode: '174379' });
    await db.update(schema.paymentProviderConfigs).set({ isEnabled: true, lastTestOk: true }).where(eq(schema.paymentProviderConfigs.id, providerId));
    const accts = await fin.setup.listAccounts(companyId);
    const mk = async (branch: typeof branchA, gl: string, name: string) => {
      const b = await fin.bankAccounts.create(ctx, { code: `CKB${run}${++seq}`, name, kind: 'mobile_money', currency: 'KES' });
      return (await fin.paymentMethods.create(ctx, { code: `CKM${run}${seq}`, name, kind: 'mobile_money', balancingBankAccountId: b.id, providerId, branchId: branch.id, glAccountId: gl })).id;
    };
    methodA = await mk(branchA, accts.find((a) => a.no === '1125')!.id, 'M-Pesa — A');
    methodB = await mk(branchB, accts.find((a) => a.no === '1130')!.id, 'M-Pesa — B');
  });

  it('the branch\'s own method is used: the provider\'s credentials are sent and the order is pinned to the method', async () => {
    const o = await order(branchA.id);
    const out = await service.initiatePayment({ branch: branchA, providerCode: 'mpesa_daraja', orderId: o.id, orderNumber: o.number, amount: 116, currency: 'KES', customerName: 'n', customerEmail: 'e@x.io', customerPhone: '254700000001' });
    expect(out.attempt.status).toBe('pending');
    expect(out.attempt.providerConfigId).toBe(providerId);
    expect(seen.at(-1)!.creds).toMatchObject({ consumerKey: 'K', shortcode: '174379' });
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, o.id));
    expect(row.paymentMethodId).toBe(methodA);
    expect(row.paymentMethod).toBe('mpesa_daraja');
  });

  it('another branch goes through its own method of the same provider, to its own G/L account', async () => {
    const o = await order(branchB.id);
    await service.initiatePayment({ branch: branchB, providerCode: 'mpesa_daraja', orderId: o.id, orderNumber: o.number, amount: 116, currency: 'KES', customerName: 'n', customerEmail: 'e@x.io', customerPhone: '254700000001' });
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, o.id));
    expect(row.paymentMethodId).toBe(methodB);
    const [m] = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.id, row.paymentMethodId!));
    const [gl] = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.id, m.glAccountId));
    expect(gl.no).toBe('1130');
  });

  it('a provider that is switched off takes no payment, and says so', async () => {
    await db.update(schema.paymentProviderConfigs).set({ isEnabled: false }).where(eq(schema.paymentProviderConfigs.id, providerId));
    const o = await order(branchA.id);
    await expect(service.initiatePayment({ branch: branchA, providerCode: 'mpesa_daraja', orderId: o.id, orderNumber: o.number, amount: 116, currency: 'KES', customerName: 'n', customerEmail: 'e@x.io', customerPhone: '254700000001' })).rejects.toThrow(/not enabled for this branch/);
    await db.update(schema.paymentProviderConfigs).set({ isEnabled: true }).where(eq(schema.paymentProviderConfigs.id, providerId));
  });

  it('an order made through the order repository picks the method of its branch and provider', async () => {
    const { OrderRepository } = await import('@/server/domains/orders/repository');
    const repo = new OrderRepository(db);
    const base = {
      customerName: 'n', customerEmail: 'e@x.io', customerPhone: '254700000001', shippingAddress: { street: 's', city: 'c', countyOrState: 'x', country: 'k' } as never,
      items: [], subtotal: 100, tax: 16, shippingFee: 0, totalAmount: 116, currency: 'KES', status: 'pending' as const, paymentStatus: 'pending' as const, paymentMethod: 'mpesa_daraja' as const,
    };
    const rows = await Promise.all([branchA, branchB].map(async (b) => {
      seq += 1;
      const created = await repo.create({ ...base, id: `cr_${run}_${seq}`, orderNumber: `CR-${run}-${seq}` } as never, b.id).catch((e: Error) => e);
      return created;
    }));
    const [a, b] = await Promise.all(rows.map(async (r) => (r instanceof Error ? null : (await db.select().from(schema.orders).where(eq(schema.orders.id, (r as { id: string }).id)))[0] ?? null)));
    expect(rows.filter((r) => r instanceof Error).map((r) => (r).message)).toEqual([]);
    expect(a!.paymentMethodId).toBe(methodA);
    expect(b!.paymentMethodId).toBe(methodB);
  });
});
