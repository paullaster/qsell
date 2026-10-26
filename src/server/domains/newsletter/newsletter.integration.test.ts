import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { has, required } from '@/lib/values';
import type { NewsletterService as Service } from './service';

/** The mailing list against a real database: double opt-in, one-click unsubscribe, and who is listed.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('newsletter (database)', () => {
  let service: typeof Service;
  const tag = randomUUID().slice(0, 6);
  const address = (n: number) => `n${String(n)}-${tag}@example.test`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ NewsletterService: service } = await import('./service'));
  });

  it('nobody is subscribed until the link is followed, and following it twice changes nothing', async () => {
    const email = address(1);
    const token = required(await service.request(email), 'a token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await service.tokenFor(email)).toBeNull(); // pending: nothing may be sent
    expect((await service.confirmedEmails()).map((row) => row.email)).not.toContain(email);

    expect(await service.confirm(token)).toBe(true);
    expect(await service.confirm(token)).toBe(true);
    expect(await service.tokenFor(email)).toBe(token);
    expect((await service.confirmedEmails()).map((row) => row.email)).toContain(email);
    // Someone already listed gets no second message.
    expect(await service.request(email)).toBeNull();
  });

  it('asking again before confirming replaces the link, so an old link stops working', async () => {
    const email = address(2);
    const first = required(await service.request(email), 'a token');
    const second = required(await service.request(email), 'a token');
    expect(second).not.toBe(first);
    expect(await service.confirm(first)).toBe(false);
    expect(await service.confirm(second)).toBe(true);
  });

  it('unsubscribing takes the address off the list, and it can start again from nothing', async () => {
    const email = address(3);
    const token = required(await service.request(email), 'a token');
    await service.confirm(token);
    expect(await service.unsubscribe(token)).toBe(true);
    expect((await service.confirmedEmails()).map((row) => row.email)).not.toContain(email);
    // The old link cannot bring them back.
    expect(await service.confirm(token)).toBe(false);
    const again = required(await service.request(email), 'a token');
    expect(await service.tokenFor(email)).toBeNull();
    expect(await service.confirm(again)).toBe(true);
  });

  it('an unknown token does nothing', async () => {
    const unknown = 'A'.repeat(43);
    expect(await service.confirm(unknown)).toBe(false);
    expect(await service.unsubscribe(unknown)).toBe(false);
  });

  it('lists a page at a time by status and words, with the totals', async () => {
    for (let n = 10; n < 16; n += 1) await service.confirm(required(await service.request(address(n)), 'a token'));
    const page = await service.page({ status: 'subscribed', query: tag, cursor: null });
    expect(page.rows.length).toBeGreaterThanOrEqual(6);
    expect(page.rows.every((row) => row.email.includes(tag))).toBe(true);
    expect(page.totals.subscribed).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(page.rows)).not.toContain('token');
  });

  it('the database refuses an address that is not lower-case', async () => {
    const { drizzleDb } = await import('@/server/db/drizzle/client');
    const { newsletterSubscribers } = await import('@/server/db/drizzle/schema');
    await expect(drizzleDb.insert(newsletterSubscribers).values({ email: `UPPER-${tag}@example.test`, token: randomUUID().replaceAll('-', '').padEnd(43, 'x').slice(0, 43) })).rejects.toThrow();
  });
});
