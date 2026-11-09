import { describe, expect, it } from 'vitest';
import { orderEmailContent, usableEmail, type OrderEmailFacts } from './order-emails';

const facts: OrderEmailFacts = { tradingName: 'Acme', customerName: 'Amina Wanjiru', orderNumber: 'SO-26-000001', lines: [{ name: 'Tea', quantity: '2', amount: 'KES 200.00' }], subtotal: 'KES 200.00', tax: 'KES 0.00', shipping: 'KES 150.00', total: 'KES 350.00', paymentWords: 'M-Pesa', reference: 'QWE123', payLater: null, trackUrl: 'https://x.test/track/t' };

describe('order emails', () => {
  it('says the order is held and confirmed on payment when it is to be paid now', () => {
    const c = orderEmailContent('placed', facts);
    expect(c.subject).toBe('We have your order SO-26-000001');
    expect(c.greeting).toBe('Hello Amina,');
    expect(c.body).toContain('confirmed when your payment is received');
    expect(c.details).toContainEqual(['2 × Tea', 'KES 200.00']);
    expect(c.details.at(-1)).toEqual(['Total', 'KES 350.00']);
  });
  it('says what is due for an order on account or to be paid at the door', () => {
    expect(orderEmailContent('placed', { ...facts, payLater: 'door' }).body).toContain('You pay when it arrives');
    expect(orderEmailContent('placed', { ...facts, payLater: 'account' }).body).toContain('added to your account');
  });
  it('confirms the payment with its reference', () => {
    const c = orderEmailContent('paid', facts);
    expect(c.subject).toBe('Payment received for order SO-26-000001');
    expect(c.details).toContainEqual(['Payment reference', 'QWE123']);
  });
  it('leaves out delivery and the reference when there are none, and greets without a name', () => {
    const c = orderEmailContent('paid', { ...facts, shipping: null, reference: null, customerName: '' });
    expect(c.greeting).toBe('Hello,');
    expect(c.details.some(([k]) => k === 'Delivery' || k === 'Payment reference')).toBe(false);
  });
  it('writes only to an address that can be right', () => {
    expect(usableEmail(' A@B.co ')).toBe('a@b.co');
    expect(usableEmail('')).toBeNull();
    expect(usableEmail('nope')).toBeNull();
  });
});
