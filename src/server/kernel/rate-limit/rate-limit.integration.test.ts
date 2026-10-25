import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import { RATE_RULES } from '@/lib/rate-limit';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type { RateLimitService } from './service';

/** Needs a Postgres built from the migrations:  TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('request limits (database)', () => {
  let db: DrizzleDb;
  let schema: typeof mod_schema;
  let limits: RateLimitService;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    const { RateLimitService: Service } = await import('./service');
    limits = new Service(db);
  });

  it('allows the limit, then refuses with a wait, and a new window starts fresh', async () => {
    const who = randomUUID();
    const rule = RATE_RULES.login_account;
    const start = new Date('2026-10-25T10:00:00Z');
    for (let i = 0; i < rule.limit; i += 1) expect((await limits.hit('login_account', who, start)).allowed).toBe(true);
    const refused = await limits.hit('login_account', who, new Date(start.getTime() + 60_000));
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(rule.seconds);
    expect((await limits.hit('login_account', who, new Date(start.getTime() + rule.seconds * 1000))).allowed).toBe(true);
  });

  it('keeps keys apart and counts concurrent tries exactly', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 20 }, () => limits.hit('mail_account', a, now)));
    expect(results.filter((r) => r.allowed)).toHaveLength(RATE_RULES.mail_account.limit);
    expect((await limits.hit('mail_account', b, now)).allowed).toBe(true);
    const [row] = await db.select().from(schema.rateLimitHits).where(eq(schema.rateLimitHits.key, `mail_account:${a}`));
    expect(row?.hits).toBe(20);
  });

  it('removes windows older than a day when a new window starts', async () => {
    const who = randomUUID();
    const old = new Date(Date.now() - 3 * 86_400_000);
    await limits.hit('register_ip', who, old);
    expect((await db.select().from(schema.rateLimitHits).where(like(schema.rateLimitHits.key, `register_ip:${who}`))).length).toBe(1);
    await limits.hit('register_ip', randomUUID(), new Date());
    expect((await db.select().from(schema.rateLimitHits).where(like(schema.rateLimitHits.key, `register_ip:${who}`))).length).toBe(0);
  });
});
