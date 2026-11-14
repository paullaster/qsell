import { describe, expect, it } from 'vitest';
import { TEXT_KIND_CHOICES, isMessageKind, kindForStep, messageContent, messageKey, minutesToClock, quietEndsAt, readQuietHours, readTextKinds, reasonForCustomer, textContent, MESSAGE_KINDS, type MessageFacts } from './delivery-messages';

const facts: MessageFacts = { tradingName: 'Test Traders', firstName: 'Wanjiru', orderNumber: 'ORD-77', deliveryNumber: 'DLV-26-0000000007', trackUrl: 'https://shop.example.test/track/abc', courierName: null, receivedBy: null,
  handoverCode: null, reasonCode: null, triesLeft: null, collection: null };

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

describe('customer text messages', () => {
  const facts = { tradingName: 'Wanjiku Traders', firstName: 'Achieng', orderNumber: 'ORD-1001', deliveryNumber: 'DLV-55', trackUrl: 'https://shop.example/track/abcdef1234567890abcdef1234567890', courierName: null, receivedBy: 'Brian', handoverCode: '482913', reasonCode: 'customer_absent', triesLeft: 2, collection: null };
  it('says the state in a few words with the tracking link last, and the code only when it is on its way', () => {
    const way = textContent('out_for_delivery', facts);
    expect(way).toContain('on its way');
    expect(way).toContain('482913');
    expect(way.endsWith(facts.trackUrl)).toBe(true);
    expect(textContent('out_for_delivery', { ...facts, handoverCode: null })).not.toContain('code');
    for (const kind of MESSAGE_KINDS.filter((k) => k !== 'out_for_delivery')) expect(textContent(kind, facts)).not.toContain('482913');
    expect(textContent('delivered', facts)).toContain('received by Brian');
    expect(textContent('attempt_failed', facts)).toMatch(/nobody was there to receive it.*2 tries left/);
    expect(textContent('attempt_failed', { ...facts, triesLeft: 1 })).toContain('1 try left');
  });
  it('carries no address, phone number or payment, only what the email carries', () => {
    for (const kind of MESSAGE_KINDS) {
      const t = textContent(kind, facts);
      expect(t).not.toMatch(/\b0[17]\d{8}\b|\+254|KSh|street|road/i);
      expect(t.length).toBeLessThanOrEqual(306);
    }
  });
  it('shortens the shop name, then drops it, before the link or the facts are cut', () => {
    const long = textContent('attempt_failed', { ...facts, tradingName: 'A Very Long Trading Name Indeed '.repeat(8) });
    expect(long.length).toBeLessThanOrEqual(306);
    expect(long.endsWith(facts.trackUrl)).toBe(true);
    expect(long).toContain('ORD-1001');
    expect(textContent('delivered', { ...facts, firstName: '', tradingName: '' })).toMatch(/^Hello, your order ORD-1001 was delivered/);
  });
  it('reads the kinds ticked: known ones only, once each, in the usual order', () => {
    expect(readTextKinds(['delivered', 'out_for_delivery', 'delivered'])).toEqual({ ok: true, kinds: ['out_for_delivery', 'delivered'] });
    expect(readTextKinds([])).toEqual({ ok: true, kinds: [] });
    expect(readTextKinds(['nonsense']).ok).toBe(false);
    expect(readTextKinds('delivered').ok).toBe(false);
    expect(TEXT_KIND_CHOICES.map((c) => c.kind)).toEqual([...MESSAGE_KINDS]);
  });
});

