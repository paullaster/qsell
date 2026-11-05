/**
 * Set-up for the rider tests that a person would do from other screens:
 *   tsx e2e/support/rider-fixtures.ts staff <tag>   a member of staff (a plain account that may sign in to the back office), printed with the email and first password
 *   tsx e2e/support/rider-fixtures.ts code <delivery number>  the code the customer was sent for a delivery, the way they read it in their message
 *   tsx e2e/support/rider-fixtures.ts token <order number>  the customer's tracking link token for an order
 *   tsx e2e/support/rider-fixtures.ts proof <rule>  sets what a rider must show at the door (none, code, photo, code_or_photo), so a test does not depend on the one before it
 *   tsx e2e/support/rider-fixtures.ts door-setup <any>  makes sure there is a payment method of kind cash to receive cash at the door through, and prints its name
 *   tsx e2e/support/rider-fixtures.ts door <delivery number>  what cash at the door did: the order's payment, the custody entries and whether the sale was queued for the books
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
  return { name: riders.name, id: riders.id, till: tillBank?.name ?? '', variance: 'Cash over and short E2E' };
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
  if (command === 'reset') result = await reset();
  if (result === null) throw new Error('usage: rider-fixtures staff <tag> | code <delivery number> | token <order number> | proof <rule> | door-setup | door <delivery number> | reset');
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
