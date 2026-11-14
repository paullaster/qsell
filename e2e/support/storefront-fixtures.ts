/**
 * Set-up for the shop's end-to-end tests that a person could not do from the screens, printed as one line of JSON. Run with the
 * end-to-end environment:
 *   tsx e2e/support/storefront-fixtures.ts reviewer <tag> <product name>   a shopper who has been delivered that product
 *   tsx e2e/support/storefront-fixtures.ts product <tag>                    a new product for sale with no reviews, named "Reviewed <tag>"
 *   tsx e2e/support/storefront-fixtures.ts limited-product <tag> <min> <max> a product for sale that may be bought only <min> to <max> at a time, named "Limited <tag>"
 *   tsx e2e/support/storefront-fixtures.ts package <tag>                    a configurable package "Express lunch <tag>" (fish, starch, vegetables) with its parts; brown ugali has no stock
 *   tsx e2e/support/storefront-fixtures.ts package-orders <tag>             that package with three orders for one day ten days ahead, one of them cancelled
 *   tsx e2e/support/storefront-fixtures.ts category-lunch <tag> [email]      a lunch with vegetables from a category and a note on each serving; that shopper has ordered it once
 *   tsx e2e/support/storefront-fixtures.ts set-stock <product id> <quantity>   sets a product's stock (to make a checkout run short)
 *   tsx e2e/support/storefront-fixtures.ts order-stages <order number>        the stages an order has been through, in order, and its current stage
 *   tsx e2e/support/storefront-fixtures.ts late-order <tag> [hours]          an order that has waited in "payment started" for that many hours (default 3), recorded as late by the sweep
 *   tsx e2e/support/storefront-fixtures.ts latest-attempt                     the newest checkout attempt: its outcome, stage and reason
 *   tsx e2e/support/storefront-fixtures.ts newsletter-token <email>         the token behind a confirmation link
 *   tsx e2e/support/storefront-fixtures.ts payment-phones <order number>    the contact number, the number the order is paid from and every attempt's number
 */
import { execFileSync } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
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

