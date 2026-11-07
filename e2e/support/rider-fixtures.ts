/**
 * Set-up for the rider tests that a person would do from other screens:
 *   tsx e2e/support/rider-fixtures.ts staff <tag>   a member of staff (a plain account that may sign in to the back office), printed with the email and first password
 *   tsx e2e/support/rider-fixtures.ts code <delivery number>  the code the customer was sent for a delivery, the way they read it in their message
 *   tsx e2e/support/rider-fixtures.ts token <order number>  the customer's tracking link token for an order
 *   tsx e2e/support/rider-fixtures.ts proof <rule>  sets what a rider must show at the door (none, code, photo, code_or_photo), so a test does not depend on the one before it
 *   tsx e2e/support/rider-fixtures.ts door-setup <any>  makes sure there is a payment method of kind cash to receive cash at the door through, and prints its name
 *   tsx e2e/support/rider-fixtures.ts door <delivery number>  what cash at the door did: the order's payment, the custody entries and whether the sale was queued for the books
 *   tsx e2e/support/rider-fixtures.ts mpesa-sent <delivery number>  makes it look as if the rider had sent an M-Pesa prompt for the delivery that is still waiting for the customer
 *   tsx e2e/support/rider-fixtures.ts pay-accounts <any>  makes the two books accounts rider pay goes to (a cost and what is owed to riders) and prints their names, and the name of the cash method a rider can be paid through
 *   tsx e2e/support/rider-fixtures.ts paid-order <tag>  places an order for the test shop's salt and marks it paid, and prints its number and the customer's name (for a visit to be booked for it)
 *   tsx e2e/support/rider-fixtures.ts reset <tag>   ends every rider and puts the choice of rider kinds back to the default (staff only), so other tests are not asked about riders
 */
import { execFileSync } from 'node:child_process';
import { e2eEnvironment } from './env';

const PASSWORD = 'E2eRider-Passw0rd-3';

async function staff(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const email = `e2e-staff-${tag}@example.test`.toLowerCase();
  const user = await c.usersAdmin.createUser({ email, password: PASSWORD, name: `Staff Rider ${tag}`, phone: '0711000222', role: 'super_admin' });
  return { id: user.id, email, password: PASSWORD, name: `Staff Rider ${tag}` };
}

async function codeOf(number: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveries } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ code: deliveries.handoverCode }).from(deliveries).where(eq(deliveries.number, number));
  return { code: row?.code ?? '' };
}

async function tokenOf(orderNumber: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const company = await getContainer().companySettings.ensureSeeded();
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber));
  if (order === undefined) throw new Error(`no order ${orderNumber}`);
  return { token: (await getContainer().trackingLinks.tokenFor(company.id, order.id)) ?? '' };
}

async function setProof(rule: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveryRiderSettings } = await import('@/server/db/drizzle/schema');
  const company = await getContainer().companySettings.ensureSeeded();
  await db.insert(deliveryRiderSettings).values({ companyId: company.id }).onConflictDoNothing();
  await db.update(deliveryRiderSettings).set({ proof: rule as 'none' }).where((await import('drizzle-orm')).eq(deliveryRiderSettings.companyId, company.id));
  return { proof: rule };
}

async function doorSetup(): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { paymentMethods, deliveryDoorSettings } = await import('@/server/db/drizzle/schema');
  const { and, eq } = await import('drizzle-orm');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const ctx = { companyId: company.id, actor: { type: 'user' as const, id: 'e2e' }, origin: { surface: 'e2e', action: 'door-setup' } };
  let [till] = await db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, company.id), eq(paymentMethods.kind, 'cash')));
  if (till === undefined) {
    await c.finance.paymentMethods.seedStandard(ctx);
    [till] = await db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, company.id), eq(paymentMethods.kind, 'cash')));
  }
  if (till === undefined) throw new Error('e2e fixture: no cash payment method could be made');
  // A method of its own whose account stands for "cash with riders", and an account for differences, made once.
  const { bankAccounts, glAccounts } = await import('@/server/db/drizzle/schema');
  const [tillBank] = await db.select({ name: bankAccounts.name }).from(bankAccounts).where(eq(bankAccounts.id, till.balancingBankAccountId));
  let [riders] = await db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, company.id), eq(paymentMethods.code, 'E2ERIDERS')));
  if (riders === undefined) {
    const [gl] = await db.insert(glAccounts).values({ companyId: company.id, no: '1199E2E', name: 'Cash with riders', type: 'posting', category: 'assets', normalBalance: 'debit' }).returning();
    await db.insert(glAccounts).values({ companyId: company.id, no: '6999E2E', name: 'Cash over and short E2E', type: 'posting', category: 'expense', normalBalance: 'debit' });
    const bank = await c.finance.bankAccounts.create(ctx, { code: 'E2ERIDERS', name: 'Cash with riders', kind: 'cash', currency: 'KES' });
    const made = await c.finance.paymentMethods.create(ctx, { code: 'E2ERIDERS', name: 'Cash with riders', kind: 'cash', balancingBankAccountId: bank.id, providerId: till.providerId, glAccountId: gl?.id ?? '', usableFor: ['customer_receipt'], settlementMode: 'immediate' });
    [riders] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, made.id));
  }
  if (riders === undefined) throw new Error('e2e fixture: the cash with riders method could not be made');
  // Start from "not chosen yet", so the test chooses it on the screen.
  await db.delete(deliveryDoorSettings).where(eq(deliveryDoorSettings.companyId, company.id));
  return { name: riders.name, id: riders.id, till: tillBank?.name ?? '', tillMethod: till.name, variance: 'Cash over and short E2E' };
}

