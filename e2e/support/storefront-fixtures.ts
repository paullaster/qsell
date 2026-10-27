/**
 * Set-up for the shop's end-to-end tests that a person could not do from the screens, printed as one line of JSON. Run with the
 * end-to-end environment:
 *   tsx e2e/support/storefront-fixtures.ts reviewer <tag> <product name>   a shopper who has been delivered that product
 *   tsx e2e/support/storefront-fixtures.ts product <tag>                    a new product for sale with no reviews, named "Reviewed <tag>"
 *   tsx e2e/support/storefront-fixtures.ts limited-product <tag> <min> <max> a product for sale that may be bought only <min> to <max> at a time, named "Limited <tag>"
 *   tsx e2e/support/storefront-fixtures.ts set-stock <product id> <quantity>   sets a product's stock (to make a checkout run short)
 *   tsx e2e/support/storefront-fixtures.ts order-stages <order number>        the stages an order has been through, in order, and its current stage
 *   tsx e2e/support/storefront-fixtures.ts latest-attempt                     the newest checkout attempt: its outcome, stage and reason
 *   tsx e2e/support/storefront-fixtures.ts newsletter-token <email>         the token behind a confirmation link
 *   tsx e2e/support/storefront-fixtures.ts payment-phones <order number>    the contact number, the number the order is paid from and every attempt's number
 */
import { execFileSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { e2eEnvironment } from './env';
import { E2E_SHOPPER_PASSWORD } from './constants';

async function reviewer(tag: string, productName: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { UserRepository } = await import('@/server/domains/auth/user-repository');
  const { StorefrontCustomerService } = await import('@/server/domains/customers/storefront-service');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const branch = await container.branches.getDefault(company.id);
  if (branch === null) throw new Error('e2e fixture: the company has no default branch');
  const email = `reviewer-${tag}@example.test`;
  const name = `Wanjiru Reviewer ${tag}`;
  const customer = await StorefrontCustomerService.ensure({ name, email, phone: '0711000222' });
  const user = await new UserRepository().create({ email, password: E2E_SHOPPER_PASSWORD, name, role: 'customer', customerStoreId: customer.id, emailVerified: true });
  const [product] = await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM products WHERE name = ${productName} AND deleted_at IS NULL LIMIT 1`);
  if (product === undefined) throw new Error(`e2e fixture: no product called ${productName}`);
  const id = `rv_${tag}`;
  await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status, payment_status)
    VALUES (${id}, ${`RV-${tag}`}, ${user.id}, ${branch.id}::uuid, ${name}, ${email}, '0711000222', '{"street":"1 Moi Avenue","city":"Nairobi","countyOrState":"Nairobi","country":"Kenya"}'::jsonb, 100, 0, 0, 100, 'mpesa_daraja', 'delivered', 'paid')`);
  await db.execute(sql`INSERT INTO order_items (order_id, product_id, product_name, sku, quantity, unit_price, total_price, image_url) VALUES (${id}, ${product.id}, ${product.name}, 'x', 1, 100, 100, '')`);
  return { email, password: E2E_SHOPPER_PASSWORD, productName };
}

async function product(tag: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const [template] = await db.execute<{ item_type_id: string }>(sql`SELECT item_type_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (template === undefined) throw new Error('e2e fixture: the seed has no product to copy');
  const name = `Reviewed ${tag}`;
  await db.insert(products).values({ id: `prod_rv_${tag}`, sku: `RVW-${tag}`.toUpperCase(), stockCode: `RVWS-${tag}`.toUpperCase(), name, slug: `reviewed-${tag}`.toLowerCase(), itemTypeId: template.item_type_id, price: '250', taxRate: '0', isTaxInclusive: true, stockQuantity: 20, categoryName: 'E2E Pantry' });
  return { name };
}

async function limitedProduct(tag: string, min: string, max: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const [template] = await db.execute<{ item_type_id: string }>(sql`SELECT item_type_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (template === undefined) throw new Error('e2e fixture: the seed has no product to copy');
  const name = `Limited ${tag}`;
  const id = `prod_lim_${tag}`;
  await db.insert(products).values({ id, sku: `LIM-${tag}`.toUpperCase(), stockCode: `LIMS-${tag}`.toUpperCase(), name, slug: `limited-${tag}`.toLowerCase(), itemTypeId: template.item_type_id, price: '250', taxRate: '0', isTaxInclusive: true, stockQuantity: 50, categoryName: 'E2E Pantry', minOrderQty: Number(min), maxOrderQty: Number(max) });
  return { name, id };
}

async function writeStock(productId: string, quantity: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  await db.execute(sql`UPDATE products SET stock_quantity = ${Number(quantity)} WHERE id = ${productId}`);
  return { productId, quantity };
}

async function readOrderStages(orderNumber: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const [order] = await db.execute<{ id: string; current_stage: string | null; status: string; payment_status: string }>(sql`SELECT id, current_stage, status, payment_status FROM orders WHERE order_number = ${orderNumber}`);
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  const events = await db.execute<{ stage: string; outcome: string; source: string }>(sql`SELECT stage, outcome, source FROM order_stage_events WHERE order_id = ${order.id} ORDER BY sequence`);
  return { stages: events.map((e) => `${e.stage}:${e.outcome}`).join(','), sources: events.map((e) => e.source).join(','), current: order.current_stage ?? '', status: order.status, paymentStatus: order.payment_status };
}

async function readLatestAttempt(): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const [row] = await db.execute<{ outcome: string; refused_stage: string | null; reason_code: string | null; message: string | null; session_ref: string | null; finished_at: Date | null }>(sql`SELECT outcome, refused_stage, reason_code, message, session_ref, finished_at FROM checkout_attempts ORDER BY started_at DESC LIMIT 1`);
  if (row === undefined) throw new Error('e2e fixture: no checkout attempt yet');
  return { outcome: row.outcome, stage: row.refused_stage ?? '', reason: row.reason_code ?? '', message: row.message ?? '', hasSession: row.session_ref === null ? 'no' : 'yes', finished: row.finished_at === null ? 'no' : 'yes' };
}

