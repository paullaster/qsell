import { describe, expect, it } from 'vitest';
import { choosePolicy, scopeSpecificity, wouldTie, type ChargeContext, type PolicyHeader } from './select';

const at = new Date('2026-11-04T09:00:00Z');
const header = (over: Partial<PolicyHeader> & { code: string }): PolicyHeader => ({ id: `id-${over.code}`, currency: 'KES', status: 'in_force', priority: 0, validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, scopes: {}, ...over });
const ctx = (over: Partial<ChargeContext> = {}): ChargeContext => ({ at, currency: 'KES', branchId: 'b1', channel: 'ecommerce', customerGroupId: 'g1', ...over });

describe('choosing the policy that applies', () => {
  it('takes the only policy in force that fits, and nothing when none does', () => {
    expect(choosePolicy([header({ code: 'A' })], ctx()).chosen?.code).toBe('A');
    expect(choosePolicy([], ctx()).chosen).toBeNull();
  });
  it('leaves out drafts, retired policies, other currencies, and ones outside their dates, saying why', () => {
    const list = [
      header({ code: 'DRAFT', status: 'draft' }),
      header({ code: 'OLD', status: 'retired' }),
      header({ code: 'USD', currency: 'USD' }),
      header({ code: 'LATER', validFrom: new Date('2026-12-01T00:00:00Z') }),
      header({ code: 'ENDED', validTo: new Date('2026-10-01T00:00:00Z') }),
      header({ code: 'LIVE' }),
    ];
    const r = choosePolicy(list, ctx());
    expect(r.chosen?.code).toBe('LIVE');
    const why = Object.fromEntries(r.considered.map((c) => [c.code, c.why]));
    expect(why).toMatchObject({ DRAFT: 'Still a draft', OLD: 'Retired', USD: 'Charges in USD, not KES', LATER: 'Not started yet', ENDED: 'Ended', LIVE: null });
  });
  it('starts a policy at its first moment and ends it just before its last', () => {
    const p = header({ code: 'W', validFrom: at, validTo: new Date(at.getTime() + 1000) });
    expect(choosePolicy([p], ctx({ at })).chosen?.code).toBe('W');
    expect(choosePolicy([p], ctx({ at: new Date(at.getTime() - 1) })).chosen).toBeNull();
    expect(choosePolicy([p], ctx({ at: new Date(at.getTime() + 1000) })).chosen).toBeNull();
  });
  it('limits a policy to the branch, channel or customer group it names', () => {
    const forBranch = header({ code: 'B2', scopes: { branch: { op: 'in', values: ['b2'] } } });
    const notChannel = header({ code: 'NOSHOP', scopes: { channel: { op: 'not_in', values: ['ecommerce'] } } });
    const any = header({ code: 'ANY' });
    expect(choosePolicy([forBranch, notChannel, any], ctx()).chosen?.code).toBe('ANY');
    expect(choosePolicy([forBranch, notChannel, any], ctx({ branchId: 'b2' })).chosen?.code).toBe('B2');
    // "All except" does not make a policy more specific, so it ties with the plain one and the code decides.
    expect(choosePolicy([forBranch, notChannel, any], ctx({ channel: 'pos_cash_sale' })).chosen?.code).toBe('ANY');
    expect(choosePolicy([forBranch, notChannel], ctx({ channel: 'pos_cash_sale' })).chosen?.code).toBe('NOSHOP');
    expect(choosePolicy([forBranch, notChannel], ctx()).chosen).toBeNull();
    const r = choosePolicy([forBranch], ctx());
    expect(r.considered[0]).toMatchObject({ outcome: 'not_applicable' });
    expect(choosePolicy([forBranch], ctx({ branchId: null })).chosen).toBeNull();
  });
  it('prefers the more specific policy over a higher priority, then priority, then the newest start, then the code', () => {
    const general = header({ code: 'GENERAL', priority: 9 });
    const specific = header({ code: 'SPECIFIC', priority: 0, scopes: { customer_group: { op: 'in', values: ['g1'] } } });
    expect(choosePolicy([general, specific], ctx()).chosen?.code).toBe('SPECIFIC');
    const high = header({ code: 'HIGH', priority: 5 });
    const low = header({ code: 'LOW', priority: 1 });
    expect(choosePolicy([low, high], ctx()).chosen?.code).toBe('HIGH');
    const older = header({ code: 'OLDER', validFrom: new Date('2026-01-01T00:00:00Z') });
    const newer = header({ code: 'NEWER', validFrom: new Date('2026-06-01T00:00:00Z') });
    expect(choosePolicy([older, newer], ctx()).chosen?.code).toBe('NEWER');
    const a = header({ code: 'AAA' });
    const b = header({ code: 'BBB' });
    expect(choosePolicy([b, a], ctx()).chosen?.code).toBe('AAA');
  });
  it('gives the same answer whatever order the policies come in', () => {
    const list = [header({ code: 'C', priority: 1 }), header({ code: 'A', priority: 1 }), header({ code: 'B', priority: 1 }), header({ code: 'D', priority: 0, scopes: { branch: { op: 'in', values: ['b1'] } } })];
    const want = choosePolicy(list, ctx()).chosen?.code;
    for (let i = 0; i < 6; i += 1) {
      const shuffled = [...list].sort(() => (i % 2 === 0 ? 1 : -1)).reverse();
      expect(choosePolicy(shuffled, ctx()).chosen?.code).toBe(want);
    }
    expect(want).toBe('D');
  });
  it('explains why each eligible policy lost', () => {
    const r = choosePolicy([header({ code: 'W', scopes: { branch: { op: 'in', values: ['b1'] } } }), header({ code: 'L1', priority: 2 }), header({ code: 'L2', priority: 2, validFrom: new Date('2025-01-01T00:00:00Z') }), header({ code: 'L3', priority: 1 })], ctx());
    const why = Object.fromEntries(r.considered.map((c) => [c.code, [c.outcome, c.why]]));
    expect(why.W).toEqual(['won', null]);
    expect(why.L1?.[1]).toMatch(/Less specific/);
    expect(why.L3?.[1]).toMatch(/Less specific/);
    const r2 = choosePolicy([header({ code: 'P2', priority: 2 }), header({ code: 'P1', priority: 1 }), header({ code: 'OLD', priority: 2, validFrom: new Date('2025-01-01T00:00:00Z') })], ctx());
    const why2 = Object.fromEntries(r2.considered.map((c) => [c.code, c.why]));
    expect(why2.P1).toMatch(/lower priority/);
    expect(why2.OLD).toBe('Same priority, but an older policy');
  });
  it('counts only the dimensions limited with "only" towards specificity', () => {
    expect(scopeSpecificity({})).toBe(0);
    expect(scopeSpecificity({ branch: { op: 'in', values: ['b'] } })).toBeGreaterThan(0);
    expect(scopeSpecificity({ branch: { op: 'not_in', values: ['b'] } })).toBe(0);
    expect(scopeSpecificity({ customer_group: { op: 'in', values: ['g'] } })).toBeGreaterThan(scopeSpecificity({ branch: { op: 'in', values: ['b'] }, channel: { op: 'in', values: ['c'] } }));
  });
});

