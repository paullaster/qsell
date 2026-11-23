/**
 * A credit customer with 130 invoices (more than the statement screen's page of 100), so the statement's scrolling and its whole-period
 * download can be checked.
 *   tsx e2e/support/statement-fixture.ts <tag>     prints one JSON line: { number, name, lines }
 */
import { execFileSync } from 'node:child_process';
import { e2eEnvironment } from './env';

export const LONG_STATEMENT_LINES = 130;

async function main(): Promise<void> {
  const tag = process.argv[2] ?? 'x';
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const number = `E2ELONG-${tag}`;
  const name = `Long Statement ${tag}`;
  const [customer] = await db.insert(schema.customers).values({ companyId: company.id, number, name, accountType: 'credit', creditLimit: '100000000' }).returning();
  if (customer === undefined) throw new Error('the customer was not made');
  for (let i = 0; i < LONG_STATEMENT_LINES; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    await container.finance.customerLedger.addEntry(db, {
      companyId: company.id,
      customerId: customer.id,
      documentType: 'invoice',
      documentNo: `LONG-${tag}-${String(i).padStart(3, '0')}`,
      amountCents: 100000 + i,
      currency: 'KES',
      postingDate: `2026-${i < 65 ? '08' : '09'}-${day}`,
    });
  }
  process.stdout.write(`FIXTURE ${JSON.stringify({ number, name, lines: LONG_STATEMENT_LINES })}\n`);
}

/** Makes the customer from a test and returns who it is. */
export function longStatementCustomer(tag: string): { number: string; name: string; lines: number } {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/statement-fixture.ts', tag], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the statement fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as { number: string; name: string; lines: number };
}

if (process.argv[1]?.endsWith('statement-fixture.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
