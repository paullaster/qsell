import { beforeEach, describe, expect, it, vi } from 'vitest';

const startOrderPayment = vi.fn();
const createCheckout = vi.fn();
const hit = vi.fn();
const getById = vi.fn();
const headerGet = vi.fn((_name: string): string | null => null);

vi.mock('next/headers', () => ({ headers: () => Promise.resolve({ get: (name: string) => headerGet(name) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({}));
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/di/container', () => ({ getContainer: () => ({ rateLimits: { hit: (...a: unknown[]) => hit(...a) as unknown }, orders: { getById: (...a: unknown[]) => getById(...a) as unknown } }) }));
vi.mock('@/server/domains/payments/start-payment', () => ({ startOrderPayment: (...a: unknown[]) => startOrderPayment(...a) as unknown }));
vi.mock('./service', () => ({
  CheckoutRefused: class CheckoutRefused extends Error {},
  OrdersService: { createCheckout: (...a: unknown[]) => createCheckout(...a) as unknown },
}));

const actions = await import('./checkout-actions');

const form = (over: Record<string, unknown> = {}) => ({
  customerName: 'Amina',
  customerEmail: '',
  customerPhone: '0711 111 111',
  shippingAddress: { street: '1 Moi Ave', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' },
  items: [{ productId: 'p1', quantity: 1 }],
  paymentMethod: 'mpesa_daraja',
  ...over,
});

beforeEach(() => {
  for (const f of [startOrderPayment, createCheckout, hit, getById]) f.mockReset();
  hit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  createCheckout.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', customerPhone: '0711 111 111' });
  startOrderPayment.mockResolvedValue({ attemptId: 'a1', status: 'pending', customerMessage: 'Enter your PIN.' });
});

describe('placing an order paid by a phone prompt', () => {
  it('sends the prompt to the number the customer chose, not the contact number', async () => {
    const out = await actions.placeOrderAction(form({ paymentPhone: '0722 222 222' }));
    expect(out.ok).toBe(true);
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: '0711 111 111', paymentPhone: '254722222222' }));
    expect(startOrderPayment).toHaveBeenCalledWith({ orderId: 'o1', providerCode: 'mpesa_daraja', payerPhone: '254722222222' });
  });

  it('uses the contact number, in 2547 form, when none was chosen', async () => {
    await actions.placeOrderAction(form());
    expect(startOrderPayment).toHaveBeenCalledWith({ orderId: 'o1', providerCode: 'mpesa_daraja', payerPhone: '254711111111' });
  });

  it('limits prompts per address and per number, and places nothing when over the limit', async () => {
    headerGet.mockImplementation((name) => (name === 'x-real-ip' ? '41.1.1.1' : null));
    await actions.placeOrderAction(form({ paymentPhone: '0722222222' }));
    expect(hit).toHaveBeenCalledWith('payment_prompt_ip', '41.1.1.1');
    expect(hit).toHaveBeenCalledWith('payment_prompt_phone', '254722222222');
    hit.mockReset();
    hit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });
    createCheckout.mockClear();
    const out = await actions.placeOrderAction(form({ paymentPhone: '0722222222' }));
    expect(!out.ok && out.error).toMatch(/Too many attempts/);
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('refuses a number that is not a Kenyan mobile number before anything is reserved', async () => {
    const out = await actions.placeOrderAction(form({ paymentPhone: '12345' }));
    expect(out.ok).toBe(false);
    expect(createCheckout).not.toHaveBeenCalled();
    expect(startOrderPayment).not.toHaveBeenCalled();
  });

  it('sends no prompt number for a payment that does not use a phone', async () => {
    await actions.placeOrderAction(form({ paymentMethod: 'pesapal_v3', paymentPhone: '0722222222' }));
    expect(startOrderPayment).toHaveBeenCalledWith({ orderId: 'o1', providerCode: 'pesapal_v3', payerPhone: '254722222222' });
    expect(hit).not.toHaveBeenCalled();
  });
});

describe('trying a payment again', () => {
  const order = { id: 'o1', customerPhone: '0711 111 111', paymentPhone: '254711111111' };

  it('uses the number typed now, which replaces the earlier one', async () => {
    getById.mockResolvedValue(order);
    const out = await actions.retryPaymentAction({ orderId: 'o1', providerCode: 'mpesa_daraja', paymentPhone: '0733 333 333' });
    expect(out.ok).toBe(true);
    expect(startOrderPayment).toHaveBeenCalledWith({ orderId: 'o1', providerCode: 'mpesa_daraja', payerPhone: '254733333333' });
  });

  it('keeps the number the order was last paid from when none is typed', async () => {
    getById.mockResolvedValue({ ...order, paymentPhone: '254744444444' });
    await actions.retryPaymentAction({ orderId: 'o1', providerCode: 'mpesa_daraja' });
    expect(startOrderPayment).toHaveBeenCalledWith({ orderId: 'o1', providerCode: 'mpesa_daraja', payerPhone: '254744444444' });
  });

  it('refuses a bad number in words and a missing order, and is limited like the first try', async () => {
    getById.mockResolvedValue(order);
    expect(await actions.retryPaymentAction({ orderId: 'o1', providerCode: 'mpesa_daraja', paymentPhone: 'abc' })).toEqual({ ok: false, error: 'That is not a Kenyan mobile number. Enter the number to pay from, like 0712 345 678.' });
    getById.mockResolvedValue(null);
    expect(await actions.retryPaymentAction({ orderId: 'nope', providerCode: 'mpesa_daraja' })).toEqual({ ok: false, error: 'That order could not be found.' });
    getById.mockResolvedValue(order);
    hit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const limited = await actions.retryPaymentAction({ orderId: 'o1', providerCode: 'mpesa_daraja', paymentPhone: '0733333333' });
    expect(limited.ok).toBe(false);
    expect(startOrderPayment).not.toHaveBeenCalled();
  });

  it('does not let the browser name a number for the public start action', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync('src/server/domains/payments/actions.ts', 'utf8'));
    expect(source).not.toMatch(/payerPhone/);
  });
});