describe('quiet hours for texts', () => {
  const night = { from: 21 * 60, until: 7 * 60 };
  const tz = 'Africa/Nairobi';
  it('reads two times, or none, and refuses half a pair or the same time twice', () => {
    expect(readQuietHours('21:00', '07:00')).toEqual({ ok: true, quiet: night });
    expect(readQuietHours('', '')).toEqual({ ok: true, quiet: null });
    expect(readQuietHours(null, undefined)).toEqual({ ok: true, quiet: null });
    expect(readQuietHours('21:00', '').ok).toBe(false);
    expect(readQuietHours('25:00', '07:00').ok).toBe(false);
    expect(readQuietHours('08:00', '08:00').ok).toBe(false);
    expect(minutesToClock(7 * 60 + 5)).toBe('07:05');
  });
  it('holds a night text until the morning, across midnight, in the business time', () => {
    // 22:30 in Nairobi is 19:30 UTC; the quiet hours end at 07:00 Nairobi, 04:00 UTC the next day.
    expect(quietEndsAt(new Date('2026-11-12T19:30:45Z'), night, tz)?.toISOString()).toBe('2026-11-13T04:00:00.000Z');
    // 02:00 in Nairobi is the same night, so it ends at 07:00 the same day.
    expect(quietEndsAt(new Date('2026-11-12T23:00:10Z'), night, tz)?.toISOString()).toBe('2026-11-13T04:00:00.000Z');
  });
  it('lets a daytime text go, and the very minute the quiet hours end', () => {
    expect(quietEndsAt(new Date('2026-11-12T09:00:00Z'), night, tz)).toBeNull();
    expect(quietEndsAt(new Date('2026-11-13T04:00:00Z'), night, tz)).toBeNull();
    expect(quietEndsAt(new Date('2026-11-12T09:00:00Z'), null, tz)).toBeNull();
  });
  it('handles quiet hours inside one day', () => {
    const lunch = { from: 12 * 60, until: 14 * 60 };
    expect(quietEndsAt(new Date('2026-11-12T09:30:00Z'), lunch, tz)?.toISOString()).toBe('2026-11-12T11:00:00.000Z');
    expect(quietEndsAt(new Date('2026-11-12T11:00:00Z'), lunch, tz)).toBeNull();
  });
});

describe('ready to collect', () => {
  const at = { ...facts, collection: { branchName: 'Westlands Branch', code: 'ABC-DEF' } };
  it('says a new code replaces the old one when the code was renewed, and says nothing of the sort the first time', () => {
    const renewed = { ...facts, collection: { branchName: 'Westlands Branch', code: 'XYZ-123', renewed: true } };
    const m = messageContent('ready_for_collection', renewed);
    expect(m.heading).toBe('Your new collection code');
    expect(m.body).toContain('no longer works');
    expect(m.details).toContainEqual(['Collection code', 'XYZ-123']);
    const t = textContent('ready_for_collection', renewed);
    expect(t).toMatch(/new collection code: XYZ-123\. The old one no longer works/);
    expect(t.endsWith(facts.trackUrl)).toBe(true);
    expect(messageContent('ready_for_collection', at).body).not.toContain('no longer works');
  });
  it('names the branch and carries the collection code in the mail and the text, and the text stays short with the link last', () => {
    const m = messageContent('ready_for_collection', at);
    expect(m.subject).toContain('ready to collect');
    expect(m.body).toContain('Westlands Branch');
    expect(m.details).toContainEqual(['Collection code', 'ABC-DEF']);
    expect(m.details.some(([k]) => k === 'Delivery')).toBe(false);
    const t = textContent('ready_for_collection', at);
    expect(t).toMatch(/ready to collect at Westlands Branch\. Show code ABC-DEF at the counter/);
    expect(t.endsWith(facts.trackUrl)).toBe(true);
    expect(t.length).toBeLessThanOrEqual(306);
    expect(textContent('ready_for_collection', { ...at, tradingName: 'A Very Long Trading Name Indeed '.repeat(8) }).length).toBeLessThanOrEqual(306);
  });
  it('never carries the code in any other message, and says nothing of a code when it has none', () => {
    for (const kind of MESSAGE_KINDS.filter((k) => k !== 'ready_for_collection')) expect(textContent(kind, at)).not.toContain('ABC-DEF');
    expect(textContent('ready_for_collection', facts)).not.toMatch(/code/i);
  });
});
