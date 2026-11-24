import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type * as ClientModule from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type * as ServiceModule from './report-audit-service';
import { has } from '@/lib/values';

/**
 * The report audit against a real database built from the migrations (including 0208):
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Each run uses its own report code, so rows from other runs in a shared database never change what is counted.
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('report audit (database)', () => {
  let db: typeof ClientModule.drizzleDb;
  let schema: typeof SchemaModule;
  let ReportAuditService: typeof ServiceModule.ReportAuditService;
  let service: ServiceModule.ReportAuditService;
  let companyId: string;
  const code = `audit-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ ReportAuditService } = await import('./report-audit-service'));
    const container = (await import('@/server/di/container')).getContainer();
    companyId = (await container.companySettings.ensureSeeded()).id;
    service = new ReportAuditService(db, () => Promise.resolve(companyId));
  });

  it('finds the names of people, ignores anything that is not an id, and copes with none', async () => {
    expect((await service.namesOf([])).size).toBe(0);
    expect((await service.namesOf(['u-1', 'not-an-id'])).size).toBe(0);
    expect((await service.namesOf([randomUUID()])).size).toBe(0);
    const [person] = await db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .limit(1);
    if (person !== undefined)
      expect((await service.namesOf([person.id, person.id])).get(person.id)).toBe(person.name);
  });

  it('records a run and an export, with the file fingerprint on the export', async () => {
    await service.record({
      userId: 'u-1',
      reportCode: code,
      action: 'run',
      params: { asOf: '2026-03-10' },
      definitionsVersion: '2026-11-v1',
      rowCount: null,
      truncated: false,
    });
    await service.record({
      userId: 'u-1',
      reportCode: code,
      action: 'export',
      params: { asOf: '2026-03-10' },
      definitionsVersion: '2026-11-v1',
      rowCount: 12,
      truncated: false,
      format: 'csv',
      contentHash: 'a'.repeat(64),
    });
    const page = await service.list({ reportCode: code });
    expect(page.rows).toHaveLength(2);
    const exported = page.rows.find((r) => r.action === 'export');
    expect(exported).toMatchObject({ format: 'csv', rowCount: 12, contentHash: 'a'.repeat(64) });
    expect(exported?.params).toEqual({ asOf: '2026-03-10' });
  });

  it('refuses an export with no format or no fingerprint (the database checks it)', async () => {
    await expect(
      db.insert(schema.reportAudit).values({
        companyId,
        userId: 'u-1',
        reportCode: code,
        action: 'export',
        definitionsVersion: 'v',
      }),
    ).rejects.toThrow();
  });

  it('refuses an action or format it does not know', async () => {
    await expect(
      db.insert(schema.reportAudit).values({
        companyId,
        userId: 'u-1',
        reportCode: code,
        action: 'delete' as never,
        definitionsVersion: 'v',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.reportAudit).values({
        companyId,
        userId: 'u-1',
        reportCode: code,
        action: 'export',
        format: 'docx' as never,
        contentHash: 'x',
        definitionsVersion: 'v',
      }),
    ).rejects.toThrow();
  });

  it('keeps every row: it cannot be changed or deleted', async () => {
    const [row] = await service.list({ reportCode: code }).then((p) => p.rows);
    expect(row).toBeDefined();
    const id = Number(row?.id);
    expect(Number.isInteger(id)).toBe(true);
    await expect(
      db.execute(
        sql.raw(`update report_audit set user_id = 'someone-else' where id = ${String(id)}`),
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql.raw(`delete from report_audit where id = ${String(id)}`)),
    ).rejects.toThrow();
  });

  it('stores only a plain object as parameters', async () => {
    await service.record({
      userId: 'u-2',
      reportCode: code,
      action: 'run',
      params: 'not an object',
      definitionsVersion: 'v',
      rowCount: null,
      truncated: false,
    });
    const page = await service.list({ reportCode: code, userId: 'u-2' });
    expect(page.rows[0]?.params).toEqual({});
  });

  it('pages newest first by row number with no repeats, and filters', async () => {
    for (let i = 0; i < 5; i += 1) {
      await service.record({
        userId: 'u-3',
        reportCode: `${code}-paged`,
        action: 'run',
        params: { n: i },
        definitionsVersion: 'v',
        rowCount: null,
        truncated: false,
      });
    }
    const first = await service.list({ reportCode: `${code}-paged` }, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await service.list(
      { reportCode: `${code}-paged` },
      { limit: 2, ...(first.next === null ? {} : { before: first.next }) },
    );
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const last = await service.list(
      { reportCode: `${code}-paged` },
      { limit: 2, ...(second.next === null ? {} : { before: second.next }) },
    );
    expect(last.rows).toHaveLength(1);
    expect(last.next).toBeNull();
    expect((await service.list({ reportCode: `${code}-paged`, action: 'export' })).rows).toEqual(
      [],
    );
  });

  it('only shows the company its own rows', async () => {
    const other = new ReportAuditService(db, () => Promise.resolve(randomUUID()));
    expect((await other.list({ reportCode: code })).rows).toEqual([]);
  });
});
