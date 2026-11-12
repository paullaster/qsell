import { describe, expect, it } from 'vitest';
import { SMS_PROVIDERS, SMS_PROVIDER_IDS, checkProvider, internationalPhone, isSmsProviderId, maskedPhone } from './sms-providers';

describe('the providers', () => {
  it('each has a name, and a secret is never one of the shown fields', () => {
    for (const id of SMS_PROVIDER_IDS) {
      expect(SMS_PROVIDERS[id].name.length).toBeGreaterThan(2);
      for (const f of SMS_PROVIDERS[id].fields) expect(f.maxLength).toBeGreaterThan(0);
    }
    expect(isSmsProviderId('twilio')).toBe(true);
    expect(isSmsProviderId('nexmo')).toBe(false);
    expect(isSmsProviderId(null)).toBe(false);
  });
});

describe('reading a provider form', () => {
  const at = { username: 'yourshop', apiKey: 'a'.repeat(40), senderId: 'YOURSHOP' };
  it('splits plain settings from secrets', () => {
    expect(checkProvider('africastalking', at, { keepSecrets: false })).toEqual({ ok: true, settings: { username: 'yourshop', senderId: 'YOURSHOP' }, secrets: { apiKey: 'a'.repeat(40) } });
  });
  it('needs every required field on a new account, but not the secret on a change', () => {
    expect(checkProvider('africastalking', { ...at, apiKey: '' }, { keepSecrets: false })).toMatchObject({ ok: false, error: expect.stringContaining('API key') as string });
    expect(checkProvider('africastalking', { ...at, apiKey: '' }, { keepSecrets: true })).toMatchObject({ ok: true, secrets: {} });
    expect(checkProvider('africastalking', { ...at, username: '' }, { keepSecrets: true })).toMatchObject({ ok: false });
  });
  it('lets the sender name be left out, and refuses a bad one', () => {
    expect(checkProvider('africastalking', { ...at, senderId: '' }, { keepSecrets: false })).toMatchObject({ ok: true });
    expect(checkProvider('africastalking', { ...at, senderId: 'two words' }, { keepSecrets: false })).toMatchObject({ ok: false });
    expect(checkProvider('africastalking', { ...at, senderId: 'AB' }, { keepSecrets: false })).toMatchObject({ ok: false });
  });
  it('checks Twilio\'s account, token and sender', () => {
    const t = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), from: '+254700000000' };
    expect(checkProvider('twilio', t, { keepSecrets: false })).toMatchObject({ ok: true, secrets: { authToken: 'b'.repeat(32) } });
    expect(checkProvider('twilio', { ...t, from: `MG${'c'.repeat(32)}` }, { keepSecrets: false })).toMatchObject({ ok: true });
    for (const bad of [{ accountSid: 'XY123' }, { from: '0700000000' }, { authToken: 'short' }, { from: 'x\ny' }]) expect(checkProvider('twilio', { ...t, ...bad }, { keepSecrets: false }).ok).toBe(false);
  });
  it('takes nothing for the log provider and ignores fields it does not know', () => {
    expect(checkProvider('log', { apiKey: 'x', other: 'y' }, { keepSecrets: false })).toEqual({ ok: true, settings: {}, secrets: {} });
    expect(checkProvider('twilio', { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), from: '+254700000000', evil: 'x' }, { keepSecrets: false })).toMatchObject({ ok: true, settings: { accountSid: `AC${'a'.repeat(32)}`, from: '+254700000000' } });
  });
  it('refuses a value that is too long or is not a string', () => {
    expect(checkProvider('africastalking', { ...at, username: 'u'.repeat(60) }, { keepSecrets: false }).ok).toBe(false);
    expect(checkProvider('africastalking', { ...at, username: 5 }, { keepSecrets: false }).ok).toBe(false);
  });
});

describe('phone numbers', () => {
  it('writes Kenyan numbers with the country code however they were typed', () => {
    for (const raw of ['0712 345 678', '0712345678', '+254712345678', '254712345678', '712345678', '(0712) 345-678', '00254712345678', '0112345678']) expect(internationalPhone(raw)).toMatch(/^\+254[17]\d{8}$/);
    expect(internationalPhone('0712345678')).toBe('+254712345678');
    expect(internationalPhone('+447911123456')).toBe('+447911123456');
  });
  it('refuses what cannot be a mobile number', () => {
    for (const bad of ['', 'abc', '071234', '+2547', '07123456789012', '+254212345678', null, 5, '0712 345 67a']) expect(internationalPhone(bad)).toBeNull();
  });
  it('hides the middle of a number', () => {
    expect(maskedPhone('+254712345678')).toBe('+254***678');
    expect(maskedPhone('+254712345678')).not.toContain('7123');
  });
});
