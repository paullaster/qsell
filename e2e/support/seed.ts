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
    await seedRefundExtras();
    await seedApprovals();
    await seedUnitDocuments();
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

  // A product can only be saved in the editor with a category, so the seeded ones have one.
  const categoryId = `cat_e2e_${randomUUID().slice(0, 8)}`;
  await db.insert(schema.categories).values({ id: categoryId, name: 'E2E Pantry', slug: categoryId });

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
      categoryId,
      categoryName: 'E2E Pantry',
      price,
      costPrice: '100',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 500,
    });
  }

  // Fish sold by the kilogram, one for each project (they share this database and each saves its own changes).
  const kilogram = (await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.code, 'KG'))).at(0);
  if (kilogram === undefined) throw new Error('e2e seed: the standard units are missing');
  for (const label of ['Desktop', 'Phone']) {
    await db.insert(schema.products).values({
      id: `prod_${randomUUID()}`,
      sku: `E2E-FISH-${label.toUpperCase()}`,
      stockCode: `E2ES-FISH-${label.toUpperCase()}`,
      name: `Fish kg ${label}`,
      slug: `e2e-${randomUUID()}`,
      itemTypeId,
      categoryId,
      categoryName: 'E2E Pantry',
      baseUnitId: kilogram.id,
      price: '300',
      costPrice: '120',
      taxRate: '0',
      isTaxInclusive: true,
      stockQuantity: 0,
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
  await seedRefundExtras();
  await seedApprovals();
  await seedUnitDocuments();
  console.warn('e2e seed: done');
}

/**
 * Finance for the receipt and refund screens: the chart of accounts, a bank, a cash method that can
 * be refunded through, and one posted receipt with money left unapplied (so there is something to
 * refund). Safe to run again.
 */
/**
 * 27 documents waiting on the admin for approval, sent by the admin (a step may allow self-approval), so the
 * inbox and "my requests" have more than a page to show. Safe to run again.
 */
async function seedApprovals(): Promise<void> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const admin = (await db.select().from(schema.users).limit(1)).at(0);
  if (admin === undefined) throw new Error('e2e seed: the admin was not created');
  const existing = await db.select({ id: schema.approvalWorkflows.id }).from(schema.approvalWorkflows).where(eq(schema.approvalWorkflows.code, 'E2E-INBOX')).limit(1);
  if (existing.length > 0) return;
  await container.reasonCodes.ensureSystemReasons(company.id);
  // The seed only writes the requests; nothing here may touch real orders.
  container.approvals.registerDocument('sales_order', { snapshot: () => Promise.resolve({}), onReleased: () => Promise.resolve(), onRejected: () => Promise.resolve(), onReopened: () => Promise.resolve() });
  const actor = { type: 'user' as const, id: admin.id };
  const customerId = randomUUID();
  const wf = await container.approvalConfig.createWorkflow(company.id, { code: 'E2E-INBOX', name: 'E2E inbox', trigger: 'sales_order.submitted' }, actor);
  await container.approvalConfig.saveDraft(company.id, wf.id, { conditions: { op: 'eq', field: 'customer.id', value: customerId }, steps: [{ sequence: 1, name: 'Admin', approver: { type: 'user', userId: admin.id }, allowSelfApproval: true }] } as never, actor);
  await container.approvalConfig.publish(company.id, wf.id, actor, { code: 'POLICY_CHANGE' });
  for (let i = 0; i < 27; i++) {
    await db.transaction((t) =>
      container.approvals.submit({ companyId: company.id, trigger: 'sales_order.submitted', documentId: `E2E-INBOX-${String(i).padStart(2, '0')}`, requestedBy: admin.id, amount: 5 + i, snapshot: { customer: { id: customerId } } }, t),
    );
  }
}

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

/**
 * What the refund-extras screens need, once for each browser project (desktop and phone) so the two never
 * use each other's records: approved bank-transfer refunds to put in a file, a file made by another person
 * for the admin to confirm, a paid refund whose money can come back, a refund whose M-Pesa payment is in
 * doubt, and a wallet with two adjustment requests made by another person. Safe to run again.
 */
async function seedRefundExtras(): Promise<void> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const container = getContainer();
  const fin = container.finance;
  const company = await container.companySettings.ensureSeeded();
  const admin = (await db.select().from(schema.users).limit(1)).at(0);
  if (admin === undefined) throw new Error('e2e seed: the admin was not created');
  const done = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.number, 'E2E-RX-DESKTOP-1')).limit(1);
  if (done.length > 0) return;
  const maker = (await db.insert(schema.users).values({ email: `e2e-maker-${randomUUID()}@e2e.test`, passwordHash: 'x', name: 'E2E Maker', role: 'manager' }).returning())[0];
  const adminCtx = { companyId: company.id, actor: { type: 'user' as const, id: admin.id }, origin: { surface: 'e2e', action: 'seed' } };
  const makerCtx = { ...adminCtx, actor: { type: 'user' as const, id: maker.id } };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  const methods = await fin.paymentMethods.list(company.id);
  const cash = methods.find((m) => m.method.code === 'E2ECASH')?.method;
  if (cash === undefined) throw new Error('e2e seed: the cash method is missing');
  const manual = (await fin.paymentMethods.providerChoices(company.id)).find((p) => p.isSystem);
  if (manual === undefined) throw new Error('e2e seed: the manual provider is missing');
  const gl = (await fin.setup.listAccounts(company.id)).find((a) => a.no === '1120');
  if (gl === undefined) throw new Error('e2e seed: the chart of accounts is incomplete');
  const bankId = cash.balancingBankAccountId;
  await db.update(schema.bankAccounts).set({ details: { accountNumber: '0011223344', bankName: 'E2E Bank' } }).where(eq(schema.bankAccounts.id, bankId));
  const transfer = await fin.paymentMethods.create(adminCtx, { code: 'E2EBT', name: 'E2E Bank transfer', kind: 'bank_transfer', balancingBankAccountId: bankId, providerId: manual.id, glAccountId: gl.id, usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' });
  const daraja = await fin.paymentProviders.create(adminCtx, { providerCode: 'mpesa_daraja', displayName: 'E2E Daraja' });
  await fin.creditPolicy.save(adminCtx, { groupCode: null, walletEnabled: true, allowDeposits: true, overpaymentDefault: 'ask', autoApply: 'never', creditNoteExcess: 'ask', refundsEnabled: true, walletCashOut: true, maxBalance: null, label: 'Wallet' });

  const bankDetails = { bankName: 'KCB', accountNumber: '1234567890', accountName: 'E2E Customer' };
  let n = 0;
  const customer = async (tag: string, label: string) => {
    n += 1;
    const [c] = await db.insert(schema.customers).values({ companyId: company.id, number: `E2E-RX-${tag.toUpperCase()}-${String(n)}`, name: `${label} ${tag}`, phone: `0722${String(100000 + n)}`, accountType: 'cash', creditLimit: '0' }).returning();
    return c;
  };
  const unapplied = async (customerId: string, amount: string, deposit = false) => {
    const r = await fin.receipts.create(adminCtx, { customerId, paymentMethodId: cash.id, amount, paymentDate: today, isDeposit: deposit });
    await fin.receipts.post(adminCtx, r.id, { allocate: 'none' });
    return r.id;
  };
  const refund = async (customerId: string, receiptId: string, amount: string, methodId: string, details: Record<string, string>, by = adminCtx) => {
    const r = await fin.refunds.create(by, { customerId, sourceKind: 'receipt_unapplied', sourceId: receiptId, amount, paymentMethodId: methodId, payoutDetails: details, reasonCode: 'CUSTOMER_REQUEST' });
    await fin.refunds.submit(by, r.id);
    return r;
  };

  for (const [tag, bump] of [['Desktop', 0], ['Phone', 1]] as const) {
    // two approved bank transfers to choose from when making a file
    for (const [label, amount] of [['Bank A', 410 + bump], ['Bank B', 120 + bump]] as const) {
      const c = await customer(tag, label);
      await refund(c.id, await unapplied(c.id, String(amount)), String(amount), transfer.id, bankDetails);
    }
    // a file another person made, waiting for the bank's confirmation
    const filed = await customer(tag, 'Filed');
    const filedRefund = await refund(filed.id, await unapplied(filed.id, String(205 + bump)), String(205 + bump), transfer.id, bankDetails);
    const filedFile = await fin.refundFiles.generate(makerCtx, { methodId: transfer.id, format: 'csv', refundIds: [filedRefund.id] });
    // The test server has no media storage, so the bank's confirmation is on the file already.
    await fin.refundFiles.attach(makerCtx, filedFile.id, { mediaAssetId: 'media_e2e', fileName: 'bank-confirmation.png' });
    // a refund that was paid, whose money can come back
    const paid = await customer(tag, 'Returned');
    const paidRefund = await refund(paid.id, await unapplied(paid.id, String(300 + bump)), String(300 + bump), cash.id, { recipientName: 'E2E Customer' });
    await fin.refunds.attach(adminCtx, paidRefund.id, { mediaAssetId: 'media_e2e', fileName: 'slip.jpg' });
    await fin.refunds.recordPayout(adminCtx, paidRefund.id, { paidFromMethodId: cash.id, reference: `E2E-PAID-${tag}` });
    // an M-Pesa payment that could not be confirmed
    const doubt = await customer(tag, 'Doubt');
    const doubtRefund = await refund(doubt.id, await unapplied(doubt.id, String(90 + bump)), String(90 + bump), cash.id, { recipientName: 'E2E Customer' });
    await db.insert(schema.providerOperations).values({ companyId: company.id, providerId: daraja.id, methodId: cash.id, operation: 'b2c', status: 'in_doubt', idempotencyKey: `e2e:refund:${doubtRefund.id}:payout:1`, subjectType: 'refund', subjectId: doubtRefund.id, amount: String(90 + bump), input: {}, failureCode: 'NO_RESULT', failureReason: 'No answer arrived. It must be checked with the platform before anything is done again.' });
    // a wallet, with a take-off asked for by someone else
    const holder = await customer(tag, 'Wallet');
    await unapplied(holder.id, '400', true);
    const asked = await fin.creditAdjustments.request(makerCtx, { kind: 'wallet_decrease', customerId: holder.id, amount: String(40 + bump), reasonCode: 'DATA_ENTRY_ERROR' });
    await fin.creditAdjustments.submit(makerCtx, asked.id);
  }
}

/**
 * What the unit screens that look at documents need: fish sold by the kilogram (and by the crate of 20 kg) on the shop, and for
 * each project an invoiced order of 3 crates, so a credit note can be issued in crates. Safe to run again.
 */
async function seedUnitDocuments(): Promise<void> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const { sql } = await import('drizzle-orm');
  const container = getContainer();
  const existing = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.sku, 'E2E-FISH-SHOP')).limit(1);
  if (existing.length > 0) return;
  const kilogram = (await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.code, 'KG'))).at(0);
  const category = (await db.select().from(schema.categories).where(eq(schema.categories.name, 'E2E Pantry'))).at(0);
  const itemType = (await db.select().from(schema.itemTypes).limit(1)).at(0);
  const branch = (await db.select().from(schema.branches).limit(1)).at(0);
  if (kilogram === undefined || category === undefined || itemType === undefined || branch === undefined) throw new Error('e2e seed: the units, category or branch are missing');
  const { emptyUnitDraft } = await import('@/lib/unit-rules');
  const crate = await container.unitWriter.create({ ...emptyUnitDraft(), code: 'E2ECRATE', name: 'E2E crate', kind: 'packaging', decimals: '0' });
  const fish = `prod_${randomUUID()}`;
  await db.insert(schema.products).values({
    id: fish,
    sku: 'E2E-FISH-SHOP',
    stockCode: 'E2ES-FISH-SHOP',
    name: 'Fish kg Shop',
    slug: `e2e-${randomUUID()}`,
    itemTypeId: itemType.id,
    categoryId: category.id,
    categoryName: 'E2E Pantry',
    baseUnitId: kilogram.id,
    price: '300',
    costPrice: '120',
    taxRate: '0',
    isTaxInclusive: true,
    stockQuantity: 25.5,
    specifications: [
      { key: 'Origin', value: 'Lake Victoria' },
      { key: 'Grade', value: 'A' },
    ],
  });
  await db.insert(schema.productUnits).values({ productId: fish, unitId: crate.id, qtyPerBase: '20' });
  for (const label of ['Desktop', 'Phone']) {
    const id = `e2e_crate_${label.toLowerCase()}`;
    const number = `E2E-CR-${label.toUpperCase()}`;
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method)
      VALUES (${id}, ${number}, 'u', ${branch.id}::uuid, ${`Crate buyer ${label}`}, 'crate@e2e.test', '0700000000', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 18000, 0, 0, 18000, 'mpesa_daraja')`);
    await db.insert(schema.orderItems).values({
      orderId: id,
      productId: fish,
      productName: 'Fish kg Shop',
      sku: 'E2E-FISH-SHOP',
      quantity: 60,
      unitPrice: '300.00',
      totalPrice: '18000.00',
      imageUrl: '',
      unitCost: '120.0000',
      unitId: crate.id,
      unitCode: 'E2ECRATE',
      enteredQuantity: 3,
      qtyPerUnit: '20.0000000000',
      enteredUnitPrice: '6000.0000',
    });
    await db.insert(schema.inventoryMovements).values({ id: `mv_${randomUUID()}`, productId: fish, productName: 'Fish kg Shop', changeAmount: 0, previousStock: 25.5, newStock: 25.5, changeType: 'order_fulfillment', referenceId: id });
    await db.insert(schema.invoiceDocuments).values({ orderId: id, orderNumber: number, invoiceNumber: `E2E-TI-${label.toUpperCase()}`, documentType: 'tax_invoice', customerEmail: 'crate@e2e.test', customerName: `Crate buyer ${label}`, currency: 'KES', subtotal: '18000', tax: '0', shippingFee: '0', totalAmount: '18000', pdfStorageKey: 'x.pdf', emailStatus: 'not_sent', meta: {} });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
