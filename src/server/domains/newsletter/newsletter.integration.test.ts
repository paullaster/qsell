import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('a newsletter goes to the confirmed in slices, each with its own unsubscribe link, and reaches each person once', async () => {
    const { sendCampaignSlice } = await import('./campaign');
    const { getContainer } = await import('@/server/di/container');
    const mine: string[] = [];
    for (let n = 100; n < 130; n++) {
      const email = address(n);
      mine.push(email);
      const token = required(await service.request(email), 'a token');
      await service.confirm(token);
    }
    const send = vi.spyOn(getContainer().email, 'send').mockResolvedValue({ ok: true } as never);
    const reached = new Set<string>();
    let step: Parameters<typeof sendCampaignSlice>[0] | null = { campaignId: randomUUID(), subject: 'News', body: 'Hello <b>there</b>, ten percent off.', after: null, sent: 0, failed: 0 };
    let slices = 0;
    while (step !== null) {
      const r = await sendCampaignSlice(step);
      slices += 1;
      step = r.next;
      expect(slices).toBeLessThan(200);
    }
    for (const call of send.mock.calls) {
      const message = call[0];
      reached.add(message.to);
      expect(message.html).toContain('Unsubscribe');
      expect(message.html).toContain('Hello &lt;b&gt;there&lt;/b&gt;');
      expect(message.text).toMatch(/unsubscribe\?token=[A-Za-z0-9_-]{43}/);
    }
    expect(mine.every((email) => reached.has(email))).toBe(true);
    expect(send.mock.calls.length).toBe(reached.size);
    send.mockRestore();
  });

  it('a mail server that is down fails the slice so the worker tries it again, and one bad address does not stop the rest', async () => {
    const { sendCampaignSlice } = await import('./campaign');
    const { getContainer } = await import('@/server/di/container');
    const down = vi.spyOn(getContainer().email, 'send').mockRejectedValue(new Error('smtp down'));
    await expect(sendCampaignSlice({ campaignId: randomUUID(), subject: 'News', body: 'Hello there friend', after: null, sent: 0, failed: 0 })).rejects.toThrow('smtp down');
    down.mockRestore();
    let n = 0;
    const flaky = vi.spyOn(getContainer().email, 'send').mockImplementation(() => (++n === 1 ? Promise.reject(new Error('bad address')) : Promise.resolve({ ok: true } as never)));
    const r = await sendCampaignSlice({ campaignId: randomUUID(), subject: 'News', body: 'Hello there friend', after: null, sent: 0, failed: 0 });
    expect(r.failed).toBe(1);
    expect(r.sent).toBeGreaterThan(0);
    flaky.mockRestore();
  });
});
