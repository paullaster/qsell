import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

/**
 * Seeds the end-to-end database: the admin, a few products, 47 quote templates (so the
 * Autocomplete has more than a page to show), two section templates, and a cash and a credit
 * customer among 25 more. Safe to run again: it does nothing once the data is there.
 */
async function main(): Promise<void> {
  const { UserRepository } = await import('@/server/domains/auth/user-repository');
  await new UserRepository().ensureSuperAdminSeed();
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const { SalesQuoteService } = await import('@/server/domains/quotes/service');
  const { SectionTemplateService } =
    await import('@/server/domains/quotes/section-template-service');

  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const quotes = new SalesQuoteService();
  if ((await quotes.listTemplates()).length > 0) {
    console.warn('e2e seed: already seeded');
    await seedFinance();
    return;
  }
  await container.organizations.ensureDefaultOrgAndBranch(company.id, 'E2E Co');
  await db
    .insert(schema.currencies)
    .values([
      { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true },
      { code: 'USD', name: 'US Dollar', symbol: '$' },
    ])
    .onConflictDoNothing();
  const itemTypeId = `it_e2e_${randomUUID().slice(0, 8)}`;
  await db
    .insert(schema.itemTypes)
    .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });

  const products: Record<string, string> = {};
  for (const [name, price] of [
    ['Rice 5kg', '600'],
    ['Rice 10kg', '1100'],
    ['Flour 2kg', '200'],
    ['Sugar 1kg', '180'],
    ['Salt 500g', '50'],
  ] as const) {
    const id = `prod_${randomUUID()}`;
    products[name] = id;
    const code = name.replace(/\W/g, '').slice(0, 6).toUpperCase();
    await db.insert(schema.products).values({
      id,
      sku: `E2E-${code}`,
      stockCode: `E2ES-${code}`,
      name,
      slug: `e2e-${randomUUID()}`,
      itemTypeId,
      price,
      costPrice: '100',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 500,
    });
  }

  const user = (await db.select().from(schema.users).limit(1)).at(0);
  if (user === undefined) throw new Error('e2e seed: the admin was not created');
  const line = (name: string, quantity = 1) => ({
    sectionId: null,
    productId: products[name] ?? '',
    quantity,
    priceMode: 'catalog' as const,
    discountPercent: 0,
  });
  const template = (name: string, lines: ReturnType<typeof line>[]) => ({
    name,
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
    showBillingAddress: false,
    validityDays: 30,
    quoteDiscountPercent: 0,
    shippingFee: 0,
    tags: [],
    isDefault: false,
    sections: [],
    lines,
  });
  await quotes.saveTemplate(
    user.id,
    null,
    template('Pack 5kg', [line('Rice 5kg', 2), line('Sugar 1kg')]) as never,
  );
  await quotes.saveTemplate(
    user.id,
    null,
    template('Pack 10kg', [line('Rice 10kg', 2), line('Flour 2kg')]) as never,
  );
  for (let i = 1; i <= 45; i += 1) {
    const name = `Bulk template ${String(i).padStart(2, '0')}`;
    await quotes.saveTemplate(user.id, null, template(name, [line('Salt 500g')]) as never);
  }

  const sections = new SectionTemplateService();
  const item = (name: string, quantity: number) => ({
    productId: products[name] ?? '',
    quantity,
    priceMode: 'catalog',
    discountPercent: 0,
  });
  await sections.save(user.id, null, {
    name: 'Baking set',
    sectionTitle: 'Baking',
    showLines: true,
    lines: [item('Flour 2kg', 3)],
  });
  await sections.save(user.id, null, {
    name: 'Tea set',
    sectionTitle: 'Tea time',
    showLines: false,
    lines: [item('Sugar 1kg', 1)],
  });

  const customer = (name: string, accountType: string, i: number) => ({
    companyId: company.id,
    number: `E2E${String(i).padStart(3, '0')}`,
    name,
    accountType,
    creditLimit: '100000',
    email: `${name.toLowerCase().replace(/\W+/g, '.')}@e2e.test`,
    phone: `07000${String(i).padStart(5, '0')}`,
    street: `${String(i)} Test Road`,
    city: 'Nairobi',
    countyOrState: 'Nairobi',
    postalCode: '00100',
  });
  await db
    .insert(schema.customers)
    .values([
      customer('Alice Cash', 'cash', 1),
      customer('Bob Credit', 'credit', 2),
      ...Array.from({ length: 25 }, (_, i) =>
        customer(`Bulk customer ${String(i + 1).padStart(2, '0')}`, 'cash', i + 3),
      ),
    ]);

  // Thirty-two quotes, so the list has more than a page (25) to show.
  for (let i = 1; i <= 32; i += 1) {
    const quote = await quotes.create(user.id, {
      customerName: `List customer ${String(i).padStart(2, '0')}`,
      customerEmail: `list${String(i)}@e2e.test`,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      sections: [],
      lines: [{ productId: products['Salt 500g'] ?? '', quantity: 1, discountPercent: 0 }],
    } as never);
    if (i % 8 === 0) {
      await db
        .update(schema.salesQuotes)
        .set({ status: 'cancelled' })
        .where(eq(schema.salesQuotes.id, quote.id));
    }
  }
  await seedFinance();
  console.warn('e2e seed: done');
}

/**
 * Finance for the receipt and refund screens: the chart of accounts, a bank, a cash method that can
 * be refunded through, and one posted receipt with money left unapplied (so there is something to
 * refund). Safe to run again.
 */
async function seedFinance(): Promise<void> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const container = getContainer();
  const fin = container.finance;
  const company = await container.companySettings.ensureSeeded();
  const user = (await db.select().from(schema.users).limit(1)).at(0);
  if (user === undefined) throw new Error('e2e seed: the admin was not created');
  const ctx = { companyId: company.id, actor: { type: 'user' as const, id: user.id }, origin: { surface: 'e2e', action: 'seed' } };
  await container.reasonCodes.ensureSystemReasons(company.id);
  if ((await fin.setup.getSettings(company.id)) === null) {
    await fin.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' });
  }
  const methods = await fin.paymentMethods.list(company.id);
  if (methods.some((m) => m.method.code === 'E2ECASH')) return;
  const bank = await fin.bankAccounts.create(ctx, { code: 'E2EBANK', name: 'E2E Bank', kind: 'bank', currency: 'KES' });
  const accounts = await fin.setup.listAccounts(company.id);
  const gl = accounts.find((a) => a.no === '1120');
  const manual = (await fin.paymentMethods.providerChoices(company.id)).find((p) => p.isSystem);
  if (gl === undefined || manual === undefined) throw new Error('e2e seed: the chart of accounts is incomplete');
  const method = await fin.paymentMethods.create(ctx, {
    code: 'E2ECASH',
    name: 'E2E Cash',
    kind: 'cash',
    balancingBankAccountId: bank.id,
    providerId: manual.id,
    glAccountId: gl.id,
    usableFor: ['customer_receipt', 'customer_refund'],
    refundDestination: 'manual',
  });
  const alice = (await db.select().from(schema.customers).where(eq(schema.customers.number, 'E2E001'))).at(0);
  if (alice === undefined) throw new Error('e2e seed: the customer was not created');
  const receipt = await fin.receipts.create(ctx, {
    customerId: alice.id,
    paymentMethodId: method.id,
    amount: '500.00',
    paymentDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }),
    externalReference: 'E2E-SEED-1',
  });
  await fin.receipts.post(ctx, receipt.id, { allocate: 'none' });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
