import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MpesaDarajaAdapter } from './mpesa-daraja.adapter';
import { PesapalV3Adapter } from './pesapal-v3.adapter';

const creds = { consumerKey: 'key', consumerSecret: 'secret', shortcode: '174379', passkey: 'p' };

describe('Test connection', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('Daraja: ok when Safaricom issues a token, and it always asks afresh', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'abc', expires_in: '3599' }), { status: 200 })),
    );
    const a = new MpesaDarajaAdapter();
    expect(await a.testConnection(creds, {}, 'https://sandbox.safaricom.co.ke')).toEqual({ ok: true, message: 'Signed in to M-Pesa (Daraja) successfully.' });
    await a.testConnection(creds, {}, 'https://sandbox.safaricom.co.ke');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // not served from the token cache
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${Buffer.from('key:secret').toString('base64')}` });
  });

  it('Daraja: reports the failure in words and never echoes the secret', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() => Promise.resolve(new Response('Invalid Credentials', { status: 400 })));
    const r = await new MpesaDarajaAdapter().testConnection({ ...creds, consumerSecret: 'TOPSECRETVALUE' }, {}, 'https://sandbox.safaricom.co.ke');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('400');
    expect(r.message).not.toContain('TOPSECRETVALUE');
  });

  it('says what is missing instead of calling out with empty credentials', async () => {
    const r = await new PesapalV3Adapter().testConnection({}, {}, 'https://cybqa.pesapal.com/pesapalv3');
    expect(r).toEqual({ ok: false, message: 'The consumer key and secret are not saved yet.' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('turns a network failure into a message', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('getaddrinfo ENOTFOUND sandbox.safaricom.co.ke'));
    const r = await new MpesaDarajaAdapter().testConnection(creds, {}, 'https://sandbox.safaricom.co.ke');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ENOTFOUND');
  });
});
