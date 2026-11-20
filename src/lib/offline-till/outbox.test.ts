import { describe, expect, it } from 'vitest';
import { afterSend, deviceRefOf, mayStillSell, pendingTotal, type OutboxEntry } from './outbox';

const entry = (total: number, state: OutboxEntry['state'] = 'pending'): OutboxEntry => ({ key: `k${String(total)}`, state, reason: null, tries: 0, words: { lines: [], change: 0 }, sale: { key: 'k', shiftId: 's', deviceRef: 'OFF-T1-0001', deviceTime: '2026-11-18T10:00:00.000Z', lines: [{ productId: 'p', quantity: 1, unitPrice: total }], tenders: [{ methodId: 'm', amount: total, reference: '' }], total, signature: 'a'.repeat(64) } });

describe('the offline till\'s outbox', () => {
  it('names a sale by the till and its own number', () => {
    expect(deviceRefOf('T1', 7)).toBe('OFF-T1-0007');
    expect(deviceRefOf('T1', 12345)).toBe('OFF-T1-12345');
  });
  it('counts what is waiting to be sent, not what needs attention', () => {
    expect(pendingTotal([entry(100), entry(250.5), entry(999, 'attention')])).toBe(350.5);
  });
  it('stops another sale when the shift has no room left, counting what is waiting here', () => {
    const limits = { maxPerShift: 1000, maxHours: 24 };
    expect(mayStillSell({ limits, soldSoFar: 0, entries: [entry(400)], total: 600 })).toEqual({ ok: true });
    expect(mayStillSell({ limits, soldSoFar: 300, entries: [entry(400)], total: 301 }).ok).toBe(false);
    expect(mayStillSell({ limits, soldSoFar: 300, entries: [entry(400)], total: 300 })).toEqual({ ok: true });
  });
  it('removes a sale the server took in, and keeps one it could not answer for another try', () => {
    expect(afterSend(entry(100), { ok: true, status: 'accepted', orderNumber: 'ORD-1', receiptNumber: 'RCT-1', flags: [] })).toEqual({ kind: 'done', words: 'OFF-T1-0001 is now receipt RCT-1.' });
    expect(afterSend(entry(100), { ok: true, status: 'needs_review', orderNumber: 'ORD-1', receiptNumber: null, flags: ['price_differs'] })).toMatchObject({ kind: 'done' });
    const kept = afterSend(entry(100), { thrown: true });
    expect(kept).toMatchObject({ kind: 'keep', entry: { tries: 1, state: 'pending' } });
  });
  it('lets go of a sale the server holds (parked or refused) with a message, and keeps one it can never accept from this till', () => {
    const held = afterSend(entry(100), { ok: true, status: 'parked', reason: 'Insufficient inventory.', flags: [] });
    expect(held.kind).toBe('held');
    expect(held.kind === 'held' ? held.words : '').toContain('Insufficient inventory');
    expect(afterSend(entry(100), { ok: false, error: 'Offline selling is switched off, so this sale cannot be taken in.' })).toMatchObject({ kind: 'keep', entry: { state: 'attention' } });
    expect(afterSend(entry(100), { ok: false, error: 'The sale could not be taken in just now.' })).toMatchObject({ kind: 'keep', entry: { state: 'pending' } });
  });
});
