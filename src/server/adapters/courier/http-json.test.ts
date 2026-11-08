import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAPPING, checkHttpSettings } from '@/lib/courier-http';
import { HttpJsonCourierAdapter, signatureValid, type Fetcher } from './http-json';
import { CourierError } from './port';

const settings = (over: Record<string, unknown> = {}) => {
  const r = checkHttpSettings({ baseUrl: 'https://api.swift.co.ke', ...over });
  if (!r.ok) throw new Error(r.error);
  return r.settings;
};
const request = { deliveryNumber: 'DLV-26-1', courierName: 'Swift', trackingNumber: null, recipientName: 'Wanjiru', recipientPhone: '254711000000', destination: 'Westlands, Nairobi', parcels: 1 };
const publicDns = () => Promise.resolve(['41.90.1.1']);
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
const reply = (status: number, body: unknown, seen: Seen[] = []): Fetcher => (url, init) => {
  seen.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
  return Promise.resolve({ status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });
};
const adapter = (f: Fetcher, over: Record<string, unknown> = {}, dns = publicDns) => new HttpJsonCourierAdapter(settings(over), 'Bearer secret-key', f, dns);

describe('the http_json courier adapter', () => {
  it('books with our fixed request, the key in its header, and reads the answer by the mapping', async () => {
    const seen: Seen[] = [];
    const a = adapter(reply(200, { tracking_number: 'SW42', tracking_url: 'https://track.swift.co.ke/SW42', label_url: 'https://swift.co.ke/l/SW42.pdf' }, seen));
    expect(await a.book(request)).toEqual({ trackingNumber: 'SW42', trackingUrl: 'https://track.swift.co.ke/SW42', labelUrl: 'https://swift.co.ke/l/SW42.pdf', externalId: 'SW42' });
    expect(seen[0]).toMatchObject({ url: 'https://api.swift.co.ke/shipments', method: 'POST', headers: { Authorization: 'Bearer secret-key', 'Content-Type': 'application/json' } });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ reference: 'DLV-26-1', recipient: { name: 'Wanjiru', phone: '254711000000' }, destination: 'Westlands, Nairobi', parcels: 1 });
  });
  it('uses the mapping and header that were set, and drops links that are not https', async () => {
    const a = adapter(reply(200, { data: { waybill: 'W9', pdf: 'http://x.co.ke/l.pdf' } }), { authHeader: 'X-Api-Key', mapping: { tracking: 'data.waybill', label: 'data.pdf' } });
    expect(await a.book(request)).toMatchObject({ trackingNumber: 'W9', labelUrl: null });
  });
  it('says so when a booking has no tracking number, and does not retry what the courier refused', async () => {
    await expect(adapter(reply(200, {})).book(request)).rejects.toMatchObject({ name: 'CourierError', retryable: false });
    await expect(adapter(reply(422, { error: 'bad phone, key=secret-key' })).book(request)).rejects.toSatisfy((e: unknown) => e instanceof CourierError && !e.retryable && !e.message.includes('secret-key') && !e.message.includes('bad phone'));
  });
  it('treats a busy or down courier, a timeout and a name that will not resolve as worth trying again', async () => {
    for (const status of [429, 500, 503]) await expect(adapter(reply(status, '')).book(request)).rejects.toMatchObject({ retryable: true });
    const broken: Fetcher = () => Promise.reject(new Error('socket hang up at 10.0.0.9 with key secret-key'));
    await expect(adapter(broken).book(request)).rejects.toSatisfy((e: unknown) => e instanceof CourierError && e.retryable && !e.message.includes('secret-key') && !e.message.includes('10.0.0.9'));
    await expect(adapter(reply(200, {}), {}, () => Promise.reject(new Error('ENOTFOUND'))).book(request)).rejects.toMatchObject({ retryable: true });
  });
  it('will not call a name that points inside our network, nor follow the answer if it is not JSON', async () => {
    await expect(adapter(reply(200, {}), {}, () => Promise.resolve(['10.0.0.8'])).book(request)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('public internet') as string });
    await expect(adapter(reply(200, '<html>nope</html>')).book(request)).rejects.toMatchObject({ retryable: false });
  });
  it('asks for news by tracking number, encoded, and maps the courier\'s word, with proof of delivery', async () => {
    const seen: Seen[] = [];
    const a = adapter(reply(200, { status: 'DELIVERED', received_by: 'Mama Wanjiku', proof_url: 'https://swift.co.ke/pod/1.jpg', at: '2026-11-08T09:30:00Z' }, seen));
    expect(await a.track('SW 42')).toEqual({ state: 'delivered', note: null, at: new Date('2026-11-08T09:30:00Z'), receivedBy: 'Mama Wanjiku', proofUrl: 'https://swift.co.ke/pod/1.jpg', trackingNumber: null });
    expect(seen[0]?.url).toBe('https://api.swift.co.ke/shipments/SW%2042');
    expect(await adapter(reply(200, { status: 'on the moon' })).track('SW42')).toBeNull();
    expect(await adapter(reply(200, '')).track('SW42')).toBeNull();
  });
  it('cancels with the method that was set, and counts a parcel the courier no longer knows as cancelled', async () => {
    const seen: Seen[] = [];
    await adapter(reply(204, '', seen)).cancel('SW42');
    await adapter(reply(200, {}, seen), { cancelMethod: 'POST', cancelPath: '/shipments/{tracking}/cancel' }).cancel('SW42');
    await adapter(reply(404, '', seen)).cancel('SW42');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['DELETE https://api.swift.co.ke/shipments/SW42', 'POST https://api.swift.co.ke/shipments/SW42/cancel', 'DELETE https://api.swift.co.ke/shipments/SW42']);
    await expect(adapter(reply(409, '')).cancel('SW42')).rejects.toMatchObject({ retryable: false });
  });
  it('reads what the courier pushes, with an id for it, and ignores what is not news', () => {
    const a = adapter(reply(200, {}));
    const body = JSON.stringify({ tracking_number: 'SW42', status: 'picked_up', event_id: 'e-7', note: 'Left the depot' });
    expect(a.parseWebhook(body)).toEqual({ trackingNumber: 'SW42', eventId: 'e-7', news: expect.objectContaining({ state: 'in_transit', note: 'Left the depot' }) as unknown });
    const noId = a.parseWebhook(JSON.stringify({ tracking_number: 'SW42', status: 'delivered' }));
    expect(noId?.eventId).toHaveLength(40);
    expect(a.parseWebhook(JSON.stringify({ tracking_number: 'SW42', status: 'weird' }))).toBeNull();
    expect(a.parseWebhook(JSON.stringify({ status: 'delivered' }))).toBeNull();
    expect(a.parseWebhook('nonsense')).toBeNull();
    expect(DEFAULT_MAPPING.eventId).toBe('event_id');
  });
  it('checks the signature a courier sends with what it pushes', () => {
    const body = '{"a":1}';
    const good = createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(signatureValid('s3cret', body, good)).toBe(true);
    expect(signatureValid('s3cret', body, `sha256=${good.toUpperCase()}`)).toBe(true);
    expect(signatureValid('s3cret', `${body} `, good)).toBe(false);
    expect(signatureValid('other', body, good)).toBe(false);
    expect(signatureValid('s3cret', body, null)).toBe(false);
    expect(signatureValid('s3cret', body, 'short')).toBe(false);
  });
});
