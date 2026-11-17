import { describe, expect, it } from 'vitest';
import { lateAlert, readSubscription } from './delivery-push';
import { pushRuntimeConfig } from '@/server/adapters/push/config';

describe('what an alert says', () => {
  const window = { windowStart: new Date('2026-11-12T07:00:00Z'), windowEnd: new Date('2026-11-12T09:00:00Z') };
  it('names the delivery, the window and how late, in plain words', () => {
    const risk = lateAlert({ level: 'at_risk', number: 'DLV-12', ...window, minutesLate: 0 });
    expect(risk.title).toBe('Delivery DLV-12 is at risk');
    expect(risk.body).toContain('Not late yet');
    const late = lateAlert({ level: 'late', number: 'DLV-12', ...window, minutesLate: 25 });
    expect(late.title).toBe('Delivery DLV-12 is late');
    expect(late.body).toContain('Late by');
    expect(lateAlert({ level: 'escalated', number: 'DLV-12', ...window, minutesLate: 95 }).title).toBe('Delivery DLV-12 is late');
  });
  it('copes with no window and keeps to the size limits', () => {
    expect(lateAlert({ level: 'late', number: 'D'.repeat(200), windowStart: null, windowEnd: null, minutesLate: 5 }).title.length).toBeLessThanOrEqual(80);
    expect(lateAlert({ level: 'late', number: 'X', windowStart: null, windowEnd: null, minutesLate: 5 }).body).toContain('no window');
  });
});

describe('a browser\'s subscription', () => {
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  it('is accepted when it has an https address and both keys', () => {
    expect(readSubscription(good)).toEqual({ ok: true, value: good });
  });
  it('is refused otherwise', () => {
    for (const bad of [null, 'x', {}, { ...good, endpoint: 'http://push.test/x' }, { ...good, endpoint: 'https://x' }, { ...good, p256dh: 'short' }, { ...good, auth: 'not base64 !' }, { ...good, endpoint: `https://${'a'.repeat(3000)}` }, { ...good, auth: 5 }]) expect(readSubscription(bad).ok).toBe(false);
  });
});

describe('push settings of an installation', () => {
  const key = 'B'.repeat(87);
  it('is off when nothing is set', () => {
    expect(pushRuntimeConfig({})).toBeNull();
    expect(pushRuntimeConfig({ VAPID_PUBLIC_KEY: ' ', VAPID_PRIVATE_KEY: '' })).toBeNull();
  });
  it('is read when all three are set', () => {
    expect(pushRuntimeConfig({ VAPID_PUBLIC_KEY: key, VAPID_PRIVATE_KEY: 'c'.repeat(43), VAPID_SUBJECT: 'mailto:ops@shop.test' })).toMatchObject({ subject: 'mailto:ops@shop.test' });
    expect(pushRuntimeConfig({ VAPID_PUBLIC_KEY: key, VAPID_PRIVATE_KEY: 'c'.repeat(43), VAPID_SUBJECT: 'https://shop.test' })).not.toBeNull();
  });
  it('is an error, not a silent off, when half set or malformed', () => {
    expect(() => pushRuntimeConfig({ VAPID_PUBLIC_KEY: key })).toThrow(/together/);
    expect(() => pushRuntimeConfig({ VAPID_PUBLIC_KEY: 'short', VAPID_PRIVATE_KEY: 'c'.repeat(43), VAPID_SUBJECT: 'mailto:a@b.test' })).toThrow(/generated/);
    expect(() => pushRuntimeConfig({ VAPID_PUBLIC_KEY: key, VAPID_PRIVATE_KEY: 'c'.repeat(43), VAPID_SUBJECT: 'ops' })).toThrow(/mailto/);
  });
});
