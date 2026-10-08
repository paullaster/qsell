// Container healthcheck for the Graphile worker, which has no HTTP port.
// Verifies the worker can reach its database and that its job tables exist
// (graphile-worker migrates them on start-up, so absence means it never booted).
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) process.exit(1);

const sql = postgres(url, { max: 1, connect_timeout: 4, idle_timeout: 1 });
try {
  const [row] = await sql`select to_regclass('graphile_worker._private_jobs') as jobs`;
  process.exit(row?.jobs ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  await sql.end({ timeout: 1 }).catch(() => undefined);
}
