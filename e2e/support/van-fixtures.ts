/**
 * Set-up for the van sales tests that a person would do from other screens:
 *   tsx e2e/support/van-fixtures.ts customer <tag> <n>   n customers with a phone and a town, printed as their names (a person makes these under Customers)
 *   tsx e2e/support/van-fixtures.ts product <tag>        a product kept in stock, counted in whole pieces, printed with its name (made under Products)
 *   tsx e2e/support/van-fixtures.ts par <route name> <product id> <quantity>  sets the usual stock of a route's van to one product (set under Routes)
 *   tsx e2e/support/van-fixtures.ts day-route <tag> [admin]  ... with `admin`, the rep is the e2e admin account itself, so the browser can run the day as the rep
 *   tsx e2e/support/van-fixtures.ts reset-rep <any>      cancels the open days of the e2e admin as a rep and closes its open shifts, so the next test starts clean
 *   tsx e2e/support/van-fixtures.ts order <customer name> <product id> <quantity>  a paid sales order for that customer, holding its stock (taken under Sales Orders)
 *   tsx e2e/support/van-fixtures.ts out-day <route name> <place code> <date>  a day planned, loaded from that place as the route's usual stock suggests, signed for and sent out, as the e2e admin rep
 *   tsx e2e/support/van-fixtures.ts refundable <any>  lets cash pay customers back (set under Payment methods)
 *   tsx e2e/support/van-fixtures.ts owe <customer name> <amount>  an open invoice on that customer's account (a credit sale leaves one)
 *   tsx e2e/support/van-fixtures.ts limit <van name> <amount>  the most cash the van should carry (set under Vans)
 *   tsx e2e/support/van-fixtures.ts moment <payment|dispatch|delivery>  when the shop issues stock (set under Stock settings)
 *   tsx e2e/support/van-fixtures.ts day-route <tag>      a route ready to plan a day on: both modes on, a van, a rep, and three customers visited every Monday; printed with their names (set up under Van sales)
 */
import { execFileSync } from 'node:child_process';
import { e2eEnvironment } from './env';

async function customers(tag: string, count: number): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { customers: table } = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const company = await getContainer().companySettings.ensureSeeded();
  const names: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const name = `Duka ${tag} ${String(i)}`;
    await db.insert(table).values({ companyId: company.id, number: `VF${tag}${String(i)}`.toUpperCase(), name, phone: `07110${String(i).padStart(5, '0')}`, city: 'Kiambu', accountType: 'cash' });
    names.push(name);
  }
  return { names: names.join('|') };
}

async function product(tag: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { itemTypes, products } = await import('@/server/db/drizzle/schema');
  const { randomUUID } = await import('node:crypto');
  const typeId = `it_vf_${tag}`;
  await db.insert(itemTypes).values({ id: typeId, code: Math.floor(Math.random() * 1e9), name: typeId }).onConflictDoNothing();
  const name = `Soda crate ${tag}`;
  await db.insert(products).values({ id: `prod_${randomUUID()}`, sku: `VF-${tag}`.toUpperCase(), stockCode: `VFS-${tag}`.toUpperCase(), name, slug: `vf-${tag}-${randomUUID().slice(0, 6)}`, itemTypeId: typeId, price: '1200', costPrice: '900' });
  return { name };
}

async function adminRep(): Promise<{ id: string; name: string }> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { salesReps, users } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const { getContainer } = await import('@/server/di/container');
  const { E2E_ADMIN_EMAIL } = await import('./constants');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [admin] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, E2E_ADMIN_EMAIL));
  if (admin === undefined) throw new Error('e2e fixture: the e2e admin does not exist');
  const [have] = await db.select({ id: salesReps.id, name: salesReps.name }).from(salesReps).where(eq(salesReps.userId, admin.id));
  if (have !== undefined) return have;
  const made = await c.salesReps.create(company.id, { type: 'user', id: 'e2e' }, { userId: admin.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: { maxDiscountPercent: 5, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
  return { id: made.id, name: made.name };
}

async function resetRep(): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { salesReps, shifts, users, vanDays } = await import('@/server/db/drizzle/schema');
  const { and, eq, inArray } = await import('drizzle-orm');
  const { E2E_ADMIN_EMAIL } = await import('./constants');
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, E2E_ADMIN_EMAIL));
  if (admin === undefined) return { reset: 'no admin' };
  const [rep] = await db.select({ id: salesReps.id }).from(salesReps).where(eq(salesReps.userId, admin.id));
  if (rep !== undefined) await db.update(vanDays).set({ status: 'cancelled', statusReason: 'Cleared by the e2e fixture' }).where(and(eq(vanDays.repId, rep.id), inArray(vanDays.status, ['planned', 'loading', 'out', 'returning', 'reconciling'])));
  await db.update(shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'e2e', declaredCash: '0', zNumber: `Z-E2E-${String(Date.now())}` }).where(and(eq(shifts.openedBy, admin.id), inArray(shifts.status, ['open', 'closing'])));
  return { reset: 'done' };
}

