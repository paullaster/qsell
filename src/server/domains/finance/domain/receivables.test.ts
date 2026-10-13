import { describe, expect, it } from 'vitest';
import {
  ageOpenItems,
  checkApplications,
  checkReceiptAgainstMethod,
  fromCents,
  planOldestFirst,
  toCents,
  type MethodRules,
  type ReceiptInputFacts,
} from './receivables';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('cents', () => {
  it('parses and formats exactly', () => {
    expect(toCents('10.5')).toBe(1050);
    expect(toCents('0.07')).toBe(7);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('-3')).toBe(-300);
    expect(fromCents(1050)).toBe('10.50');
    expect(fromCents(-7)).toBe('-0.07');
    expect(fromCents(0)).toBe('0.00');
  });
  it('refuses more than 2 decimals and junk', () => {
    expect(() => toCents('1.005')).toThrow();
    expect(() => toCents('abc')).toThrow();
    expect(() => toCents('')).toThrow();
  });
});

describe('planOldestFirst', () => {
  const inv = (id: string, remaining: number, due: string, no = id) => ({
    id,
    remainingCents: remaining,
    dueDate: d(due),
    createdAt: d('2026-01-01'),
    documentNo: no,
  });
  it('fills the oldest due first and stops when the money runs out', () => {
    const plan = planOldestFirst([inv('b', 500, '2026-03-01'), inv('a', 300, '2026-02-01'), inv('c', 900, '2026-04-01')], 700);
    expect(plan).toEqual([
      { entryId: 'a', amountCents: 300 },
      { entryId: 'b', amountCents: 400 },
    ]);
  });
  it('never exceeds what is available and ignores closed invoices', () => {
    expect(planOldestFirst([inv('a', 0, '2026-02-01')], 100)).toEqual([]);
    const plan = planOldestFirst([inv('a', 100, '2026-02-01')], 1000);
    expect(plan).toEqual([{ entryId: 'a', amountCents: 100 }]);
  });
  it('is deterministic on ties', () => {
    const plan = planOldestFirst([inv('x', 100, '2026-02-01', 'INV-2'), inv('y', 100, '2026-02-01', 'INV-1')], 100);
    expect(plan[0]!.entryId).toBe('y');
  });
});

describe('checkApplications', () => {
  const open = new Map([['a', 300], ['b', 500]]);
  it('accepts a valid split', () => {
    expect(checkApplications(800, open, [{ entryId: 'a', amountCents: 300 }, { entryId: 'b', amountCents: 400 }])).toEqual([]);
  });
  it('rejects over-applying an invoice or the credit, duplicates, zero and nothing', () => {
    const codes = (p: Parameters<typeof checkApplications>[2], avail = 800) => checkApplications(avail, open, p).map((i) => i.code);
    expect(codes([{ entryId: 'a', amountCents: 301 }])).toContain('OVER_INVOICE');
    expect(codes([{ entryId: 'a', amountCents: 300 }, { entryId: 'b', amountCents: 500 }], 700)).toContain('OVER_CREDIT');
    expect(codes([{ entryId: 'a', amountCents: 100 }, { entryId: 'a', amountCents: 100 }])).toContain('DUPLICATE_TARGET');
    expect(codes([{ entryId: 'a', amountCents: 0 }])).toContain('AMOUNT_INVALID');
    expect(codes([])).toEqual(['NOTHING_TO_APPLY']);
  });
});

describe('ageOpenItems', () => {
  it('buckets by days past due and keeps credits apart', () => {
    const asOf = d('2026-10-12');
    const r = ageOpenItems(
      [
        { remainingCents: 100, dueDate: d('2026-10-20'), createdAt: d('2026-10-01') }, // not yet due
        { remainingCents: 200, dueDate: d('2026-10-02'), createdAt: d('2026-09-01') }, // 10 days
        { remainingCents: 300, dueDate: d('2026-08-30'), createdAt: d('2026-08-01') }, // 43 days
        { remainingCents: 400, dueDate: d('2026-01-01'), createdAt: d('2026-01-01') }, // > 90
        { remainingCents: -250, dueDate: null, createdAt: d('2026-10-05') }, // unapplied receipt
      ],
      asOf,
    );
    expect(r.buckets.map((b) => [b.label, b.cents])).toEqual([
      ['Not yet due', 100],
      ['1–30 days', 200],
      ['31–60 days', 300],
      ['61–90 days', 0],
      ['Over 90 days', 400],
    ]);
    expect(r.creditsCents).toBe(250);
    expect(r.creditsCount).toBe(1);
  });
});

describe('receipt rules', () => {
  const base: MethodRules = {
    kind: 'cheque',
    requiresReference: true,
    requiresEvidence: true,
    requiresCounterparty: true,
    limits: { min: '10.00', max: '1000.00' },
    usableFor: ['customer_receipt'],
    enabled: true,
  };
  const facts: ReceiptInputFacts = { amountCents: 5000, externalReference: 'CHQ1', counterparty: { chequeNo: '1', bank: 'B', drawer: 'D' }, evidenceCount: 1 };
  it('passes a complete cheque', () => {
    expect(checkReceiptAgainstMethod(base, facts, true)).toEqual([]);
  });
  it('names what is missing', () => {
    const codes = (m: MethodRules, f: ReceiptInputFacts, post = true) => checkReceiptAgainstMethod(m, f, post).map((i) => i.code);
    expect(codes(base, { ...facts, externalReference: ' ' })).toContain('REFERENCE_REQUIRED');
    expect(codes(base, { ...facts, counterparty: { chequeNo: '1' } })).toContain('COUNTERPARTY_REQUIRED');
    expect(codes(base, { ...facts, amountCents: 5 })).toContain('BELOW_MINIMUM');
    expect(codes(base, { ...facts, amountCents: 100001 })).toContain('ABOVE_MAXIMUM');
    expect(codes(base, { ...facts, evidenceCount: 0 })).toContain('EVIDENCE_REQUIRED');
    expect(codes(base, { ...facts, evidenceCount: 0 }, false)).not.toContain('EVIDENCE_REQUIRED');
    expect(codes({ ...base, enabled: false }, facts)).toContain('METHOD_DISABLED');
    expect(codes({ ...base, usableFor: ['customer_refund'] }, facts)).toContain('METHOD_NOT_FOR_RECEIPTS');
  });
});
