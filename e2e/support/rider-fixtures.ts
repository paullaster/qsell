/**
 * Set-up for the rider tests that a person would do from other screens:
 *   tsx e2e/support/rider-fixtures.ts staff <tag>   a member of staff (a plain account that may sign in to the back office), printed with the email and first password
 *   tsx e2e/support/rider-fixtures.ts code <delivery number>  the code the customer was sent for a delivery, the way they read it in their message
 *   tsx e2e/support/rider-fixtures.ts reset <tag>   ends every rider and puts the choice of rider kinds back to the default (staff only), so other tests are not asked about riders
 */
import { execFileSync } from 'node:child_process';
import { e2eEnvironment } from './env';

const PASSWORD = 'E2eRider-Passw0rd-3';

async function staff(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const c = getContainer();
  const email = `e2e-staff-${tag}@example.test`.toLowerCase();
  const user = await c.usersAdmin.createUser({ email, password: PASSWORD, name: `Staff Rider ${tag}`, phone: '0711000222', role: 'super_admin' });
  return { id: user.id, email, password: PASSWORD, name: `Staff Rider ${tag}` };
}

async function codeOf(number: string): Promise<Record<string, string>> {
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveries } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ code: deliveries.handoverCode }).from(deliveries).where(eq(deliveries.number, number));
  return { code: row?.code ?? '' };
}

async function reset(): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { deliveryRiders, deliveryRiderSettings, deliveryRuns } = await import('@/server/db/drizzle/schema');
  const { inArray, sql } = await import('drizzle-orm');
  const company = await getContainer().companySettings.ensureSeeded();
  // Runs given to riders are finished with, so the riders can be let go.
  await db.update(deliveryRuns).set({ status: 'cancelled', closedAt: new Date() }).where(inArray(deliveryRuns.status, ['planned', 'started']));
  await db.update(deliveryRiders).set({ status: 'ended', statusReason: 'end of the test', statusChangedAt: sql`now()` }).where(inArray(deliveryRiders.status, ['active', 'paused']));
  await db.delete(deliveryRiderSettings).where(sql`${deliveryRiderSettings.companyId} = ${company.id}`);
  return { reset: 'yes' };
}

async function main(): Promise<void> {
  const [command, tag] = process.argv.slice(2);
  let result: Record<string, string> | null = null;
  if (command === 'staff' && tag !== undefined) result = await staff(tag);
  if (command === 'code' && tag !== undefined) result = await codeOf(tag);
  if (command === 'reset') result = await reset();
  if (result === null) throw new Error('usage: rider-fixtures staff <tag> | code <delivery number> | reset');
  process.stdout.write(`FIXTURE ${JSON.stringify(result)}\n`);
}

/** Runs one of the tools above from a test and returns its answer. */
export function riderTool(...args: string[]): Record<string, string> {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/rider-fixtures.ts', ...args], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the rider tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}

if (process.argv[1]?.endsWith('rider-fixtures.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
