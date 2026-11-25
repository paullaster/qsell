/**
 * Set-up for the van sales tests that a person would do from other screens:
 *   tsx e2e/support/van-fixtures.ts customer <tag> <n>   n customers with a phone and a town, printed as their names (a person makes these under Customers)
 *   tsx e2e/support/van-fixtures.ts product <tag>        a product kept in stock, counted in whole pieces, printed with its name (made under Products)
 *   tsx e2e/support/van-fixtures.ts par <route name> <product id> <quantity>  sets the usual stock of a route's van to one product (set under Routes)
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

async function dayRoute(tag: string): Promise<Record<string, string>> {
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
  const email = `e2e-dayrep-${tag}@example.test`.toLowerCase();
  const repName = `Day Rep ${tag}`;
  const person = await c.usersAdmin.createUser({ email, password: 'E2eRider-Passw0rd-3', name: repName, phone: '0711000333', role: 'super_admin' });
  await c.salesReps.create(company.id, actor, { userId: person.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
  const vanName = `Day van ${tag}`;
  const van = await c.vans.create(company.id, actor, { name: vanName, branchId: branch.id, vehicleId: null, cashAccountId: null, maxCash: null });
  const routeName = `Day route ${tag}`;
  const route = await c.salesRoutes.create(company.id, actor, { code: `DAY-${tag}`.toUpperCase(), name: routeName, branchId: branch.id, mode: 'both', defaultVanId: van.id, defaultRepId: (await c.salesReps.page(company.id, { query: repName, status: 'all' })).rows[0]?.id ?? null });
  const shops: string[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const name = `Duka day ${tag} ${String(i)}`;
    const [row] = await db.insert(table).values({ companyId: company.id, number: `DY${tag}${String(i)}`.toUpperCase(), name, phone: `07120${String(i).padStart(5, '0')}`, city: 'Ruiru', accountType: 'cash' }).returning({ id: table.id });
    await c.salesRoutes.addStop(company.id, actor, route.id, { customerId: row?.id ?? '', visitDays: 1, every: 1, anchor: '2026-11-02', note: '' });
    shops.push(name);
  }
  return { route: routeName, rep: repName, van: vanName, shops: shops.join('|') };
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
  if (command === 'day-route' && tag !== undefined) result = await dayRoute(tag);
  if (command === 'par' && tag !== undefined && count !== undefined && third !== undefined) result = await par(tag, count, third);
  if (result === null) throw new Error('usage: van-fixtures customer <tag> <n> | product <tag> | day-route <tag> | par <route name> <product id> <quantity>');
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
