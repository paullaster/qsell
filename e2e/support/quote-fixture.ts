/**
 * A sent quote for two teas at 100 each, to a customer made for the test, so a quote can be converted on screen.
 *   tsx e2e/support/quote-fixture.ts <tag> <credit|cash>     prints one JSON line: { number, customer, token } (the token is the customer's link)
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { e2eEnvironment } from './env';
import { E2E_ADMIN_EMAIL } from './constants';

async function main(): Promise<void> {
  const [tag = 'x', kind = 'credit'] = process.argv.slice(2);
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { SalesQuoteService } = await import('@/server/domains/quotes/service');
  const { eq } = await import('drizzle-orm');
  const company = await getContainer().companySettings.ensureSeeded();
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, E2E_ADMIN_EMAIL)).limit(1);
  if (admin === undefined) throw new Error('the e2e admin is missing');
  const itemTypeId = `it_qc_${randomUUID().slice(0, 8)}`;
  await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  const productId = `prod_${randomUUID()}`;
  await db.insert(schema.products).values({ id: productId, sku: `QC-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `QCS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Quote tea', slug: `qc-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
  const credit = kind === 'credit';
  const name = `Convert ${kind} ${tag}`;
  const [customer] = await db.insert(schema.customers).values({ companyId: company.id, number: `QCV-${randomUUID().slice(0, 8)}`, name, email: `qcv-${randomUUID().slice(0, 8)}@qc.test`, phone: '0711000444', accountType: credit ? 'credit' : 'cash', creditLimit: credit ? '1000000' : '0', paymentTermDays: credit ? 30 : 0, street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' }).returning();
  if (customer === undefined) throw new Error('the customer was not made');
  const quotes = new SalesQuoteService();
  const made = await quotes.create(admin.id, { customerId: customer.id, customerName: name, customerEmail: customer.email, currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee: 0, sections: [], lines: [{ productId, quantity: 2, unitPrice: 100, discountPercent: 0 }] });
  // The link the customer's email carries: a long random token, of which only the hash is kept.
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  await db.update(schema.salesQuotes).set({ status: 'sent', shareTokenHash: createHash('sha256').update(token).digest('hex'), deliveryAddress: { street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' } }).where(eq(schema.salesQuotes.id, made.id));
  process.stdout.write(`FIXTURE ${JSON.stringify({ number: made.quoteNumber, customer: name, token })}\n`);
}

/** Makes the quote from a test and returns who it is for and its number. */
export function sentQuoteFor(tag: string, kind: 'credit' | 'cash'): { number: string; customer: string; token: string } {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/quote-fixture.ts', tag, kind], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the quote fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as { number: string; customer: string; token: string };
}

if (process.argv[1]?.endsWith('quote-fixture.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
