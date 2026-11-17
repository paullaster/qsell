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

  it('reads the delivery time the shopper chose, takes none as none, and refuses one that is not a slot and a day', () => {
    const slotId = '0ad80fea-d977-49bc-ac49-970a70e974f7';
    expect(parse(delivery({ slot: { slotId, day: '2026-11-09' } }))).toMatchObject({ ok: true, value: { delivery: { slot: { slotId, day: '2026-11-09' } } } });
    expect(parse(delivery())).toMatchObject({ ok: true, value: { delivery: { slot: null } } });
    expect(parse(delivery({ slot: null }))).toMatchObject({ ok: true, value: { delivery: { slot: null } } });
    for (const bad of [{ slotId: 'nope', day: '2026-11-09' }, { slotId, day: 'tomorrow' }, { slotId }, 'morning', 7]) {
      expect(parse(delivery({ slot: bad }))).toMatchObject({ ok: false, error: expect.stringContaining('delivery time') as string });
    }
  });

  it('does not make a recipient of a blank name', () => {
    expect(parse(delivery({ recipient: { name: '  ', phone: '' } }))).toMatchObject({ ok: true, value: { delivery: { recipient: null } } });
  });
});

describe('collecting an order from a branch', () => {
  const noAddress = { street: '', city: '', countyOrState: '', country: 'Kenya' };
  const collect = (d: Record<string, unknown>, address: unknown = noAddress) => parseCheckoutInput({ ...good(), shippingAddress: address, delivery: { method: 'pickup', ...d } });

  it('needs a branch and no address, and asks for nothing else about a place', () => {
    const r = collect({ pickupBranchId: ' branch-1 ', expectedCharge: 0 });
    expect(r).toMatchObject({ ok: true, value: { delivery: { method: 'pickup', pickupBranchId: 'branch-1', pin: null, address: null, recipient: null, notes: null, expectedCharge: 0 } } });
  });

  it('ignores a pin, an address, a recipient and a rider’s note sent with it', () => {
    const r = collect({ pickupBranchId: 'b', pin: { latitude: 1, longitude: 1 }, address: { county: 'X', town: 'Y', area: 'Z' }, recipient: { name: 'A', phone: '0722222222' }, notes: 'gate' });
    expect(r).toMatchObject({ ok: true, value: { delivery: { pin: null, address: null, recipient: null, notes: null } } });
  });

  it('is refused without a branch, or with one that is not text or is far too long, in words', () => {
    for (const bad of [{}, { pickupBranchId: '' }, { pickupBranchId: '   ' }, { pickupBranchId: 5 }, { pickupBranchId: 'x'.repeat(101) }]) {
      expect(collect(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: expect.stringContaining('Choose the branch') as string });
    }
  });

  it('refuses an amount that is not one, as a delivery does', () => {
    expect(collect({ pickupBranchId: 'b', expectedCharge: -1 })).toMatchObject({ ok: false });
    expect(collect({ pickupBranchId: 'b', expectedCharge: 'free' })).toMatchObject({ ok: false });
  });

  it('is the only kind of order that may leave the address empty', () => {
    const delivered = parseCheckoutInput({ ...good(), shippingAddress: noAddress, delivery: { method: 'own_fleet', pin: { latitude: -1.2, longitude: 36.8 } } });
    expect(delivered).toMatchObject({ ok: false, error: expect.stringContaining('delivery address') as string });
    expect(parseCheckoutInput({ ...good(), shippingAddress: noAddress })).toMatchObject({ ok: false });
  });

  it('leaves a delivery’s own reading as it was, with no branch', () => {
    const r = parseCheckoutInput({ ...good(), delivery: { method: 'own_fleet', pin: { latitude: -1.2921, longitude: 36.8219 }, pickupBranchId: 'ignored' } });
    expect(r).toMatchObject({ ok: true, value: { delivery: { method: 'own_fleet', pickupBranchId: null } } });
  });
});


describe('promo codes', () => {
  it('are capitals, short, up to five, and none twice', async () => {
    const { parseCouponCodes } = await import('./checkout-input');
    expect(parseCouponCodes(undefined)).toEqual({ ok: true, value: [] });
    expect(parseCouponCodes([' save10 ', 'SAVE10', '', 'eid'])).toEqual({ ok: true, value: ['SAVE10', 'EID'] });
    expect(parseCouponCodes(['a', 'b', 'c', 'd', 'e', 'f']).ok).toBe(false);
    expect(parseCouponCodes(['x'.repeat(41)]).ok).toBe(false);
    expect(parseCouponCodes('SAVE').ok).toBe(false);
  });
});

describe('package lines in the cart', () => {
  const picks = [{ slotId: 's', optionId: 'o', count: 1 }];
  it('keeps each package line on its own, with its choices, and merges only plain lines', () => {
    const result = parseCheckoutInput({
      ...good(),
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'p1', quantity: 2 },
        { productId: 'lunch', quantity: 2, package: { picks } },
        { productId: 'lunch', quantity: 1, package: { picks } },
      ],
    });
    expect(result.ok && result.value.items).toEqual([
      { productId: 'p1', quantity: 3 },
      { productId: 'lunch', quantity: 2, package: { picks } },
      { productId: 'lunch', quantity: 1, package: { picks } },
    ]);
  });
  it('refuses a package line whose choices cannot be read, and servings that are not whole', () => {
    expect(parseCheckoutInput({ ...good(), items: [{ productId: 'lunch', quantity: 1, package: 'x' }] }).ok).toBe(false);
    expect(parseCheckoutInput({ ...good(), items: [{ productId: 'lunch', quantity: 1.5, package: { picks } }] }).ok).toBe(false);
  });
});
