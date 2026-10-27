import { describe, expect, it } from 'vitest';
import { maskedPhone, nationalPhone, sameMobile, toKenyanMsisdn } from './phone';
import { paymentUsesPhone, resolvePaymentPhone } from './payment-phone';

describe('Kenyan mobile numbers', () => {
  it('reads every way people write one', () => {
    for (const written of ['0712345678', '0712 345 678', '+254712345678', '254712345678', '712345678', '+254 (712) 345-678']) {
      expect(toKenyanMsisdn(written), written).toBe('254712345678');
    }
    expect(toKenyanMsisdn('0112345678')).toBe('254112345678');
  });

  it('refuses what cannot be one', () => {
    for (const written of ['', '  ', '0612345678', '07123456', '071234567890', '+255712345678', 'phone', null, undefined]) {
      expect(toKenyanMsisdn(written), String(written)).toBeNull();
    }
  });

  it('shows a number the way people read it, and hides the middle when asked', () => {
    expect(nationalPhone('+254712345678')).toBe('0712 345 678');
    expect(nationalPhone('not a number')).toBe('not a number');
    expect(maskedPhone('254712345678')).toBe('0712 ••• 678');
    expect(maskedPhone('nope')).toBe('');
  });

  it('knows two writings of one line', () => {
    expect(sameMobile('0712 345 678', '+254712345678')).toBe(true);
    expect(sameMobile('0712345678', '0722345678')).toBe(false);
    expect(sameMobile('', '')).toBe(false);
  });
});

describe('the number a payment is made from', () => {
  it('knows which methods use a phone', () => {
    expect((['mpesa_daraja', 'kcb_buni', 'jenga_hq'] as const).every((code) => paymentUsesPhone(code))).toBe(true);
    expect(paymentUsesPhone('pesapal_v3')).toBe(false);
    expect(paymentUsesPhone('on_account')).toBe(false);
  });

  it('uses the number the customer chose, else the contact number', () => {
    expect(resolvePaymentPhone({ method: 'mpesa_daraja', contactPhone: '0711111111', paymentPhone: '0722 222 222' })).toEqual({ ok: true, phone: '254722222222' });
    expect(resolvePaymentPhone({ method: 'mpesa_daraja', contactPhone: '0711 111 111' })).toEqual({ ok: true, phone: '254711111111' });
    expect(resolvePaymentPhone({ method: 'mpesa_daraja', contactPhone: '0711111111', paymentPhone: '  ' })).toEqual({ ok: true, phone: '254711111111' });
  });

  it('says in words why a number cannot be used for a phone payment', () => {
    const own = resolvePaymentPhone({ method: 'mpesa_daraja', contactPhone: '020 123 4567' });
    expect(own.ok).toBe(false);
    expect(!own.ok && own.error).toContain('Your contact number is not a Kenyan mobile number');
    const chosen = resolvePaymentPhone({ method: 'kcb_buni', contactPhone: '0711111111', paymentPhone: '12345' });
    expect(!chosen.ok && chosen.error).toMatch(/^That is not a Kenyan mobile number/);
  });

  it('keeps a valid number for other methods and ignores a bad one', () => {
    expect(resolvePaymentPhone({ method: 'pesapal_v3', contactPhone: 'abc', paymentPhone: '0722222222' })).toEqual({ ok: true, phone: '254722222222' });
    expect(resolvePaymentPhone({ method: 'pesapal_v3', contactPhone: 'abc', paymentPhone: 'zzz' })).toEqual({ ok: true, phone: null });
    expect(resolvePaymentPhone({ method: 'on_account', contactPhone: 'abc' })).toEqual({ ok: true, phone: null });
  });
});
