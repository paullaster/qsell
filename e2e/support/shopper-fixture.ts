/**
 * Makes a shopper (a verified storefront login with its customer card) for one test, with `orders` orders of their own and one
 * order that belongs to somebody else, and prints what the test needs as one line of JSON. Run with the end-to-end environment:
 *   tsx e2e/support/shopper-fixture.ts <tag> <orders>
 * A new tag makes a new shopper, so a retried test starts clean.
 */
import { sql } from 'drizzle-orm';
import { E2E_SHOPPER_PASSWORD } from './constants';

async function main(): Promise<void> {
  const [tag, count] = process.argv.slice(2);
  if (tag === undefined || count === undefined)
    throw new Error('usage: shopper-fixture <tag> <orders>');
  const { getContainer } = await import('@/server/di/container');
  const { UserRepository } = await import('@/server/domains/auth/user-repository');
  const { StorefrontCustomerService } =
    await import('@/server/domains/customers/storefront-service');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const branch = await container.branches.getDefault(company.id);
  if (branch === null) throw new Error('e2e fixture: the company has no default branch');
  const email = `shopper-${tag}@example.test`;
  const name = `Shopper ${tag}`;
  const customer = await StorefrontCustomerService.ensure({ name, email, phone: '0711000111' });
  await new UserRepository().create({
    email,
    password: E2E_SHOPPER_PASSWORD,
    name,
    role: 'customer',
    customerStoreId: customer.id,
    emailVerified: true,
  });
  await container.customers.ensureStorefrontCustomer(company.id, {
    name,
    email,
    phone: '0711000111',
  });

  const numbers: string[] = [];
  const insert = async (n: number, userId: string, label: string): Promise<void> => {
    const id = `sh_${tag}_${String(n)}`;
    const number = `SH-${tag}-${String(n)}`;
    if (userId === customer.id) numbers.push(number);
    const created = new Date(Date.now() - n * 3_600_000).toISOString();
    await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status, payment_status, internal_notes, created_at)
      VALUES (${id}, ${number}, ${userId}, ${branch.id}::uuid, ${name}, ${email}, '0711000111', '{"street":"1 Moi Avenue","city":"Nairobi","countyOrState":"Nairobi","country":"Kenya"}'::jsonb, 1000, 160, 0, 1160, 'mpesa_daraja', ${n % 2 === 0 ? 'shipped' : 'pending'}, 'paid', ${`INTERNAL-${label}`}, ${created}::timestamptz)`);
    await db.execute(sql`INSERT INTO order_items (order_id, product_id, product_name, sku, quantity, unit_price, total_price, image_url)
      VALUES (${id}, 'p1', ${`Solar lamp ${tag}`}, 'SL-1', 2, 500, 1000, '')`);
  };
  for (let n = 1; n <= Number(count); n += 1) await insert(n, customer.id, 'mine');
  await insert(99, `someone-else-${tag}`, 'theirs');
  process.stdout.write(
    `FIXTURE ${JSON.stringify({ email, password: E2E_SHOPPER_PASSWORD, numbers, otherNumber: `SH-${tag}-99`, otherId: `sh_${tag}_99` })}\n`,
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
