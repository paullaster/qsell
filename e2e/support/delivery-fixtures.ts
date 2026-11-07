/**
 * Set-up for the shop's delivery tests that a person could do from the admin screens but that would make every test long:
 *   tsx e2e/support/delivery-fixtures.ts open <tag>    a branch with a map pin that offers its own riders, and a charge in force for it
 *                                                      (a flat 300 plus 16% tax), named "Delivery <tag>"
 *   tsx e2e/support/delivery-fixtures.ts order <order number>  what an order was given for delivery: branch, charge and its tax, who receives it, the order's own tax and total
 *   tsx e2e/support/delivery-fixtures.ts billing <with_goods|separate|reset>  how delivery is invoiced (an item named "E2E Delivery service" stands for the service); reset puts back the shop's default: one invoice, no item
 *   tsx e2e/support/delivery-fixtures.ts service <any>  makes "E2E Delivery service", a service with a 16% tax and no price or cost, if it is not there yet
 *   tsx e2e/support/delivery-fixtures.ts pay <order number>  marks an order paid and settles its stock, as the payment engine does when the money arrives
 *   tsx e2e/support/delivery-fixtures.ts collection <order number>  an order's collection: its state, how it was handed over, the wrong tries, and the code the customer was given
 *   tsx e2e/support/delivery-fixtures.ts ready <order number>  makes a delivery of the whole order and takes it to ready to go; prints its number
 *   tsx e2e/support/delivery-fixtures.ts set-email <order number> <address>  the email address the customer typed
 *   tsx e2e/support/delivery-fixtures.ts messages <order number>  what the order's deliveries told the customer, as kind:state
 *   tsx e2e/support/delivery-fixtures.ts courier-order <tag>  a paid order for one salt, to be sent by courier from the fixture's branch
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
async function pay(orderNumber: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber));
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  await OrderStages.move(db, order.id, 'payment_confirmed', 'succeeded', {});
  // The stock is settled too, as the payment engine does when the money arrives: an order paid but never settled would hold its stock
  // promise for ever and the stock screens' whole-database check would rightly find it.
  await (await import('@/server/domains/inventory/reservation-service')).InventoryReservationService.fulfilOrder(order.id);
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

/**
 * Makes a delivery for the whole of an order and takes it to ready to go, as a person would on its screen, so a test of the dispatch
 * board need not click through all of that. Prints the delivery number.
 */
async function ready(orderNumber: string, mode?: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber));
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  const actor = { companyId: company.id, userId: 'e2e' };
  const d = c.deliveryDocuments;
  const made = await d.create(actor, order.id, { lines: null });
  if (!made.ok) throw new Error(`e2e fixture: ${made.message}`);
  const id = made.data.id;
  // `draft` stops here, for a test that goes on from the screen; `door` lets the delivery of an unpaid order go out to be paid at the door.
  if (mode === 'draft') return { number: made.data.number, id };
  // `pod`: the order was placed to be paid on delivery, so the delivery is marked to be paid at the door as it is made, the way the office's screen does.
  if (mode === 'pod') {
    const marked = await c.doorPayments.markIfPayOnDelivery(actor, id);
    if (marked?.ok !== true) throw new Error(`e2e fixture: ${marked?.ok === false ? marked.message : 'the order is not a pay on delivery order'}`);
  }
  if (mode === 'door') {
    const marked = await c.doorPayments.mark(actor, id, { reason: 'Customer pays at the door (end-to-end test)' });
    if (!marked.ok) throw new Error(`e2e fixture: ${marked.message}`);
  }
  return await advance(id, made.data.number);
}

/** Takes a delivery from draft to ready to go. */
async function advance(id: string, number: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  const actor = { companyId: company.id, userId: 'e2e' };
  const d = c.deliveryDocuments;
  for (const step of [() => d.release(actor, id), () => d.startPicking(actor, id)]) {
    const r = await step();
    if (!r.ok) throw new Error(`e2e fixture: ${r.message}`);
  }
  const view = await d.get(company.id, id);
  const picked = (view?.lines ?? []).map((l) => ({ productId: l.productId, quantity: l.quantity }));
  for (const step of [() => d.recordPicked(actor, id, { picked }), () => d.markPacked(actor, id), () => d.markReady(actor, id)]) {
    const r = await step();
    if (!r.ok) throw new Error(`e2e fixture: ${r.message}`);
  }
  return { number, id };
}

/** A paid order for one salt that is to be sent by courier from the fixture's branch, placed the way the shop places it. */
async function courierOrder(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const { OrderWriteService } = await import('@/server/domains/orders/write-service');
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const c = getContainer();
  const company = await c.companySettings.ensureSeeded();
  // The branch also hands parcels to a courier, from now until the fixture is closed; the shop's checkout is not shown it.
  const { branches, deliveryMethods } = await import('@/server/db/drizzle/schema');
  const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.code, `E${tag}`.slice(0, 20)));
  if (branch !== undefined) await db.insert(deliveryMethods).values({ companyId: company.id, branchId: branch.id, method: 'courier' }).onConflictDoNothing();
  const [salt] = await db.select({ id: products.id }).from(products).where(eq(products.name, 'Salt 500g'));
  if (salt === undefined) throw new Error('e2e fixture: the seeded products are not there');
  const orderNumber = `E2E-CR-${tag}`.toUpperCase();
  const made = await OrderWriteService.createOrder({
    orderNumber,
    customerName: `Courier Buyer ${tag}`,
    customerEmail: `courier-${tag}@example.test`.toLowerCase(),
    customerPhone: '0711000777',
    shippingAddress: { street: '1 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
    items: [{ productId: salt.id, quantity: 1 }],
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
    delivery: { method: 'courier', pin: PIN },
  });
  if (!made.success || made.order === undefined) throw new Error(`e2e fixture: the order was refused: ${made.error ?? 'no reason'}`);
  await OrderStages.move(db, made.order.id, 'payment_confirmed', 'succeeded', {});
  return { orderNumber };
}

/** Gives an order the email address a customer would have typed, so the messages about its delivery have somewhere to go. */
async function setEmail(orderNumber: string, address: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders } = await import('@/server/db/drizzle/schema');
  await db.update(orders).set({ customerEmail: address }).where(eq(orders.orderNumber, orderNumber));
  return { email: address };
}

/** The messages an order's deliveries have caused, oldest first, as kind:state. */
async function messages(orderNumber: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { orders, deliveryMessages } = await import('@/server/db/drizzle/schema');
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber));
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  const rows = await db.select({ kind: deliveryMessages.kind, status: deliveryMessages.status }).from(deliveryMessages).where(eq(deliveryMessages.orderId, order.id)).orderBy(deliveryMessages.createdAt);
  return { list: rows.map((r) => `${r.kind}:${r.status}`).join(',') };
}

async function main(): Promise<void> {
  const [command, tag, extra] = process.argv.slice(2);
  if (tag === undefined) throw new Error('usage: delivery-fixtures open|close|order|billing|service|pay|collection <tag>');
  let result: Record<string, string> | null = null;
  if (command === 'open') result = await open(tag);
  if (command === 'close') result = await close(tag);
  if (command === 'order') result = await order(tag);
  if (command === 'billing') result = await billing(tag);
  if (command === 'pay') result = await pay(tag);
  if (command === 'collection') result = await collection(tag);
  if (command === 'ready') result = await ready(tag, extra);
  if (command === 'advance' && extra !== undefined) result = await advance(tag, extra);
  if (command === 'set-email' && extra !== undefined) result = await setEmail(tag, extra);
  if (command === 'messages') result = await messages(tag);
  if (command === 'courier-order') result = await courierOrder(tag);
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
