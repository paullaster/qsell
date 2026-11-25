/**
 * Set-up for the van sales tests that a person would do from other screens:
 *   tsx e2e/support/van-fixtures.ts customer <tag> <n>   n customers with a phone and a town, printed as their names (a person makes these under Customers)
 *   tsx e2e/support/van-fixtures.ts product <tag>        a product kept in stock, counted in whole pieces, printed with its name (made under Products)
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

async function main(): Promise<void> {
  const [command, tag, count] = process.argv.slice(2);
  let result: Record<string, string> | null = null;
  if (command === 'customer' && tag !== undefined) result = await customers(tag, Number(count ?? '1'));
  if (command === 'product' && tag !== undefined) result = await product(tag);
  if (result === null) throw new Error('usage: van-fixtures customer <tag> <n> | product <tag>');
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