describe('policies that would tie', () => {
  const a = header({ code: 'A' });
  it('are the same currency, priority and specificity, with scopes and dates that can overlap', () => {
    expect(wouldTie(a, header({ code: 'B' }))).toBe(true);
    expect(wouldTie(a, header({ code: 'B', priority: 1 }))).toBe(false);
    expect(wouldTie(a, header({ code: 'B', currency: 'USD' }))).toBe(false);
    expect(wouldTie(a, header({ code: 'B', scopes: { branch: { op: 'in', values: ['b1'] } } }))).toBe(false);
  });
  it('do not tie when each is for a different branch, or when their dates do not meet', () => {
    const x = header({ code: 'X', scopes: { branch: { op: 'in', values: ['b1'] } } });
    const y = header({ code: 'Y', scopes: { branch: { op: 'in', values: ['b2'] } } });
    const z = header({ code: 'Z', scopes: { branch: { op: 'in', values: ['b1', 'b2'] } } });
    expect(wouldTie(x, y)).toBe(false);
    expect(wouldTie(x, z)).toBe(true);
    const jan = header({ code: 'JAN', validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date('2026-02-01T00:00:00Z') });
    const feb = header({ code: 'FEB', validFrom: new Date('2026-02-01T00:00:00Z'), validTo: new Date('2026-03-01T00:00:00Z') });
    expect(wouldTie(jan, feb)).toBe(false);
    expect(wouldTie(jan, header({ code: 'ALL' }))).toBe(true);
  });
  it('is the same question both ways round', () => {
    const b = header({ code: 'B', scopes: { channel: { op: 'in', values: ['x'] } } });
    expect(wouldTie(a, b)).toBe(wouldTie(b, a));
  });
});