async function dayRoute(tag: string, asAdmin = false): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { customers: table } = await import('@/server/db/drizzle/schema');
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const actor = { type: 'user' as const, id: 'e2e' };
  await c.reasonCodes.ensureSystemReasons(company.id);
  const now = await c.vanSalesSettings.screen(company.id);
  if (!now.settings.vanSell || !now.settings.preSell) await c.vanSalesSettings.save(company.id, actor, { ...now.settings, vanSell: true, preSell: true }, now.version, { code: 'POLICY_CHANGE' });
  const branch = await c.branches.getDefault(company.id);
  if (branch === null) throw new Error('e2e fixture: the company has no branch');
  let repName = `Day Rep ${tag}`;
  if (asAdmin) {
    repName = (await adminRep()).name;
  } else {
    const email = `e2e-dayrep-${tag}@example.test`.toLowerCase();
    const person = await c.usersAdmin.createUser({ email, password: 'E2eRider-Passw0rd-3', name: repName, phone: '0711000333', role: 'super_admin' });
    await c.salesReps.create(company.id, actor, { userId: person.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
  }
  const vanName = `Day van ${tag}`;
  const van = await c.vans.create(company.id, actor, { name: vanName, branchId: branch.id, vehicleId: null, cashAccountId: null, maxCash: null });
  const routeName = `Day route ${tag}`;
  const route = await c.salesRoutes.create(company.id, actor, { code: `DAY-${tag}`.toUpperCase(), name: routeName, branchId: branch.id, mode: 'both', defaultVanId: van.id, defaultRepId: (await c.salesReps.page(company.id, { query: repName, status: 'all' })).rows[0]?.id ?? null });
  const shops: string[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const name = `Duka day ${tag} ${String(i)}`;
    const [row] = await db.insert(table).values({ companyId: company.id, number: `DY${tag}${String(i)}`.toUpperCase(), name, phone: `0712${String(i)}${tag.replace(/\D/g, '').slice(-5).padStart(5, '0')}`, city: 'Ruiru', accountType: 'cash' }).returning({ id: table.id });
    await c.salesRoutes.addStop(company.id, actor, route.id, { customerId: row?.id ?? '', visitDays: 1, every: 1, anchor: '2026-11-02', note: '' });
    shops.push(name);
  }
  return { route: routeName, rep: repName, van: vanName, shops: shops.join('|') };
}

async function placeOrder(customerName: string, productId: string, quantity: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { customers, orders, users } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const { getContainer } = await import('@/server/di/container');
  const { E2E_ADMIN_EMAIL } = await import('./constants');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.name, customerName));
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, E2E_ADMIN_EMAIL));
  if (customer === undefined || admin === undefined) throw new Error('e2e fixture: the customer or the e2e admin does not exist');
  const branch = await c.branches.getDefault(company.id);
  const placed = await c.salesOrders.place(company.id, { userId: admin.id, branchId: branch?.id ?? null }, { customerId: customer.id, lines: [{ productId, quantity: Number(quantity) }], paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, 'sales_order');
  if (!placed.ok) throw new Error(`e2e fixture: ${placed.error}`);
  await db.update(orders).set({ paymentStatus: 'paid' }).where(eq(orders.id, placed.orderId));
  return { orderNumber: placed.orderNumber };
}

