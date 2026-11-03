/**
 * Set-up for the shop's delivery tests that a person could do from the admin screens but that would make every test long:
 *   tsx e2e/support/delivery-fixtures.ts open <tag>    a branch with a map pin that offers its own riders, and a charge in force for it
 *                                                      (a flat 300 plus 16% tax), named "Delivery <tag>"
 *   tsx e2e/support/delivery-fixtures.ts order <order number>  what an order was given for delivery: branch, charge and its tax, who receives it, the order's own tax and total
 *   tsx e2e/support/delivery-fixtures.ts billing <with_goods|separate|reset>  how delivery is invoiced (an item named "E2E Delivery service" stands for the service); reset puts back the shop's default: one invoice, no item
 *   tsx e2e/support/delivery-fixtures.ts service <any>  makes "E2E Delivery service", a service with a 16% tax and no price or cost, if it is not there yet
 *   tsx e2e/support/delivery-fixtures.ts pay <order number> [settle]  marks an order paid, as the payment engine does when the money arrives; with settle, its stock is settled as well
 *   tsx e2e/support/delivery-fixtures.ts collection <order number>  an order's collection: its state, how it was handed over, the wrong tries, and the code the customer was given
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
  // The same branch can be collected from, ready in half an hour.
  await db.insert(deliveryMethods).values({ companyId: company.id, branchId: branch.id, method: 'pickup', leadTimeMinutes: 30 });
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

const SERVICE_NAME = 'E2E Delivery service';

/** The item that stands for the delivery service: a real service, which is the only kind the screen offers. */
async function serviceItem(): Promise<string> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const [existing] = await db.select({ id: products.id }).from(products).where(eq(products.name, SERVICE_NAME));
  if (existing !== undefined) return existing.id;
  const [salt] = await db.select({ itemTypeId: products.itemTypeId }).from(products).where(eq(products.name, 'Salt 500g'));
  if (salt === undefined) throw new Error('e2e fixture: the seeded products are not there');
  const id = 'prod_e2e_delivery_service';
  await db.insert(products).values({ id, sku: 'E2E-DLV', stockCode: 'E2E-DLV-S', name: SERVICE_NAME, slug: 'e2e-delivery-service', itemTypeId: salt.itemTypeId, costPrice: '0', taxRate: '16', isTaxInclusive: false, stockQuantity: 0, isSellable: false, inventoryKind: 'service' });
  return id;
}

async function billing(mode: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const now = await c.deliveryBilling.get(company.id);
  const reset = mode === 'reset';
  await c.deliveryBilling.save(company.id, 'e2e', { mode: reset ? 'with_goods' : mode, serviceProductId: reset ? null : await serviceItem(), expectedVersion: now.version, reason: 'End-to-end test of delivery invoicing' });
  return { mode };
}

async function order(orderNumber: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const [row] = await db.execute<Record<string, string | null>>(sql`
    SELECT o.shipping_fee, o.tax, o.total_amount, o.subtotal, o.status AS order_status, d.method, b.name AS branch, d.charge_amount, d.charge_net, d.charge_tax, d.tax_rate, d.recipient_name, d.recipient_phone, d.notes, d.choice->>'reason' AS reason,
           (SELECT string_agg(e.stage, ',' ORDER BY e.sequence) FROM order_stage_events e WHERE e.order_id = o.id) AS stages
    FROM orders o LEFT JOIN order_deliveries d ON d.order_id = o.id LEFT JOIN branches b ON b.id = o.branch_id
    WHERE o.order_number = ${orderNumber}`);
  if (row === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? '']));
}

/** Marks an order paid, as the payment engine does when the money arrives, so the test does not wait for a payment that cannot complete here. */
async function pay(orderNumber: string, settle = false): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber));
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  await OrderStages.move(db, order.id, 'payment_confirmed', 'succeeded', {});
  // With `settle`, the stock is settled too, as the payment engine does when the money arrives.
  if (settle) await (await import('@/server/domains/inventory/reservation-service')).InventoryReservationService.fulfilOrder(order.id);
  return { paid: orderNumber };
}

/** What an order's collection looks like, and the code the customer was given (what the customer sees on their screen). */
async function collection(orderNumber: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders, orderCollections } = await import('@/server/db/drizzle/schema');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [order] = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.orderNumber, orderNumber));
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  const [row] = await db.select().from(orderCollections).where(eq(orderCollections.orderId, order.id));
  const code = await c.orderCollections.codeFor(company.id, order.id);
  return { orderStatus: order.status, status: row?.status ?? '', how: row?.collectedHow ?? '', attempts: String(row?.failedAttempts ?? 0), code: code ?? '' };
}

async function main(): Promise<void> {
  const [command, tag, extra] = process.argv.slice(2);
  if (tag === undefined) throw new Error('usage: delivery-fixtures open|close|order|billing|service|pay|collection <tag>');
  let result: Record<string, string> | null = null;
  if (command === 'open') result = await open(tag);
  if (command === 'close') result = await close(tag);
  if (command === 'order') result = await order(tag);
  if (command === 'billing') result = await billing(tag);
  if (command === 'pay') result = await pay(tag, extra === 'settle');
  if (command === 'collection') result = await collection(tag);
  if (command === 'service') result = { id: await serviceItem(), name: SERVICE_NAME };
  if (result === null) throw new Error('usage: delivery-fixtures open|close|order|billing|service|pay|collection <tag>');
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
