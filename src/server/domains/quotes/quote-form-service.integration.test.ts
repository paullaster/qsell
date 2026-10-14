import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { QuoteFormService } from './quote-form-service';
import type { SalesQuoteService } from './service';

/**
 * Choosing a customer on the quote form, and the checks a save makes on currency and payment
 * method, which the browser's word is never taken for.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('quote form choices (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let form: QuoteFormService;
  let quotes: SalesQuoteService;
  let companyId: string;
  let userId: string;
  let productId: string;
  let credit: string;
  let cash: string;
  const tag = randomUUID().slice(0, 6);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    const c = mod.getContainer();
    const company = await c.companySettings.ensureSeeded();
    companyId = company.id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Form Co');
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    await db
      .insert(schema.currencies)
      .values({ code: 'OFF', name: 'Disabled', symbol: 'O', isEnabled: false })
      .onConflictDoNothing();
    const itemTypeId = `it_qf_${tag}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id: productId,
      sku: `QF-${tag}`.toUpperCase(),
      stockCode: `QFS-${tag}`.toUpperCase(),
      name: 'Form item',
      slug: `qf-${randomUUID()}`,
      itemTypeId,
      price: '100',
      costPrice: '50',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 100,
    });
    userId = (
      await db
        .insert(schema.users)
        .values({ email: `qf-${tag}@t.test`, passwordHash: 'x', name: 'QF', role: 'manager' })
        .returning()
    )[0]?.id;
    const make = async (name: string, accountType: string) =>
      (
        await db
          .insert(schema.customers)
          .values({
            companyId,
            number: `QF${tag}${name}`,
            name: `QF ${tag} ${name}`,
            accountType,
            creditLimit: '100000',
            email: `${name}@qf.test`,
            phone: '0700',
            street: '1 Road',
            city: 'Nairobi',
            countyOrState: 'Nairobi',
            postalCode: '00100',
          })
          .returning()
      )[0]?.id;
    credit = await make('credit', 'credit');
    cash = await make('cash', 'cash');
    const { QuoteFormService: Form } = await import('./quote-form-service');
    const { SalesQuoteService: Quotes } = await import('./service');
    form = new Form();
    quotes = new Quotes();
  });

  const base = () => ({
    customerName: '',
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
    discountPercent: 0,
    shippingFee: 0,
    sections: [],
    lines: [],
  });

  describe('choosing a customer', () => {
    it('fills the form from the customer and puts a credit customer on account', async () => {
      const next = await form.chooseCustomer(base(), credit);
      expect(next).toMatchObject({
        customerId: credit,
        customerName: `QF ${tag} credit`,
        customerEmail: 'credit@qf.test',
        paymentMethod: 'on_account',
        billingAddress: { street: '1 Road', city: 'Nairobi' },
        deliveryAddress: { street: '1 Road' },
      });
    });

    it('leaves the method alone for a cash customer, and takes a credit one off account', async () => {
      expect((await form.chooseCustomer(base(), cash)).paymentMethod).toBe('mpesa_daraja');
      const onAccount = { ...base(), paymentMethod: 'on_account' };
      expect((await form.chooseCustomer(onAccount, cash)).paymentMethod).toBe('mpesa_daraja');
      expect((await form.chooseCustomer(onAccount, null)).paymentMethod).toBe('mpesa_daraja');
      expect((await form.chooseCustomer(onAccount, null)).customerId).toBeNull();
    });

    it('refuses a customer that is not a valid id, or not found', async () => {
      await expect(form.chooseCustomer(base(), 'nope')).rejects.toThrow(/from the list/);
      await expect(form.chooseCustomer(base(), randomUUID())).rejects.toThrow(/no longer/);
      await expect(form.chooseCustomer({ lines: 'x' }, cash)).rejects.toThrow(/Invalid quote/);
    });
  });

  describe('saving a quote checks what the browser said', () => {
    const quote = (over: Record<string, unknown>) =>
      ({
        ...base(),
        customerName: 'Buyer',
        deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
        lines: [{ productId, quantity: 1, discountPercent: 0 }],
        ...over,
      }) as never;

    it('refuses a currency that is disabled or unknown', async () => {
      await expect(quotes.create(userId, quote({ currency: 'OFF' }))).rejects.toThrow(
        /enabled currency/,
      );
      await expect(quotes.create(userId, quote({ currency: 'ZZZ' }))).rejects.toThrow(
        /enabled currency/,
      );
    });

    it('refuses an unknown payment method', async () => {
      await expect(quotes.create(userId, quote({ paymentMethod: 'free_money' }))).rejects.toThrow(
        /valid payment method/,
      );
    });

    it('refuses paying on account without a credit customer', async () => {
      const onAccount = { paymentMethod: 'on_account' };
      await expect(quotes.create(userId, quote(onAccount))).rejects.toThrow(/credit account/);
      await expect(
        quotes.create(userId, quote({ ...onAccount, customerId: cash })),
      ).rejects.toThrow(/credit account/);
      await expect(
        quotes.create(userId, quote({ ...onAccount, customerId: randomUUID() })),
      ).rejects.toThrow(/credit account/);
    });

    it('accepts a good quote, and paying on account for a credit customer', async () => {
      const ok = await quotes.create(userId, quote({}));
      expect(ok.currency).toBe('KES');
      const account = await quotes.create(
        userId,
        quote({ customerId: credit, paymentMethod: 'on_account' }),
      );
      expect(account.paymentMethod).toBe('on_account');
    });
  });
});
