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
