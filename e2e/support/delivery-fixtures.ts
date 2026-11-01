/**
 * Set-up for the shop's delivery tests that a person could do from the admin screens but that would make every test long:
 *   tsx e2e/support/delivery-fixtures.ts open <tag>    a branch with a map pin that offers its own riders, and a charge in force for it
 *                                                      (a flat 300 plus 16% tax), named "Delivery <tag>"
 *   tsx e2e/support/delivery-fixtures.ts order <order number>  what an order was given for delivery: branch, charge and its tax, who receives it, the order's own tax and total
 *   tsx e2e/support/delivery-fixtures.ts close <tag>   takes all of that out of play again, so the shop's other tests are not asked about delivery
 */
import { execFileSync } from 'node:child_process';
import { eq, like, sql } from 'drizzle-orm';
import { e2eEnvironment } from './env';

const PIN = { latitude: -1.2864, longitude: 36.8172 };

async function open(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { branches, deliveryMethods } = await import('@/server/db/drizzle/schema');
  const { readPolicyInput } = await import('@/server/domains/delivery/domain/read');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const name = `Delivery ${tag}`;
  const [branch] = await db.insert(branches).values({ companyId: company.id, code: `E${tag}`.slice(0, 20), name, latitude: PIN.latitude, longitude: PIN.longitude }).returning();
  if (branch === undefined) throw new Error('e2e fixture: the branch was not made');
  await db.insert(deliveryMethods).values({ companyId: company.id, branchId: branch.id, method: 'own_fleet' });
  const read = readPolicyInput({ name: `Delivery ${tag}`, method: 'flat', currency: 'KES', scopes: { branch: { op: 'in', values: [branch.id] } }, rates: [{ zoneId: '', fromKg: 0, toKg: '', fee: 300 }], taxRate: 16 });
  if (!read.ok) throw new Error(`e2e fixture: ${read.error}`);
  const draft = await c.chargePolicies.createDraft(company.id, { id: 'e2e' }, `E2E${tag}`, read.value);
  await c.chargePolicies.activate(company.id, { id: 'e2e' }, draft.id, 'End-to-end test of the shop delivery');
  return { branchId: branch.id, branchName: name, policy: draft.code };
}

async function close(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { branches, deliveryMethods, chargePolicies } = await import('@/server/db/drizzle/schema');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [branch] = await db.select().from(branches).where(eq(branches.code, `E${tag}`.slice(0, 20)));
  if (branch !== undefined) {
    await db.update(deliveryMethods).set({ isActive: false }).where(eq(deliveryMethods.branchId, branch.id));
    await db.update(branches).set({ isActive: false }).where(eq(branches.id, branch.id));
  }
  const live = await db.select().from(chargePolicies).where(like(chargePolicies.code, `E2E${tag}`));
  for (const p of live) if (p.status === 'in_force') await c.chargePolicies.retire(company.id, { id: 'e2e' }, p.id, 'End-to-end test finished');
  return { closed: 'yes' };
}

async function order(orderNumber: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const [row] = await db.execute<Record<string, string | null>>(sql`
    SELECT o.shipping_fee, o.tax, o.total_amount, o.subtotal, b.name AS branch, d.charge_amount, d.charge_net, d.charge_tax, d.tax_rate, d.recipient_name, d.recipient_phone, d.notes, d.choice->>'reason' AS reason,
           (SELECT string_agg(e.stage, ',' ORDER BY e.sequence) FROM order_stage_events e WHERE e.order_id = o.id) AS stages
    FROM orders o LEFT JOIN order_deliveries d ON d.order_id = o.id LEFT JOIN branches b ON b.id = o.branch_id
    WHERE o.order_number = ${orderNumber}`);
  if (row === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? '']));
}

async function main(): Promise<void> {
  const [command, tag] = process.argv.slice(2);
  if (tag === undefined) throw new Error('usage: delivery-fixtures open|close|order <tag>');
  let result: Record<string, string> | null = null;
  if (command === 'open') result = await open(tag);
  if (command === 'close') result = await close(tag);
  if (command === 'order') result = await order(tag);
  if (result === null) throw new Error('usage: delivery-fixtures open|close|order <tag>');
  process.stdout.write(`FIXTURE ${JSON.stringify(result)}\n`);
}

/** Runs one of the tools above from a test and returns its answer. */
export function deliveryTool(...args: string[]): Record<string, string> {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/delivery-fixtures.ts', ...args], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the delivery tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}

if (process.argv[1]?.endsWith('delivery-fixtures.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
