import { describe, expect, it } from 'vitest';
import { collectProblem, goesIntoTill, readCollect } from './collect';

const id = '9f1c7e1e-3b0a-4a8e-8d6b-2b4f6f0a1c11';
const key = '3f2c7e1e-3b0a-4a8e-8d6b-2b4f6f0a1c22';
const base = { visitId: id, methodId: id, amount: 500, reference: ' QK123 ', key };

describe('reading a collection', () => {
  it('reads the visit, the way of paying, the amount and the reference', () => {
    expect(readCollect(base)).toEqual({ ok: true, collect: { visitId: id, methodId: id, amount: 500, reference: 'QK123', key } });
    expect(readCollect({ ...base, amount: '250.50', reference: undefined })).toMatchObject({ ok: true, collect: { amount: 250.5, reference: '' } });
  });
  it('refuses what cannot be a payment', () => {
    expect(readCollect(null)).toMatchObject({ ok: false });
    expect(readCollect({ ...base, visitId: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('visit') as string });
    expect(readCollect({ ...base, methodId: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('how the customer paid') as string });
    for (const amount of [0, -1, 'x', '', 10.005, 200_000_000]) expect(readCollect({ ...base, amount })).toMatchObject({ ok: false });
    expect(readCollect({ ...base, key: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining('told apart') as string });
  });
});

describe('when money can be collected', () => {
  const ok = { dayStatus: 'out', visitStatus: 'arrived', customerName: 'Duka', owed: 1000, amount: 400 };
  it('needs the day out, the rep at the customer, something owed, and no more than is owed', () => {
    expect(collectProblem(ok)).toBeNull();
    expect(collectProblem({ ...ok, amount: 1000 })).toBeNull();
    expect(collectProblem({ ...ok, dayStatus: 'loading' })).toContain('while the day is out');
    expect(collectProblem({ ...ok, visitStatus: 'planned' })).toContain('Arrive at Duka');
    expect(collectProblem({ ...ok, owed: 0 })).toContain('owes nothing');
    expect(collectProblem({ ...ok, amount: 1000.01 })).toContain('cannot collect more');
  });
  it('puts only cash into the till', () => {
    expect(goesIntoTill('cash')).toBe(true);
    expect(goesIntoTill('mobile_money')).toBe(false);
    expect(goesIntoTill('card')).toBe(false);
  });
});
