import postgres from 'postgres';

interface PostsInventory {
  inventoryPosting: { processDue: (limit: number) => Promise<{ posted: number; failed: number }> };
}

/**
 * Every journal line a test writes is also an event waiting to be posted to the books, for every company that has stock in the
 * books. The database is shared by all test files, so a file that writes many leaves them for the next one that posts (and times
 * out waiting). A file that writes stock cleans up after itself with this.
 */
export async function settleFinanceBacklog(finance: PostsInventory): Promise<void> {
  const batch = 500;
  for (let pass = 0; pass < 100; pass += 1) {
    const out = await finance.inventoryPosting.processDue(batch);
    if (out.posted + out.failed < batch) return;
  }
}

/** One lock for every test file that needs the company-wide "stock by location" switch in a known state while it runs. */
const LEDGER_SWITCH_LOCK = 7_260_104;

/**
 * Holds, for the life of a test file, the lock that says "I am using the company-wide stock-by-location switch". Test files share one
 * database and one company, so two files that switch it on and off at the same time confuse each other (the cut-over test, which
 * watches that very switch, most of all). A file that needs the switch takes this first and gives it back last; the lock belongs to
 * the connection, so a file that dies does not keep it. Returns the function that gives it back.
 */
export async function holdLedgerSwitch(url: string | undefined): Promise<() => Promise<void>> {
  if (url === undefined || url === '') return () => Promise.resolve();
  const client = postgres(url, { max: 1 });
  await client`SELECT pg_advisory_lock(${LEDGER_SWITCH_LOCK})`;
  return async () => {
    await client`SELECT pg_advisory_unlock(${LEDGER_SWITCH_LOCK})`;
    await client.end();
  };
}