async function outDay(routeName: string, placeCode: string, date: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { salesRoutes, stockLocations, users } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const { getContainer } = await import('@/server/di/container');
  const { E2E_ADMIN_EMAIL } = await import('./constants');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [route] = await db.select({ id: salesRoutes.id }).from(salesRoutes).where(eq(salesRoutes.name, routeName));
  const [place] = await db.select({ id: stockLocations.id }).from(stockLocations).where(eq(stockLocations.code, placeCode));
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, E2E_ADMIN_EMAIL));
  if (route === undefined || place === undefined || admin === undefined) throw new Error('e2e fixture: the route, the place or the e2e admin does not exist');
  const office = { type: 'user' as const, id: 'e2e' };
  const rep = { type: 'user' as const, id: admin.id };
  const { day } = await c.vanDays.plan(company.id, office, { routeId: route.id, date });
  const suggestion = await c.vanLoads.suggest(company.id, day.id, place.id);
  const lines = suggestion.rows.filter((r) => r.loadable > 0).map((r) => ({ productId: r.productId, quantity: r.loadable }));
  const made = (await c.vanLoads.create(company.id, office, day.id, { kind: 'load', fromLocationId: place.id, lines })).at(-1);
  await c.vanLoads.ship(company.id, office, made?.id ?? '');
  await c.vanLoads.sign(company.id, rep, made?.id ?? '', {}, { maySell: true, mayPlan: false });
  const found = await c.vanDays.find(company.id, day.id);
  await c.vanRun.sendOut(company.id, rep, day.id, { float: 500, expectedVersion: found?.day.version }, true);
  return { dayId: day.id, number: day.number };
}

async function refundable(): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { paymentMethods } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  await db.update(paymentMethods).set({ usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' }).where(eq(paymentMethods.kind, 'cash'));
  return { ok: 'yes' };
}

async function owe(customerName: string, amount: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { customers } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const { randomUUID } = await import('node:crypto');
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.name, customerName));
  if (customer === undefined) throw new Error('e2e fixture: the customer does not exist');
  const documentNo = `INV-E2E-${randomUUID().slice(0, 6).toUpperCase()}`;
  await c.finance.customerLedger.addEntry(db, { companyId: company.id, customerId: customer.id, documentType: 'invoice', documentNo, amountCents: Math.round(Number(amount) * 100), currency: 'KES', postingDate: '2026-11-01', dueDate: new Date('2026-11-20T00:00:00Z') });
  await db.update(customers).set({ balance: amount }).where(eq(customers.id, customer.id));
  return { documentNo };
}

async function cashLimit(vanName: string, amount: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { vans } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  await db.update(vans).set({ maxCash: amount }).where(eq(vans.name, vanName));
  return { limit: amount };
}

async function issueMoment(moment: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  await c.stockSettings.setIssueMoment(company.id, moment);
  return { moment };
}

async function par(routeName: string, productId: string, quantity: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [route] = (await c.salesRoutes.page(company.id, { query: routeName, status: 'all' })).rows;
  if (route === undefined) throw new Error(`e2e fixture: no route called ${routeName}`);
  await c.salesRoutes.setPar(company.id, { type: 'user', id: 'e2e' }, route.id, [{ productId, quantity: Number(quantity) }], route.version);
  return { route: route.name };
}

async function main(): Promise<void> {
  const [command, tag, count, third] = process.argv.slice(2);
  let result: Record<string, string> | null = null;
  if (command === 'customer' && tag !== undefined) result = await customers(tag, Number(count ?? '1'));
  if (command === 'product' && tag !== undefined) result = await product(tag);
  if (command === 'day-route' && tag !== undefined) result = await dayRoute(tag, count === 'admin');
  if (command === 'reset-rep') result = await resetRep();
  if (command === 'order' && tag !== undefined && count !== undefined && third !== undefined) result = await placeOrder(tag, count, third);
  if (command === 'moment' && tag !== undefined) result = await issueMoment(tag);
  if (command === 'limit' && tag !== undefined && count !== undefined) result = await cashLimit(tag, count);
  if (command === 'owe' && tag !== undefined && count !== undefined) result = await owe(tag, count);
  if (command === 'refundable') result = await refundable();
  if (command === 'out-day' && tag !== undefined && count !== undefined && third !== undefined) result = await outDay(tag, count, third);
  if (command === 'par' && tag !== undefined && count !== undefined && third !== undefined) result = await par(tag, count, third);
  if (result === null) throw new Error('usage: van-fixtures customer <tag> <n> | product <tag> | day-route <tag> [admin] | reset-rep <any> | par <route name> <product id> <quantity>');
  process.stdout.write(`FIXTURE ${JSON.stringify(result)}\n`);
}

/** Runs one of the tools above from a test and returns its answer. */
export function vanTool(...args: string[]): Record<string, string> {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/van-fixtures.ts', ...args], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the van tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}

if (process.argv[1]?.endsWith('van-fixtures.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
