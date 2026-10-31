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
