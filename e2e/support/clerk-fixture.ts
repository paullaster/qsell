/**
 * Set-up for tests that need a member of staff who can see orders and write quotes but may NOT update products:
 *   tsx e2e/support/clerk-fixture.ts clerk <tag>   makes the role (once) and one account with it, printed with its email and password
 * The account is ready to sign in with: it is not asked to choose a new password first.
 */
import { execFileSync } from 'node:child_process';
import { e2eEnvironment } from './env';

const PASSWORD = 'E2eClerk-Passw0rd-5';
const ROLE = 'e2e_clerk';
/** Everything a clerk needs to take orders and quote, and nothing that updates products. */
const GRANTS = ['dashboard:read', 'orders:read', 'products:read', 'quotes:read', 'quotes:create', 'quotes:update', 'customers:read'];

async function clerk(tag: string): Promise<Record<string, string>> {
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const { users } = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const c = getContainer();
  const repo = c.accessControl.repo;
  const role = (await repo.findRoleByKey(ROLE)) ?? (await repo.createRole({ key: ROLE, name: 'E2E clerk', description: 'Orders and quotes, no product changes', isStaff: true }));
  if (role === null) throw new Error('clerk fixture: the role was not made');
  await repo.setRolePermissions(role.id, GRANTS.map((permissionKey) => ({ permissionKey, effect: 'allow' as const })));
  const email = `e2e-clerk-${tag}@example.test`.toLowerCase();
  const user = await c.usersAdmin.createUser({ email, password: PASSWORD, name: `Clerk ${tag}`, phone: '0711000333', role: ROLE });
  // Signing in is what is under test, not choosing a password.
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id));
  return { id: user.id, email, password: PASSWORD };
}

async function main(): Promise<void> {
  const [command, tag] = process.argv.slice(2);
  if (command !== 'clerk' || tag === undefined) throw new Error('usage: clerk-fixture clerk <tag>');
  process.stdout.write(`FIXTURE ${JSON.stringify(await clerk(tag))}\n`);
}

/** Runs the tool from a test and returns its answer. */
export function clerkTool(tag: string): { id: string; email: string; password: string } {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/clerk-fixture.ts', 'clerk', tag], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the clerk tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as { id: string; email: string; password: string };
}

if (process.argv[1]?.endsWith('clerk-fixture.ts') === true) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