async function newsletterToken(email: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const [row] = await db.execute<{ token: string }>(sql`SELECT token FROM newsletter_subscribers WHERE email = ${email.toLowerCase()}`);
  if (row === undefined) throw new Error(`e2e fixture: nobody asked for the newsletter with ${email}`);
  return { token: row.token };
}

async function paymentPhones(orderNumber: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const [order] = await db.execute<{ id: string; customer_phone: string; payment_phone: string | null }>(sql`SELECT id, customer_phone, payment_phone FROM orders WHERE order_number = ${orderNumber}`);
  if (order === undefined) throw new Error(`e2e fixture: no order ${orderNumber}`);
  const attempts = await db.execute<{ customer_phone: string | null }>(sql`SELECT customer_phone FROM payment_attempts WHERE order_id = ${order.id} ORDER BY created_at`);
  return { contact: order.customer_phone, paidFrom: order.payment_phone ?? '', attempts: attempts.map((a) => a.customer_phone ?? '').join(',') };
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  let result: Record<string, string>;
  if (command === 'reviewer' && a !== undefined && b !== undefined) result = await reviewer(a, b);
  else if (command === 'product' && a !== undefined) result = await product(a);
  else if (command === 'limited-product' && a !== undefined && b !== undefined && process.argv[5] !== undefined) result = await limitedProduct(a, b, process.argv[5]);
  else if (command === 'set-stock' && a !== undefined && b !== undefined) result = await writeStock(a, b);
  else if (command === 'order-stages' && a !== undefined) result = await readOrderStages(a);
  else if (command === 'latest-attempt') result = await readLatestAttempt();
  else if (command === 'newsletter-token' && a !== undefined) result = await newsletterToken(a);
  else if (command === 'payment-phones' && a !== undefined) result = await paymentPhones(a);
  else throw new Error('usage: storefront-fixtures reviewer <tag> <product> | newsletter-token <email> | payment-phones <order number>');
  process.stdout.write(`FIXTURE ${JSON.stringify(result)}\n`);
}

/** Runs one of the tools above from a test and returns its answer. */
export function storefrontTool(...args: string[]): Record<string, string> {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/storefront-fixtures.ts', ...args], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the storefront tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}

/** A new product for sale with no reviews; its name is returned. */
export function makeProduct(tag: string): string {
  return storefrontTool('product', tag).name ?? '';
}

/** A new product that may be bought only `min` to `max` at a time; its name and id are returned. */
export function makeLimitedProduct(tag: string, min: number, max: number): { name: string; id: string } {
  const made = storefrontTool('limited-product', tag, String(min), String(max));
  return { name: made.name ?? '', id: made.id ?? '' };
}

/** The stages an order has been through (`stage:outcome`, in order) and where it is now. */
export function orderStages(orderNumber: string): { stages: string[]; sources: string[]; current: string; status: string; paymentStatus: string } {
  const made = storefrontTool('order-stages', orderNumber);
  return { stages: (made.stages ?? '').split(',').filter((x) => x !== ''), sources: (made.sources ?? '').split(',').filter((x) => x !== ''), current: made.current ?? '', status: made.status ?? '', paymentStatus: made.paymentStatus ?? '' };
}

/** The newest checkout attempt on record. */
export function latestAttempt(): { outcome: string; stage: string; reason: string; message: string; hasSession: boolean; finished: boolean } {
  const made = storefrontTool('latest-attempt');
  return { outcome: made.outcome ?? '', stage: made.stage ?? '', reason: made.reason ?? '', message: made.message ?? '', hasSession: made.hasSession === 'yes', finished: made.finished === 'yes' };
}

/** Sets a product's stock, to make a checkout in progress run short. */
export function setStock(productId: string, quantity: number): void {
  storefrontTool('set-stock', productId, String(quantity));
}

/** A shopper whose order for this product was delivered, ready to sign in. */
export function makeReviewer(tag: string, productName: string): { email: string; password: string } {
  const made = storefrontTool('reviewer', tag, productName);
  return { email: made.email ?? '', password: made.password ?? '' };
}

if (process.argv[1]?.endsWith('storefront-fixtures.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
