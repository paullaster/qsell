import { describe, expect, it } from 'vitest';
import { parseCheckoutInput } from './checkout-input';

const good = () => ({
  customerName: ' Amina ',
  customerEmail: '',
  customerPhone: '0712345678',
  shippingAddress: { street: '1 Moi Ave', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
  items: [{ productId: 'p1', quantity: 2 }],
  paymentMethod: 'mpesa_daraja',
});

describe('the number a payment is made from', () => {
  it('is the contact number, in 2547 form, when the customer pays from it', () => {
    expect(parseCheckoutInput(good())).toMatchObject({ ok: true, value: { customerPhone: '0712345678', paymentPhone: '254712345678' } });
  });

  it('is left out for a method that does not use a phone, when none was chosen', () => {
    const result = parseCheckoutInput({ ...good(), paymentMethod: 'pesapal_v3' });
    expect(result.ok && 'paymentPhone' in result.value).toBe(false);
  });

  it('is the other number, in 2547 form, when the customer chose one', () => {
    expect(parseCheckoutInput({ ...good(), paymentPhone: '+254 722 222 222' })).toMatchObject({ ok: true, value: { customerPhone: '0712345678', paymentPhone: '254722222222' } });
  });

  it('is refused in words when a phone method gets something that is not a Kenyan mobile number', () => {
    expect(parseCheckoutInput({ ...good(), paymentPhone: '12345' })).toEqual({ ok: false, error: 'That is not a Kenyan mobile number. Enter the number to pay from, like 0712 345 678.' });
    const landline = parseCheckoutInput({ ...good(), customerPhone: '020 123 4567' });
    expect(!landline.ok && landline.error).toContain('Your contact number is not a Kenyan mobile number');
  });

  it('does not stop an order paid another way (card, on account) for a landline contact number', () => {
    expect(parseCheckoutInput({ ...good(), customerPhone: '020 123 4567', paymentMethod: 'pesapal_v3' })).toMatchObject({ ok: true });
    expect(parseCheckoutInput({ ...good(), customerPhone: '020 123 4567', paymentMethod: 'on_account' })).toMatchObject({ ok: true });
  });

  it('ignores a paymentPhone that is not text or is absurdly long', () => {
    expect(parseCheckoutInput({ ...good(), paymentPhone: 42 })).toMatchObject({ ok: true });
    expect(parseCheckoutInput({ ...good(), paymentPhone: '7'.repeat(80) })).toMatchObject({ ok: true });
  });
});

describe('parseCheckoutInput', () => {
  it('reads a complete guest checkout and trims it', () => {
    const result = parseCheckoutInput(good());
    expect(result).toMatchObject({ ok: true, value: { customerName: 'Amina', customerEmail: '', items: [{ productId: 'p1', quantity: 2 }] } });
  });

  it('merges the same product listed twice', () => {
    const result = parseCheckoutInput({ ...good(), items: [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 2.5 }] });
    expect(result).toMatchObject({ ok: true, value: { items: [{ productId: 'p1', quantity: 3.5 }] } });
  });

  it.each([
    ['not an object', 'x', /could not be read/],
    ['no name', { ...good(), customerName: ' ' }, /name/],
    ['no phone', { ...good(), customerPhone: 7 }, /phone/],
    ['no street', { ...good(), shippingAddress: { ...good().shippingAddress, street: '' } }, /address/],
    ['no address at all', { ...good(), shippingAddress: null }, /address/],
    ['unknown payment', { ...good(), paymentMethod: 'cash' }, /how you will pay/],
    ['empty cart', { ...good(), items: [] }, /empty/],
    ['zero quantity', { ...good(), items: [{ productId: 'p1', quantity: 0 }] }, /quantities/],
    ['bad quantity type', { ...good(), items: [{ productId: 'p1', quantity: '2' }] }, /quantities/],
    ['negative quantity', { ...good(), items: [{ productId: 'p1', quantity: -1 }] }, /quantities/],
    ['no product id', { ...good(), items: [{ quantity: 1 }] }, /cart/],
  ])('refuses %s', (_name, input, message) => {
    const result = parseCheckoutInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it('refuses absurdly long text and too many lines', () => {
    expect(parseCheckoutInput({ ...good(), customerName: 'a'.repeat(500) }).ok).toBe(false);
    expect(parseCheckoutInput({ ...good(), items: Array.from({ length: 101 }, (_, i) => ({ productId: `p${String(i)}`, quantity: 1 })) }).ok).toBe(false);
  });
});

describe('the delivery part of a checkout', () => {
  const delivery = (over: Record<string, unknown> = {}) => ({ method: 'own_fleet', pin: { latitude: -1.2921, longitude: 36.8219 }, address: { county: 'Nairobi', town: 'Nairobi', area: 'Westlands' }, ...over });
  const parse = (d: unknown) => parseCheckoutInput({ ...good(), delivery: d });

  it('is absent for an order without delivery, so such a checkout is read exactly as before', () => {
    const r = parseCheckoutInput(good());
    expect(r.ok && 'delivery' in r.value).toBe(false);
  });

  it('reads a pin, a written area, who receives it, the note and the charge the shopper saw', () => {
    const r = parse(delivery({ recipient: { name: ' Wanjiku ', phone: '0722 222 222' }, notes: ' Blue gate ', expectedCharge: 348 }));
    expect(r).toMatchObject({ ok: true, value: { delivery: { method: 'own_fleet', pin: { latitude: -1.2921, longitude: 36.8219 }, address: { county: 'Nairobi', town: 'Nairobi', area: 'Westlands' }, recipient: { name: 'Wanjiku', phone: '254722222222' }, notes: 'Blue gate', expectedCharge: 348 } } });
  });

  it('takes a written area alone, or a pin alone, but not neither', () => {
    expect(parse(delivery({ pin: null }))).toMatchObject({ ok: true, value: { delivery: { pin: null } } });
    expect(parse(delivery({ address: { county: ' ', town: '', area: null } }))).toMatchObject({ ok: true, value: { delivery: { address: null } } });
    expect(parse(delivery({ pin: undefined, address: undefined }))).toMatchObject({ ok: false, error: expect.stringContaining('Drop a pin') as string });
  });

  it('refuses what is not a place, a way of delivering, a phone number or an amount, in words', () => {
    expect(parse(delivery({ pin: { latitude: 120, longitude: 0 } }))).toMatchObject({ ok: false, error: expect.stringContaining('not a place') as string });
    expect(parse(delivery({ method: 'teleport' }))).toMatchObject({ ok: false, error: expect.stringContaining('how you want') as string });
    expect(parse(delivery({ recipient: { name: 'Wanjiku', phone: '12' } }))).toMatchObject({ ok: false, error: expect.stringContaining('mobile number') as string });
    expect(parse(delivery({ expectedCharge: -5 }))).toMatchObject({ ok: false });
    expect(parse(delivery({ expectedCharge: 'cheap' }))).toMatchObject({ ok: false });
    expect(parse(delivery({ notes: 'x'.repeat(301) }))).toMatchObject({ ok: false });
    expect(parse('nonsense')).toMatchObject({ ok: false });
  });

  it('does not make a recipient of a blank name', () => {
    expect(parse(delivery({ recipient: { name: '  ', phone: '' } }))).toMatchObject({ ok: true, value: { delivery: { recipient: null } } });
  });
});