async function lateOrder(tag: string, hours: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const branch = await container.branches.getDefault(company.id);
  if (branch === null) throw new Error('e2e fixture: the company has no default branch');
  const id = `late_${tag}`;
  const number = `LATE-${tag}`.toUpperCase();
  await db.execute(sql`INSERT INTO orders (id, order_number, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status, payment_status, current_stage, current_stage_since, stage_seq)
    VALUES (${id}, ${number}, ${branch.id}::uuid, 'Late Buyer', ${`late-${tag}@example.test`}, '0711000333', '{"street":"1 Moi Avenue","city":"Nairobi","countyOrState":"Nairobi","country":"Kenya"}'::jsonb, 100, 0, 0, 100, 'mpesa_daraja', 'pending', 'unpaid', 'payment_started', now() - make_interval(hours => ${Number(hours)}), 1)`);
  await container.orderSla.sweep(company.id, new Date());
  return { orderNumber: number };
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

/** An "Express lunch" package: fish in two sizes, a starch that only packages sell (brown ugali has none left) and two vegetables. */
async function lunchPackage(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const [template] = await db.execute<{ item_type_id: string }>(sql`SELECT item_type_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (template === undefined) throw new Error('e2e fixture: the seed has no product to copy');
  const make = async (key: string, name: string, price: string, over: Record<string, unknown> = {}): Promise<string> => {
    const id = `prod_pk_${key}_${tag}`;
    await db.insert(products).values({ id, sku: `PK${key}-${tag}`.toUpperCase(), stockCode: `PKS${key}-${tag}`.toUpperCase(), name, slug: `pk-${key}-${tag}`.toLowerCase(), itemTypeId: template.item_type_id, price, costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 8, categoryName: 'E2E Pantry', ...over });
    return id;
  };
  const lunch = await make('l', `Express lunch ${tag}`, '650', { inventoryKind: 'non_inventory', stockQuantity: 0, costPrice: '0' });
  const small = await make('s', `Small fish ${tag}`, '300');
  const large = await make('g', `Large fish ${tag}`, '420');
  const ugali = await make('u', `Ugali ${tag}`, '50', { stockQuantity: 3, soldOnlyInPackages: true, showOnWebShop: false });
  const brown = await make('b', `Brown ugali ${tag}`, '80', { stockQuantity: 0, soldOnlyInPackages: true, showOnWebShop: false });
  const sukuma = await make('k', `Sukuma ${tag}`, '40');
  const cabbage = await make('c', `Cabbage ${tag}`, '40');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  await container.reasonCodes.ensureSystemReasons(company.id);
  await container.packageConfig.save(
    company.id,
    {
      productId: lunch,
      pricingMode: 'base_plus_differences',
      allocation: 'list_price',
      shortStockMode: 'hide',
      slots: [
        { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: small, quantity: 1 }, { productId: large, quantity: 1, difference: 120, isDefault: true }] },
        { name: 'Starch', minPicks: 1, maxPicks: 1, options: [{ productId: ugali, quantity: 1, isDefault: true }, { productId: brown, quantity: 1, difference: 30 }] },
        { name: 'Vegetables', minPicks: 1, maxPicks: 2, options: [{ productId: sukuma, quantity: 1, isDefault: true }, { productId: cabbage, quantity: 1, difference: 10 }] },
      ],
    },
    { type: 'user', id: 'e2e-fixture' },
    { code: 'POLICY_CHANGE' },
  );
  return { name: `Express lunch ${tag}`, slug: `pk-l-${tag}`.toLowerCase(), small: `Small fish ${tag}`, large: `Large fish ${tag}`, ugali: `Ugali ${tag}`, brown: `Brown ugali ${tag}`, sukuma: `Sukuma ${tag}`, cabbage: `Cabbage ${tag}`, id: lunch, ugaliId: ugali, smallId: small, largeId: large, sukumaId: sukuma };
}

/** The lunch package with three orders for one day (twelve servings): two kept and one cancelled. The day and the names are returned. */
async function lunchOrders(tag: string): Promise<Record<string, string>> {
  const made = await lunchPackage(tag);
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  // Plenty of every part, so the orders are not held up by stock (the shop tests use the small counts for their own purpose).
  await db.execute(sql`UPDATE products SET stock_quantity = 100 WHERE id LIKE ${`prod_pk_%_${tag}`}`);
  const { OrderWriteService } = await import('@/server/domains/orders/write-service');
  const { OrderStages } = await import('@/server/domains/orders/stages');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const branch = await container.branches.getDefault(company.id);
  if (branch === null) throw new Error('e2e fixture: the company has no default branch');
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const stored = (fishId: string, fish: string) => [
    { slotName: 'Fish', productId: fishId, name: fish, count: 1 },
    { slotName: 'Starch', productId: made.ugaliId ?? '', name: 'Ugali', count: 1 },
    { slotName: 'Vegetables', productId: made.sukumaId ?? '', name: 'Sukuma', count: 1 },
  ];
  const place = async (n: number, servings: number, fishId: string, fish: string) => {
    const resolved = await container.packageOrders.resolve(company.id, [{ productId: made.id ?? '', stored: stored(fishId, fish) }]);
    if (!resolved.ok) throw new Error(resolved.error);
    const result = await OrderWriteService.createOrder({
      branchId: branch.id,
      orderNumber: `PREP-${tag}-${String(n)}`.toUpperCase(),
      customerName: `Prep Customer ${String(n)} ${tag}`,
      customerEmail: `prep-${String(n)}-${tag}@example.test`,
      customerPhone: '0711000333',
      shippingAddress: { street: '1 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
      items: [{ productId: made.id ?? '', quantity: servings, package: { picks: resolved.picks[0] ?? [] } }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      fulfilmentDate: day,
    });
    if (!result.success || result.order === undefined) throw new Error(result.error ?? 'e2e fixture: the order was refused');
    return result.order;
  };
  await place(1, 3, made.smallId ?? '', made.small ?? '');
  await place(2, 9, made.largeId ?? '', made.large ?? '');
  const gone = await place(3, 4, made.smallId ?? '', made.small ?? '');
  await OrderStages.move(db, gone.id, 'cancelled', 'cancelled', { source: 'staff', reasonCode: 'cancelled', message: 'Customer asked', checkHold: true });
  return { ...made, day };
}

/**
 * A lunch whose vegetables come from a category (three of them, each adding 15) and which takes a note on each serving. With a
 * shopper's email, that shopper has already ordered it once: sukuma and cabbage, 2 servings, "no pepper".
 */
async function categoryLunch(tag: string, email?: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products, categories } = await import('@/server/db/drizzle/schema');
  const [template] = await db.execute<{ item_type_id: string }>(sql`SELECT item_type_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (template === undefined) throw new Error('e2e fixture: the seed has no product to copy');
  const categoryId = `cat_pg_${tag}`;
  const categoryName = `Greens ${tag}`;
  await db.insert(categories).values({ id: categoryId, name: categoryName, slug: `greens-${tag}`.toLowerCase() });
  const make = async (key: string, name: string, price: string, over: Record<string, unknown> = {}): Promise<string> => {
    const id = `prod_pg_${key}_${tag}`;
    await db.insert(products).values({ id, sku: `PG${key}-${tag}`.toUpperCase(), stockCode: `PGS${key}-${tag}`.toUpperCase(), name, slug: `pg-${key}-${tag}`.toLowerCase(), itemTypeId: template.item_type_id, price, costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 50, categoryName: 'E2E Pantry', ...over });
    return id;
  };
  const lunch = await make('l', `Garden lunch ${tag}`, '600', { inventoryKind: 'non_inventory', stockQuantity: 0, costPrice: '0' });
  const fish = await make('f', `Tilapia ${tag}`, '300');
  const sukuma = await make('s', `Sukuma ${tag}`, '40', { categoryId, categoryName });
  const cabbage = await make('c', `Cabbage ${tag}`, '40', { categoryId, categoryName });
  await make('p', `Spinach ${tag}`, '40', { categoryId, categoryName });
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  await container.reasonCodes.ensureSystemReasons(company.id);
  await container.packageConfig.save(
    company.id,
    {
      productId: lunch,
      pricingMode: 'base_plus_differences',
      allocation: 'list_price',
      shortStockMode: 'hide',
      allowNote: true,
      slots: [
        { name: 'Fish', minPicks: 1, maxPicks: 1, options: [{ productId: fish, quantity: 1 }] },
        { name: 'Vegetables', minPicks: 1, maxPicks: 2, source: 'category', categoryId, categoryDifference: 15, categoryQuantity: 1, options: [] },
      ],
    },
    { type: 'user', id: 'e2e-fixture' },
    { code: 'POLICY_CHANGE' },
  );
  if (email !== undefined) {
    const { StorefrontCustomerService } = await import('@/server/domains/customers/storefront-service');
    const { OrderWriteService } = await import('@/server/domains/orders/write-service');
    const branch = await container.branches.getDefault(company.id);
    if (branch === null) throw new Error('e2e fixture: the company has no default branch');
    const customer = await StorefrontCustomerService.ensure({ name: `Shopper ${tag}`, email, phone: '0711000111' });
    const resolved = await container.packageOrders.resolve(company.id, [{ productId: lunch, stored: [{ slotName: 'Fish', productId: fish, name: 'Tilapia', count: 1 }, { slotName: 'Vegetables', productId: sukuma, name: 'Sukuma', count: 1 }, { slotName: 'Vegetables', productId: cabbage, name: 'Cabbage', count: 1 }] }]);
    if (!resolved.ok) throw new Error(resolved.error);
    const result = await OrderWriteService.createOrder({
      branchId: branch.id,
      userId: customer.id,
      customerId: customer.id,
      orderNumber: `AGAIN-${tag}`.toUpperCase(),
      customerName: `Shopper ${tag}`,
      customerEmail: email,
      customerPhone: '0711000111',
      shippingAddress: { street: '1 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
      items: [{ productId: lunch, quantity: 2, package: { picks: resolved.picks[0] ?? [], note: 'no pepper' } }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    if (!result.success) throw new Error(result.error ?? 'e2e fixture: the order was refused');
  }
  return { name: `Garden lunch ${tag}`, slug: `pg-l-${tag}`.toLowerCase(), fish: `Tilapia ${tag}`, sukuma: `Sukuma ${tag}`, cabbage: `Cabbage ${tag}`, spinach: `Spinach ${tag}`, id: lunch };
}

async function packaging(tag: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { packagingFits, products } = await import('@/server/db/drizzle/schema');
  const [goods] = await db.execute<{ id: string; item_type_id: string; category_id: string | null; category_name: string; base_unit_id: string }>(sql`SELECT id, item_type_id, category_id, category_name, base_unit_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (goods === undefined) throw new Error('e2e fixture: the seed has no product for packaging');
  const safeTag = tag.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const id = `prod_pkg_${safeTag}`;
  const name = `Checkout bag ${safeTag}`;
  await db.insert(products).values({
    id,
    sku: `PKG-${safeTag}`,
    stockCode: `PKGS-${safeTag}`,
    name,
    slug: `checkout-bag-${safeTag.toLowerCase()}`,
    itemTypeId: goods.item_type_id,
    categoryId: goods.category_id,
    categoryName: goods.category_name,
    baseUnitId: goods.base_unit_id,
    price: '12',
    costPrice: '3',
    taxRate: '0',
    isTaxInclusive: true,
    stockQuantity: 100,
    isCheckoutPackaging: true,
  }).onConflictDoNothing();
  await db.insert(packagingFits).values({ productId: goods.id, packagingProductId: id, capacity: '2' }).onConflictDoNothing();
  return { id, name, slug: `checkout-bag-${safeTag.toLowerCase()}`, goodsId: goods.id, goodsName: 'Rice 5kg' };
}

async function inventoryKindProduct(kind: string, tag: string): Promise<Record<string, string>> {
  if (kind !== 'non_inventory' && kind !== 'service') throw new Error('e2e fixture: kind must be non_inventory or service');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { products } = await import('@/server/db/drizzle/schema');
  const [template] = await db.execute<{ item_type_id: string; category_id: string | null; category_name: string; base_unit_id: string }>(sql`SELECT item_type_id, category_id, category_name, base_unit_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (template === undefined) throw new Error('e2e fixture: the seed has no product to copy');
  const safeTag = tag.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const id = `prod_kind_${safeTag}`;
  const name = `${kind === 'service' ? 'Service' : 'Non-stock'} ${safeTag}`;
  const slug = `${kind}-${safeTag.toLowerCase()}`;
  await db.insert(products).values({
    id,
    sku: `KIND-${safeTag}`,
    stockCode: `KINDS-${safeTag}`,
    name,
    slug,
    itemTypeId: template.item_type_id,
    categoryId: template.category_id,
    categoryName: template.category_name,
    baseUnitId: template.base_unit_id,
    price: '40',
    costPrice: '5',
    taxRate: '0',
    isTaxInclusive: true,
    stockQuantity: 0,
    isSellable: true,
    inventoryKind: kind,
  }).onConflictDoNothing();
  return { id, name, slug, kind };
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

/** Takes a checkout bag made by `packaging` out again, with its fit rule, so it is not offered to every later test that buys the same rice. */
async function removePackaging(id: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { packagingFits, products } = await import('@/server/db/drizzle/schema');
  await db.delete(packagingFits).where(eq(packagingFits.packagingProductId, id));
  try {
    await db.delete(products).where(and(eq(products.id, id), eq(products.isCheckoutPackaging, true)));
  } catch {
    // An order that used it keeps it; it is only taken out of sale.
    await db.update(products).set({ isActive: false, deletedAt: new Date() }).where(and(eq(products.id, id), eq(products.isCheckoutPackaging, true)));
  }
  return { forgotten: id };
}

async function main(): Promise<void> {
  const [command, a, b] = process.argv.slice(2);
  let result: Record<string, string>;
  if (command === 'reviewer' && a !== undefined && b !== undefined) result = await reviewer(a, b);
  else if (command === 'product' && a !== undefined) result = await product(a);
  else if (command === 'limited-product' && a !== undefined && b !== undefined && process.argv[5] !== undefined) result = await limitedProduct(a, b, process.argv[5]);
  else if (command === 'package' && a !== undefined) result = await lunchPackage(a);
  else if (command === 'package-orders' && a !== undefined) result = await lunchOrders(a);
  else if (command === 'category-lunch' && a !== undefined) result = await categoryLunch(a, b);
  else if (command === 'packaging' && a !== undefined) result = await packaging(a);
  else if (command === 'forget-packaging' && a !== undefined) result = await removePackaging(a);
  else if (command === 'inventory-kind-product' && a !== undefined && b !== undefined) result = await inventoryKindProduct(a, b);
  else if (command === 'set-stock' && a !== undefined && b !== undefined) result = await writeStock(a, b);
  else if (command === 'order-stages' && a !== undefined) result = await readOrderStages(a);
  else if (command === 'late-order' && a !== undefined) result = await lateOrder(a, b ?? '3');
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

/** A configurable "Express lunch" package with its parts; the names and the page address are returned. */
export function makeLunchPackage(tag: string): Record<'name' | 'slug' | 'small' | 'large' | 'ugali' | 'brown' | 'sukuma' | 'cabbage' | 'id' | 'ugaliId', string> {
  const made = storefrontTool('package', tag);
  const get = (key: string): string => made[key] ?? '';
  return { name: get('name'), slug: get('slug'), small: get('small'), large: get('large'), ugali: get('ugali'), brown: get('brown'), sukuma: get('sukuma'), cabbage: get('cabbage'), id: get('id'), ugaliId: get('ugaliId') };
}

/** The lunch package with three orders for a day ten days ahead (3 + 9 servings kept, 4 cancelled). */
export function makeLunchOrders(tag: string): ReturnType<typeof makeLunchPackage> & { day: string } {
  const made = storefrontTool('package-orders', tag);
  const get = (key: string): string => made[key] ?? '';
  return { name: get('name'), slug: get('slug'), small: get('small'), large: get('large'), ugali: get('ugali'), brown: get('brown'), sukuma: get('sukuma'), cabbage: get('cabbage'), id: get('id'), ugaliId: get('ugaliId'), day: get('day') };
}

/** A lunch with a vegetable slot filled from a category and a note on each serving; with a shopper's email, that shopper has ordered it once. */
export function makeCategoryLunch(tag: string, shopperEmail?: string): Record<'name' | 'slug' | 'fish' | 'sukuma' | 'cabbage' | 'spinach' | 'id', string> {
  const made = shopperEmail === undefined ? storefrontTool('category-lunch', tag) : storefrontTool('category-lunch', tag, shopperEmail);
  const get = (key: string): string => made[key] ?? '';
  return { name: get('name'), slug: get('slug'), fish: get('fish'), sukuma: get('sukuma'), cabbage: get('cabbage'), spinach: get('spinach'), id: get('id') };
}

/** Adds a hidden, stocked checkout bag with a fit rule for the seeded rice product. */
export function makePackaging(tag: string): { id: string; name: string; slug: string; goodsId: string; goodsName: string } {
  const made = storefrontTool('packaging', tag);
  return { id: made.id ?? '', name: made.name ?? '', slug: made.slug ?? '', goodsId: made.goodsId ?? '', goodsName: made.goodsName ?? '' };
}

/** Takes a bag made by `makePackaging` out again. */
export function forgetPackaging(id: string): void {
  storefrontTool('forget-packaging', id);
}

/** Adds a zero-stock sellable product to check non-stock/service storefront ordering. */
export function makeInventoryKindProduct(kind: 'non_inventory' | 'service', tag: string): { id: string; name: string; slug: string; kind: string } {
  const made = storefrontTool('inventory-kind-product', kind, tag);
  return { id: made.id ?? '', name: made.name ?? '', slug: made.slug ?? '', kind: made.kind ?? '' };
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

/** An order that has waited in "payment started" for `hours` hours, with the late-order record the sweep makes for it; its number is returned. */
export function makeLateOrder(tag: string, hours = 3): string {
  return storefrontTool('late-order', tag, String(hours)).orderNumber ?? '';
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