async function doorState(number: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveries, orders, cashCustodyEntries, cashHandIns, financeSalesPostings } = await import('@/server/db/drizzle/schema');
  const { and, eq } = await import('drizzle-orm');
  const [d] = await db.select().from(deliveries).where(eq(deliveries.number, number));
  if (d === undefined) throw new Error(`no delivery ${number}`);
  const [o] = await db.select({ paymentStatus: orders.paymentStatus, paymentMethod: orders.paymentMethod }).from(orders).where(eq(orders.id, d.orderId));
  const entries = await db.select().from(cashCustodyEntries).where(eq(cashCustodyEntries.deliveryId, d.id));
  const queued = await db.select().from(financeSalesPostings).where(and(eq(financeSalesPostings.subjectId, d.orderId), eq(financeSalesPostings.kind, 'cash_sale')));
  const riderId = entries[0]?.riderId;
  const mine = riderId === undefined ? [] : await db.select().from(cashCustodyEntries).where(eq(cashCustodyEntries.riderId, riderId));
  const held = mine.reduce((n, e) => n + Math.round(Number(e.amount) * 100), 0) / 100;
  const handIns = riderId === undefined ? [] : await db.select().from(cashHandIns).where(eq(cashHandIns.riderId, riderId));
  return { status: d.status, door: d.doorAmount ?? '', paymentStatus: o?.paymentStatus ?? '', paymentMethod: o?.paymentMethod ?? '', custody: String(entries.length), custodyAmount: entries[0]?.amount ?? '', queued: String(queued.length), held: held.toFixed(2), handIns: String(handIns.length), handInStatus: handIns[0]?.status ?? '' };
}

async function mpesaSent(number: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveries, deliveryDoorPrompts, deliveryRunStops, deliveryRuns, orders, paymentAttempts, paymentProviderConfigs, branches } = await import('@/server/db/drizzle/schema');
  const { and, eq, isNull } = await import('drizzle-orm');
  const company = await getContainer().companySettings.ensureSeeded();
  const [d] = await db.select().from(deliveries).where(eq(deliveries.number, number));
  if (d === undefined) throw new Error(`no delivery ${number}`);
  const [o] = await db.select().from(orders).where(eq(orders.id, d.orderId));
  const [run] = await db.select({ riderId: deliveryRuns.riderId }).from(deliveryRunStops).innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryRunStops.runId)).where(and(eq(deliveryRunStops.deliveryId, d.id), isNull(deliveryRunStops.leftAt)));
  const [provider] = await db.select({ id: paymentProviderConfigs.id }).from(paymentProviderConfigs).where(eq(paymentProviderConfigs.companyId, company.id));
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.companyId, company.id));
  if (o === undefined || run?.riderId == null || provider === undefined || branch === undefined) throw new Error('e2e fixture: the delivery is not on a rider\'s run');
  await db.update(orders).set({ paymentMethod: 'mpesa_daraja', paymentMethodId: null }).where(eq(orders.id, o.id));
  const [attempt] = await db
    .insert(paymentAttempts)
    .values({ branchId: branch.id, providerConfigId: provider.id, providerCode: 'mpesa_daraja', orderId: o.id, orderNumber: o.orderNumber, amount: d.doorAmount ?? '0', callbackToken: crypto.randomUUID(), callbackUrl: 'http://localhost/cb', status: 'pending', customerPhone: '254712345678' })
    .returning({ id: paymentAttempts.id });
  if (attempt === undefined) throw new Error('e2e fixture: no attempt');
  await db.insert(deliveryDoorPrompts).values({ companyId: company.id, deliveryId: d.id, orderId: o.id, riderId: run.riderId, attemptId: attempt.id, phoneEnding: '678', amount: d.doorAmount ?? '0' });
  return { attemptId: attempt.id };
}

