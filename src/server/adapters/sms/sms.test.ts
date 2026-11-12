import { describe, expect, it, vi } from 'vitest';
import type { SmsSendError } from '@/server/ports/sms';
import { AfricasTalkingSms } from './africastalking';
import { TwilioSms } from './twilio';
import { smsAdapter } from './registry';

const reply = (status: number, body: unknown) => vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(JSON.stringify(body), { status })));
const message = { to: '+254712345678', text: 'Hello' };

describe("Africa's Talking", () => {
  const ok = { SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'ATXid_1' }] } };
  it('posts the message with the key in the header, and reads the message id', async () => {
    const fetchFn = reply(201, ok);
    const sent = await new AfricasTalkingSms({ username: 'shop', senderId: 'SHOP' }, 'KEY-123', fetchFn).send(message);
    expect(sent).toEqual({ providerMessageId: 'ATXid_1' });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.africastalking.com/version1/messaging');
    expect((init?.headers as Record<string, string>).apiKey).toBe('KEY-123');
    const form = new URLSearchParams(init?.body as string);
    expect(Object.fromEntries(form)).toEqual({ username: 'shop', to: '+254712345678', message: 'Hello', from: 'SHOP' });
  });
  it('uses the sandbox for the sandbox username and leaves out an empty sender', async () => {
    const fetchFn = reply(201, ok);
    await new AfricasTalkingSms({ username: 'sandbox' }, 'KEY-123', fetchFn).send(message);
    expect(fetchFn.mock.calls[0]?.[0]).toContain('sandbox');
    expect(new URLSearchParams(fetchFn.mock.calls[0]?.[1]?.body as string).has('from')).toBe(false);
  });
  it('tells a refusal in plain words, with whether trying again can help, and never repeats the provider\'s text', async () => {
    const no = (code: number) => new AfricasTalkingSms({ username: 'shop' }, 'KEY-123', reply(201, { SMSMessageData: { Recipients: [{ statusCode: code, status: 'SECRET-PROVIDER-TEXT' }] } })).send(message);
    await expect(no(405)).rejects.toMatchObject({ retry: false, message: expect.stringContaining('balance') as string });
    await expect(no(403)).rejects.toMatchObject({ retry: false });
    await expect(no(500)).rejects.toMatchObject({ retry: true });
    await expect(no(999)).rejects.toMatchObject({ retry: false, message: 'The provider refused the message.' });
    await no(405).catch((e: unknown) => expect((e as SmsSendError).message).not.toContain('SECRET'));
  });
  it('reads the HTTP status when there is no answer to read', async () => {
    const at = (s: number) => new AfricasTalkingSms({ username: 'shop' }, 'KEY-123', reply(s, {})).send(message);
    await expect(at(401)).rejects.toMatchObject({ retry: false, message: expect.stringContaining('credentials') as string });
    await expect(at(429)).rejects.toMatchObject({ retry: true });
    await expect(at(503)).rejects.toMatchObject({ retry: true });
    await expect(at(200)).rejects.toMatchObject({ retry: false });
  });
  it('treats an unreachable provider as worth trying again', async () => {
    const down = vi.fn(() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1')));
    await expect(new AfricasTalkingSms({ username: 'shop' }, 'KEY-123', down).send(message)).rejects.toMatchObject({ retry: true, message: expect.not.stringContaining('ECONN') as string });
  });
});

describe('Twilio', () => {
  const settings = { accountSid: `AC${'a'.repeat(32)}`, from: '+254700000000' };
  it('posts with basic auth and reads the sid', async () => {
    const fetchFn = reply(201, { sid: 'SM123', status: 'queued' });
    expect(await new TwilioSms(settings, 'tok', fetchFn).send(message)).toEqual({ providerMessageId: 'SM123' });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${settings.accountSid}:tok`).toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({ To: '+254712345678', Body: 'Hello', From: '+254700000000' });
  });
  it('sends from a messaging service when that is what was saved', async () => {
    const fetchFn = reply(201, { sid: 'SM1' });
    await new TwilioSms({ ...settings, from: `MG${'b'.repeat(32)}` }, 'tok', fetchFn).send(message);
    const form = new URLSearchParams(fetchFn.mock.calls[0]?.[1]?.body as string);
    expect(form.get('MessagingServiceSid')).toBe(`MG${'b'.repeat(32)}`);
    expect(form.has('From')).toBe(false);
  });
  it('tells refusals in plain words', async () => {
    const at = (s: number, code?: number) => new TwilioSms(settings, 'tok', reply(s, { code, message: 'SECRET-PROVIDER-TEXT' })).send(message);
    await expect(at(400, 21211)).rejects.toMatchObject({ retry: false, message: expect.stringContaining('valid phone number') as string });
    await expect(at(400, 21608)).rejects.toMatchObject({ message: expect.stringContaining('trial') as string });
    await expect(at(401)).rejects.toMatchObject({ message: expect.stringContaining('credentials') as string });
    await expect(at(500)).rejects.toMatchObject({ retry: true });
    await at(400, 12345).catch((e: unknown) => expect((e as SmsSendError).message).not.toContain('SECRET'));
  });
});

describe('choosing the adapter', () => {
  it('builds each provider, and refuses a half-set account', () => {
    expect(smsAdapter('log', {}, {})).not.toBeNull();
    expect(smsAdapter('africastalking', { username: 'shop' }, { apiKey: 'k'.repeat(20) })).not.toBeNull();
    expect(smsAdapter('africastalking', { username: 'shop' }, {})).toBeNull();
    expect(smsAdapter('twilio', { accountSid: 'AC', from: '+1' }, { authToken: 't' })).not.toBeNull();
    expect(smsAdapter('twilio', { accountSid: 'AC' }, { authToken: 't' })).toBeNull();
  });
});
