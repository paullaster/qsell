/**
 * Runs the media sweep once, by hand:
 *
 *   npx tsx scripts/purge-media.ts
 *
 * The same sweep runs nightly in the worker (`purge-media`). Local development usually has
 * no worker running, so use this to clear leftovers: uploads never attached to a product
 * (older than 24 h) and deleted media past its 30-day retention.
 */
/* eslint-disable no-console -- a CLI: printing the result is its whole job */
import 'dotenv/config';
import { getContainer } from '@/server/di/container';

async function main(): Promise<void> {
  const result = await getContainer().media.purge();
  console.log(
    `Removed ${result.stalePendingRemoved} unattached upload(s) and ${result.expiredDeletedRemoved} expired deleted file(s); ${result.failed} failed.`,
  );
  process.exit(result.failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
