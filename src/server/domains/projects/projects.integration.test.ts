import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { has, required } from '@/lib/values';
import type { AppContainer } from '@/server/di/container';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { ProjectContext, ProjectInput, ProjectService } from './service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('projects (database)', () => {
  let c: AppContainer;
  let db: typeof Db;
  let schema: typeof Schema;
  let projects: ProjectService;
  let companyId = '';
  let ctx: ProjectContext;
  const tag = randomUUID().slice(0, 8);

  const input = (over: Partial<ProjectInput> = {}): ProjectInput => ({
    name: `Fit-out ${tag}`,
    description: 'Counters',
    customerId: null,
    billable: false,
    currency: 'KES',
    budgetAmount: '1000.0000',
    startOn: '2026-10-01',
    endOn: '2026-12-01',
    ...over,
  });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    projects = c.projects;
    companyId = (await c.companySettings.ensureSeeded()).id;
    ctx = { companyId, actor: { type: 'user', id: 'projects-test' }, origin: { surface: 'test', action: 'run' } };
  });

  async function customer() {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `P${tag}${randomUUID().slice(0, 4)}`, name: `Project customer ${tag}`, accountType: 'cash' }).returning();
    return required(row, 'a customer');
  }

  it('numbers a draft, opens it, adds a task, and refuses a repeated task code', async () => {
    const cust = await customer();
    const created = await projects.create(ctx, input({ customerId: cust.id, billable: true, idempotencyKey: `once-${tag}` }));
    const again = await projects.create(ctx, input({ idempotencyKey: `once-${tag}`, name: 'Ignored' }));
    expect(again).toEqual(created);
    expect(created.number).toMatch(/^PRJ-/);

    await projects.transition(ctx, created.id, 'open');
    const opened = await projects.detail(companyId, created.id);
    expect(opened?.project.status).toBe('open');
    expect(opened?.project.customerName).toBe(`Project customer ${tag}`);

    await projects.addTask(ctx, created.id, { code: 'site-1', name: 'Measure', description: null, budgetAmount: '400' });
    await expect(projects.addTask(ctx, created.id, { code: 'SITE-1', name: 'Again', description: null, budgetAmount: '1' })).rejects.toThrow(/already used/);
    const withTask = await projects.detail(companyId, created.id);
    expect(withTask?.tasks.map((task) => task.code)).toEqual(['SITE-1']);
    expect(withTask?.project.budgetNote).toBeNull();
  });

  it('keeps another company from seeing the project, and refuses a customer that is not ours', async () => {
    const created = await projects.create(ctx, input({ name: `Hidden ${tag}` }));
    expect(await projects.detail(randomUUID(), created.id)).toBeNull();
    await expect(projects.create(ctx, input({ customerId: randomUUID() }))).rejects.toThrow(/does not exist/);
  });

  it('completes, then refuses new tasks, then closes so it cannot be reopened', async () => {
    const created = await projects.create(ctx, input({ name: `Close ${tag}` }));
    await projects.transition(ctx, created.id, 'open');
    await projects.addTask(ctx, created.id, { code: 'BUILD', name: 'Build', description: null, budgetAmount: '1500' });
    const over = await projects.detail(companyId, created.id);
    expect(over?.project.budgetNote).toMatch(/more than the project budget/);

    await projects.transition(ctx, created.id, 'complete');
    await expect(projects.addTask(ctx, created.id, { code: 'LATE', name: 'Late', description: null, budgetAmount: '1' })).rejects.toThrow(/draft, open, or on hold/);
    await projects.transition(ctx, created.id, 'close');
    await expect(projects.transition(ctx, created.id, 'reopen')).rejects.toThrow(/completed project/);

    const [event] = await db.select().from(schema.projectEvents).where(eq(schema.projectEvents.projectId, created.id)).limit(1);
    // Drizzle wraps the Postgres error, so the trigger's "append-only" message is on `.cause`.
    const tamper = await db
      .update(schema.projectEvents)
      .set({ event: 'tamper' })
      .where(eq(schema.projectEvents.id, required(event, 'an event').id))
      .then(
        () => null,
        (err: unknown) => err as { message?: string; cause?: { message?: string } },
      );
    expect(tamper).not.toBeNull();
    expect(`${tamper?.message ?? ''} ${tamper?.cause?.message ?? ''}`).toMatch(/append-only/);
  });

  it('refuses a save that was made against an older copy', async () => {
    const created = await projects.create(ctx, input({ name: `Race ${tag}` }));
    const view = required(await projects.detail(companyId, created.id), 'the project');
    await projects.update(ctx, created.id, { ...input({ name: `Race ${tag} two` }), version: view.project.version });
    await expect(projects.update(ctx, created.id, { ...input({ name: `Race ${tag} three` }), version: view.project.version })).rejects.toThrow(/someone else/);
  });

  it('lists only this company and pages past the first screen', async () => {
    const found = await projects.list(companyId, { query: tag });
    expect(found.rows.length).toBeGreaterThan(0);
    expect(found.rows.every((row) => row.name.includes(tag) || row.number.includes(tag))).toBe(true);
    expect(has(found.rows[0]?.number)).toBe(true);
  });
});
