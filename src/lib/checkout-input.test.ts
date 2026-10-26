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
