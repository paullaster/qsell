import { describe, expect, it } from 'vitest';
import { canonicalSale, limitProblem, limitsProblem, linesTotalCents, offlineRoom, parseOfflineSale, sameSignature, type OfflineSale } from './offline-rules';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sale: OfflineSale = { key: id(1), shiftId: id(2), deviceRef: 'OFF-T1-0007', deviceTime: '2026-11-18T10:15:00.000Z', lines: [{ productId: 'prod_a', quantity: 2, unitPrice: 116 }, { productId: 'prod_b', quantity: 0.5, unitPrice: 40 }], tenders: [{ methodId: id(3), amount: 500, reference: '' }], total: 252 };
const raw = { ...sale, signature: 'a'.repeat(64) };

describe('the sale a till sends', () => {
  it('is read when it is whole, and the total is what the lines come to', () => {
    expect(parseOfflineSale(raw)).toEqual({ ok: true, sale: raw });
    expect(linesTotalCents(sale.lines)).toBe(25200);
  });
  it('is refused when it is not: a total that is not the lines, a product twice, a bad price or quantity, no payment, no signature', () => {
    expect(parseOfflineSale({ ...raw, total: 251 }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, lines: [...sale.lines, sale.lines[0]] }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, lines: [{ productId: 'p', quantity: 1, unitPrice: 0 }] }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, lines: [{ productId: 'p', quantity: 1.0005, unitPrice: 1 }], total: 1 }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, tenders: [] }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, signature: 'abc' }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, key: 'nope' }).ok).toBe(false);
    expect(parseOfflineSale({ ...raw, deviceTime: 'yesterday' }).ok).toBe(false);
    expect(parseOfflineSale(null).ok).toBe(false);
  });
});

describe('signing a sale', () => {
  it('is over the same text however a number was written, and any change changes the text', () => {
    expect(canonicalSale(sale)).toBe(canonicalSale({ ...sale, total: 252.0, lines: sale.lines.map((l) => ({ ...l, unitPrice: Number(l.unitPrice.toFixed(2)) })) }));
    expect(canonicalSale({ ...sale, total: 251.99 })).not.toBe(canonicalSale(sale));
    expect(canonicalSale({ ...sale, lines: [{ ...sale.lines[0], quantity: 3 }, sale.lines[1]] as OfflineSale['lines'] })).not.toBe(canonicalSale(sale));
    expect(canonicalSale({ ...sale, tenders: [{ methodId: id(3), amount: 600, reference: '' }] })).not.toBe(canonicalSale(sale));
    expect(canonicalSale({ ...sale, shiftId: id(9) })).not.toBe(canonicalSale(sale));
  });
  it('compares signatures whole', () => {
    expect(sameSignature('abc', 'abc')).toBe(true);
    expect(sameSignature('abc', 'abd')).toBe(false);
    expect(sameSignature('abc', 'abcd')).toBe(false);
  });
});

describe('the limits that keep it honest', () => {
  const limits = { maxPerShift: 50_000, maxHours: 24 };
  it('refuses a sale past the shift\'s limit or one that waited too long, in words', () => {
    expect(limitProblem({ limits, soldSoFar: 0, total: 252, waitedMs: 1000 })).toBeNull();
    expect(limitProblem({ limits, soldSoFar: 49_900, total: 252, waitedMs: 1000 })).toContain('most allowed is 50000');
    expect(limitProblem({ limits, soldSoFar: 0, total: 252, waitedMs: 25 * 3_600_000 })).toContain('more than 24 hours');
    expect(limitProblem({ limits, soldSoFar: 49_748, total: 252, waitedMs: 0 })).toBeNull();
  });
  it('shows the room left, and checks the limits a company sets', () => {
    expect(offlineRoom(limits, 12_000.5)).toBe(37_999.5);
    expect(offlineRoom(limits, 90_000)).toBe(0);
    expect(limitsProblem(limits)).toBeNull();
    expect(limitsProblem({ maxPerShift: 0, maxHours: 24 })).not.toBeNull();
    expect(limitsProblem({ maxPerShift: 100, maxHours: 0 })).not.toBeNull();
    expect(limitsProblem({ maxPerShift: 100, maxHours: 1.5 })).not.toBeNull();
  });
});
