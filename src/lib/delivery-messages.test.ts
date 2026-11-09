import { describe, expect, it } from 'vitest';
import { isMessageKind, kindForStep, messageContent, messageKey, reasonForCustomer, MESSAGE_KINDS, type MessageFacts } from './delivery-messages';

const facts: MessageFacts = { tradingName: 'Test Traders', firstName: 'Wanjiru', orderNumber: 'ORD-77', deliveryNumber: 'DLV-26-0000000007', trackUrl: 'https://shop.example.test/track/abc', courierName: null, receivedBy: null,
  handoverCode: null, reasonCode: null, triesLeft: null };

describe('which step sends which message', () => {
  it('sends one for going out, arriving (whole or in part), a failed attempt and a return, and none for the quiet steps', () => {
    expect(kindForStep('dispatch', false)).toBe('out_for_delivery');
    expect(kindForStep('deliver', true)).toBe('delivered');
    expect(kindForStep('deliver', false)).toBe('part_delivered');
    expect(kindForStep('fail_attempt', false)).toBe('attempt_failed');
    expect(kindForStep('return', false)).toBe('returned');
    for (const quiet of ['release', 'start_picking', 'record_picked', 'mark_packed', 'mark_ready', 'reattempt', 'cancel'] as const) expect(kindForStep(quiet, true)).toBeNull();
  });
  it('knows its kinds, and gives one key to one thing that happened', () => {
    expect(MESSAGE_KINDS.every(isMessageKind)).toBe(true);
    expect(isMessageKind('promo')).toBe(false);
    expect(messageKey('d1', 'attempt_failed', 2)).toBe('d1:attempt_failed:2');
    expect(messageKey('d1', 'attempt_failed', 2)).toBe(messageKey('d1', 'attempt_failed', 2));
    expect(messageKey('d1', 'attempt_failed', 1)).not.toBe(messageKey('d1', 'attempt_failed', 2));
  });
});

describe('the words', () => {
  it('names the shop, greets the customer by first name, and carries the order and delivery numbers', () => {
    const m = messageContent('out_for_delivery', facts);
    expect(m.subject).toContain('ORD-77');
    expect(m.subject).toContain('Test Traders');
    expect(m.greeting).toBe('Hello Wanjiru,');
    expect(m.details).toEqual([['Order', 'ORD-77'], ['Delivery', 'DLV-26-0000000007']]);
    expect(messageContent('out_for_delivery', { ...facts, firstName: '' }).greeting).toBe('Hello,');
    expect(messageContent('out_for_delivery', { ...facts, tradingName: '' }).subject).toContain('the shop');
  });
  it('names the courier on the way out, and who received it on arrival', () => {
    expect(messageContent('out_for_delivery', { ...facts, courierName: 'Swift Couriers' }).details).toContainEqual(['Courier', 'Swift Couriers']);
    expect(messageContent('delivered', { ...facts, receivedBy: 'Mama Wanjiku' }).body).toContain('Mama Wanjiku');
    expect(messageContent('part_delivered', facts).body).toContain('The rest will follow');
  });
  it('says why a delivery failed in the customer’s words, and whether it will be tried again', () => {
    expect(messageContent('attempt_failed', { ...facts, reasonCode: 'customer_absent', triesLeft: 2 }).body).toContain('nobody was there to receive it');
    expect(messageContent('attempt_failed', { ...facts, reasonCode: 'customer_absent', triesLeft: 2 }).body).toContain('try again');
    expect(messageContent('attempt_failed', { ...facts, reasonCode: 'wrong_address', triesLeft: 0 }).body).toContain('contact us');
    expect(reasonForCustomer('something_new')).toBe('something prevented the delivery');
    expect(reasonForCustomer(null)).toBe('something prevented the delivery');
  });
  it('tells the customer their chosen time could not be kept, without promising a time it cannot give', () => {
    const m = messageContent('slot_not_kept', facts);
    expect(m.heading).toContain('could not keep the delivery time');
    expect(m.body).toContain('still going ahead');
    expect(m.body).toContain('be in touch');
    expect(m.details).toContainEqual(['Order', facts.orderNumber]);
  });
  it('never carries an address, a phone number or a payment detail', () => {
    const everything = MESSAGE_KINDS.map((k) => JSON.stringify(messageContent(k, { ...facts, courierName: 'Swift', receivedBy: 'Gate guard', reasonCode: 'refused', triesLeft: 1 }))).join(' ');
    expect(everything).not.toMatch(/\b0[17]\d{8}\b|\+254|street|road|mpesa|card/i);
  });
});

describe('the delivery code', () => {
  it('is in the "on its way" message when there is one, and asks for it to be given only to the rider', () => {
    const m = messageContent('out_for_delivery', { ...facts, handoverCode: '048213' });
    expect(m.details).toContainEqual(['Delivery code', '048213']);
    expect(m.body).toContain('delivery code');
  });

  it('is not in the message when the company does not ask for one', () => {
    const m = messageContent('out_for_delivery', facts);
    expect(m.details.some(([k]) => k === 'Delivery code')).toBe(false);
    expect(m.body).not.toContain('delivery code');
  });
});
