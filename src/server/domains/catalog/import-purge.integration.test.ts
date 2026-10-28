import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { has } from '@/lib/values';

const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('product import retention purge (database)', () => {
  it('deletes completed imports older than the cutoff and cascades their staged rows', async () => {
    const [{ drizzleDb }, schema, { ProductImportService }] = await Promise.all([
      import('@/server/db/drizzle/client'),
      import('@/server/db/drizzle/schema'),
      import('./import-service'),
    ]);
    const id = randomUUID();
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const service = new ProductImportService(drizzleDb, () => Promise.resolve(), {} as never, {
      numbering: () => undefined as never,
      companyId: () => Promise.resolve(''),
    });

    await drizzleDb.insert(schema.productImportJobs).values({
      id,
      status: 'completed',
      fileName: 'retention-test.csv',
      fileSha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      totalRows: 1,
      finishedAt: new Date(cutoff.getTime() - 1),
    });
    await drizzleDb.insert(schema.productImportRows).values({
      jobId: id,
      rowNumber: 2,
      data: {},
      raw: {},
    });

    await expect(service.purgeFinishedBefore(cutoff)).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      drizzleDb
        .select({ id: schema.productImportJobs.id })
        .from(schema.productImportJobs)
        .where(eq(schema.productImportJobs.id, id)),
    ).resolves.toEqual([]);
    await expect(
      drizzleDb
        .select({ id: schema.productImportRows.id })
        .from(schema.productImportRows)
        .where(eq(schema.productImportRows.jobId, id)),
    ).resolves.toEqual([]);
  });
});