async function payAccounts(): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { glAccounts, paymentMethods, deliveryPaySettings } = await import('@/server/db/drizzle/schema');
  const { and, eq } = await import('drizzle-orm');
  const company = await getContainer().companySettings.ensureSeeded();
  await db.insert(glAccounts).values({ companyId: company.id, no: '6277E2E', name: 'Rider pay E2E', type: 'posting', category: 'expense', normalBalance: 'debit' }).onConflictDoNothing();
  await db.insert(glAccounts).values({ companyId: company.id, no: '2199E2E', name: 'Owed to riders E2E', type: 'posting', category: 'liabilities', normalBalance: 'credit' }).onConflictDoNothing();
  // Not chosen yet, so the test chooses them on the screen.
  await db.update(deliveryPaySettings).set({ expenseGlAccountId: null, payableGlAccountId: null }).where(eq(deliveryPaySettings.companyId, company.id));
  const [till] = await db.select({ name: paymentMethods.name }).from(paymentMethods).where(and(eq(paymentMethods.companyId, company.id), eq(paymentMethods.kind, 'cash'), eq(paymentMethods.code, 'CASH')));
  const [any] = till === undefined ? await db.select({ name: paymentMethods.name }).from(paymentMethods).where(and(eq(paymentMethods.companyId, company.id), eq(paymentMethods.kind, 'cash'))) : [till];
  return { expense: 'Rider pay E2E', payable: 'Owed to riders E2E', method: any?.name ?? '' };
}

async function paidOrder(tag: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const { OrderWriteService } = await import('@/server/domains/orders/write-service');
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const [salt] = await db.select({ id: products.id }).from(products).where(eq(products.name, 'Salt 500g'));
  if (salt === undefined) throw new Error('The test shop has no Salt 500g.');
  // Some salt on the main shelf in the stock ledger, so a visit has something to use.
  const container = (await import('@/server/di/container')).getContainer();
  const company = await container.companySettings.ensureSeeded();
  const shelf = await container.stockLocations.ensureDefault(company.id);
  await db.transaction((tx) => container.stockLedger.post(tx, { companyId: company.id, productId: salt.id, locationId: shelf.id, type: 'receipt', quantity: 20, unitCost: 10, actor: { type: 'job' } }));
  const orderNumber = `VST-${tag}-${String(Date.now()).slice(-6)}`;
  const made = await OrderWriteService.createOrder({
    orderNumber,
    customerName: `Visit Buyer ${tag}`,
    customerEmail: `visit-${tag}-${String(Date.now())}@example.test`.toLowerCase(),
    customerPhone: '0711000333',
    shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
    items: [{ productId: salt.id, quantity: 1 }],
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
  });
  if (!made.success || made.order === undefined) throw new Error(made.error);
  await OrderStages.move(db, made.order.id, 'payment_confirmed', 'succeeded', {});
  return { orderNumber, customer: `Visit Buyer ${tag}` };
}

async function reset(): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveryRiders, deliveryRiderSettings, deliveryRuns } = await import('@/server/db/drizzle/schema');
  const { inArray, sql } = await import('drizzle-orm');
  const company = await getContainer().companySettings.ensureSeeded();
  // Runs given to riders are finished with, so the riders can be let go.
  await db.update(deliveryRuns).set({ status: 'cancelled', closedAt: new Date() }).where(inArray(deliveryRuns.status, ['planned', 'started']));
  await db.update(deliveryRiders).set({ status: 'ended', statusReason: 'end of the test', statusChangedAt: sql`now()` }).where(inArray(deliveryRiders.status, ['active', 'paused']));
  await db.delete(deliveryRiderSettings).where(sql`${deliveryRiderSettings.companyId} = ${company.id}`);
  return { reset: 'yes' };
}

async function main(): Promise<void> {
  const [command, tag] = process.argv.slice(2);
  let result: Record<string, string> | null = null;
  if (command === 'staff' && tag !== undefined) result = await staff(tag);
  if (command === 'code' && tag !== undefined) result = await codeOf(tag);
  if (command === 'token' && tag !== undefined) result = await tokenOf(tag);
  if (command === 'proof' && tag !== undefined) result = await setProof(tag);
  if (command === 'door-setup') result = await doorSetup();
  if (command === 'door' && tag !== undefined) result = await doorState(tag);
  if (command === 'mpesa-sent' && tag !== undefined) result = await mpesaSent(tag);
  if (command === 'pay-accounts') result = await payAccounts();
  if (command === 'paid-order' && tag !== undefined) result = await paidOrder(tag);
  if (command === 'reset') result = await reset();
  if (result === null) throw new Error('usage: rider-fixtures staff <tag> | code <delivery number> | token <order number> | proof <rule> | door-setup | door <delivery number> | mpesa-sent <delivery number> | pay-accounts <any> | reset');
  process.stdout.write(`FIXTURE ${JSON.stringify(result)}\n`);
}

/** Runs one of the tools above from a test and returns its answer. */
export function riderTool(...args: string[]): Record<string, string> {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/rider-fixtures.ts', ...args], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the rider tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}

if (process.argv[1]?.endsWith('rider-fixtures.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
