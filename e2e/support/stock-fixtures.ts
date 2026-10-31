/**
 * Set-up for the stock end-to-end tests that a person could not do from the screens, printed as one line of JSON. Run with the
 * end-to-end environment:
 *   tsx e2e/support/stock-fixtures.ts ledger on|off                        make the per-location ledger the truth (or not)
 *   tsx e2e/support/stock-fixtures.ts product <tag> <quantity> [<place code>]  a product with this much stock at a place (the default one if none)
 *   tsx e2e/support/stock-fixtures.ts place <code> <name>                  a stock location, if it is not there yet
 *   tsx e2e/support/stock-fixtures.ts at <product name> <place code>       how much of a product is at a place
 *   tsx e2e/support/stock-fixtures.ts receive <product id> <quantity> <place code>  more stock of a product at a place
 *   tsx e2e/support/stock-fixtures.ts order <tag> <product id> <quantity>  an order for a product, placed the way the shop places it (the stock is held)
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { e2eEnvironment } from './env';

async function container() {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const c = getContainer();
  const companyId = (await c.companySettings.ensureSeeded()).id;
  return { c, db, companyId };
}

async function ledger(mode: string): Promise<Record<string, string>> {
  const { c, companyId } = await container();
  await c.stockLocations.ensureDefault(companyId);
  await c.stockShadow.setShadow(companyId, false);
  await c.stockSettings.setLedgerMode(companyId, mode === 'on', { requireCleanShadow: false });
  return { ledger: mode };
}

async function place(code: string, name: string): Promise<Record<string, string>> {
  const { c, db, companyId } = await container();
  const [found] = await db.execute<{ id: string }>(sql`SELECT id FROM stock_locations WHERE company_id = ${companyId}::uuid AND lower(code) = lower(${code}) LIMIT 1`);
  if (found !== undefined) return { id: found.id, code };
  const made = await c.stockLocations.create(companyId, { code, name, kind: 'warehouse' });
  return { id: made.id, code };
}

async function product(tag: string, quantity: string, code: string): Promise<Record<string, string>> {
  const { c, db, companyId } = await container();
  const { products } = await import('@/server/db/drizzle/schema');
  const [template] = await db.execute<{ item_type_id: string }>(sql`SELECT item_type_id FROM products WHERE name = 'Rice 5kg' AND deleted_at IS NULL LIMIT 1`);
  if (template === undefined) throw new Error('e2e fixture: the seed has no product to copy');
  const name = `Stocked ${tag}`;
  const id = `prod_stk_${tag}`;
  await db.insert(products).values({ id, sku: `STK-${tag}`.toUpperCase(), stockCode: `STKS-${tag}`.toUpperCase(), name, slug: `stocked-${tag}`.toLowerCase(), itemTypeId: template.item_type_id, price: '250', costPrice: '100', taxRate: '0', isTaxInclusive: true, stockQuantity: 0, categoryName: 'E2E Pantry' });
  const target = code === '' ? (await c.stockLocations.ensureDefault(companyId)).id : (await place(code, code)).id;
  await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: id, locationId: target ?? '', type: 'opening', quantity: Number(quantity), unitCost: 100, documentType: 'e2e', documentId: randomUUID(), actor: { type: 'job' } }));
  return { name, id };
}

async function at(name: string, code: string): Promise<Record<string, string>> {
  const { db, companyId } = await container();
  const [row] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(sum(b.on_hand), 0) AS total FROM stock_balances b
    JOIN products p ON p.id = b.product_id JOIN stock_locations l ON l.id = b.location_id
    WHERE p.name = ${name} AND lower(l.code) = lower(${code}) AND l.company_id = ${companyId}::uuid`);
  return { quantity: String(Number(row?.total ?? 0)) };
}

async function receive(productId: string, quantity: string, code: string): Promise<Record<string, string>> {
  const { c, db, companyId } = await container();
  const target = (await place(code, code)).id;
  await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: target, type: 'receipt', quantity: Number(quantity), unitCost: 100, documentType: 'e2e', documentId: randomUUID(), actor: { type: 'job' } }));
  return { id: productId };
}

async function order(tag: string, productId: string, quantity: string): Promise<Record<string, string>> {
  const { c, companyId } = await container();
  const { OrderWriteService } = await import('@/server/domains/orders/write-service');
  const branch = await c.branches.getDefault(companyId);
  const number = `E2E-ST-${tag}`.toUpperCase();
  const result = await OrderWriteService.createOrder({
    branchId: branch?.id ?? null,
    orderNumber: number,
    customerName: `Stock Buyer ${tag}`,
    customerEmail: `stock-${tag}@example.test`.toLowerCase(),
    customerPhone: '0711000555',
    shippingAddress: { street: '1 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
    items: [{ productId, quantity: Number(quantity) }],
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
  });
  if (!result.success) throw new Error(`e2e fixture: the order was refused: ${result.error ?? 'no reason'}`);
  return { orderNumber: number };
}

async function main(): Promise<void> {
  const [command, a, b, d] = process.argv.slice(2);
  let result: Record<string, string>;
  if (command === 'ledger' && (a === 'on' || a === 'off')) result = await ledger(a);
  else if (command === 'product' && a !== undefined && b !== undefined) result = await product(a, b, d ?? '');
  else if (command === 'place' && a !== undefined && b !== undefined) result = await place(a, b);
  else if (command === 'at' && a !== undefined && b !== undefined) result = await at(a, b);
  else if (command === 'receive' && a !== undefined && b !== undefined && d !== undefined) result = await receive(a, b, d);
  else if (command === 'order' && a !== undefined && b !== undefined && d !== undefined) result = await order(a, b, d);
  else throw new Error('usage: stock-fixtures ledger on|off | product <tag> <quantity> [<place>] | place <code> <name> | at <product name> <place>');
  process.stdout.write(`FIXTURE ${JSON.stringify(result)}\n`);
}

/** Runs one of the tools above from a test and returns its answer. */
export function stockTool(...args: string[]): Record<string, string> {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/stock-fixtures.ts', ...args], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the stock tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}

export const setLedger = (mode: 'on' | 'off'): void => void stockTool('ledger', mode);
export const stockedProduct = (tag: string, quantity: number, place = ''): { name: string; id: string } => {
  const made = stockTool('product', tag, String(quantity), place);
  return { name: made.name ?? '', id: made.id ?? '' };
};
export const makePlace = (code: string, name: string): string => stockTool('place', code, name).id ?? '';
export const receiveStock = (productId: string, quantity: number, place: string): void => void stockTool('receive', productId, String(quantity), place);
export const placeOrder = (tag: string, productId: string, quantity: number): string => stockTool('order', tag, productId, String(quantity)).orderNumber ?? '';
export const quantityAt = (productName: string, place: string): number => Number(stockTool('at', productName, place).quantity ?? '0');

if (process.argv[1]?.endsWith('stock-fixtures.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
