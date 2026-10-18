import { describe, expect, it } from 'vitest';
import { MAX_FEED_LINES, feedSecretHash, feedSecretMatches, newFeedSecret, parseFeedPayload } from './bank-feed';

const ok = (lines: unknown[], extra: Record<string, unknown> = {}) => parseFeedPayload({ lines, ...extra });

describe('statement lines pushed by a bank', () => {
  it('reads lines, in the order things happened, with the bank\'s balances', () => {
    const r = ok([{ date: '2026-10-16', amount: '500.00', reference: ' ABC ', description: 'Deposit  A', counterparty: 'Jane' }, { date: '2026-10-15', amount: -45.5, description: 'Fee' }], { openingBalance: '100.00', closingBalance: 554.5 });
    if ('error' in r) throw new Error(r.error);
    expect(r.statement.lines.map((l) => [l.lineNo, l.date, l.amountCents, l.reference, l.description])).toEqual([[1, '2026-10-15', -4550, null, 'Fee'], [2, '2026-10-16', 50000, 'ABC', 'Deposit A']]);
    expect(r.statement.openingCents).toBe(10000);
    expect(r.statement.closingCents).toBe(55450);
  });

  it('gives the same delivery the same fingerprint, and another delivery another', () => {
    const a = ok([{ date: '2026-10-16', amount: '5' }]);
    const b = ok([{ date: '2026-10-16', amount: 5 }]);
    const c = ok([{ date: '2026-10-16', amount: '6' }]);
    if ('error' in a || 'error' in b || 'error' in c) throw new Error('should parse');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it('refuses the whole delivery for a bad line, and names it', () => {
    const msg = (v: unknown) => ('error' in (v as object) ? (v as { error: string }).error : 'fine');
    expect(msg(parseFeedPayload(null))).toContain('JSON object');
    expect(msg(parseFeedPayload({}))).toContain('"lines"');
    expect(msg(ok([]))).toContain('at least one');
    expect(msg(ok(Array.from({ length: MAX_FEED_LINES + 1 }, () => ({ date: '2026-10-16', amount: '1' }))))).toContain('At most');
    expect(msg(ok([{ date: '16/10/2026', amount: '1' }]))).toContain('Line 1: the date');
    expect(msg(ok([{ date: '2026-02-30', amount: '1' }]))).toContain('Line 1: the date');
    expect(msg(ok([{ date: '2026-10-16', amount: '1' }, { date: '2026-10-16', amount: '1.005' }]))).toContain('Line 2: the amount');
    expect(msg(ok([{ date: '2026-10-16', amount: 0 }]))).toContain('non-zero');
    expect(msg(ok([{ date: '2026-10-16', amount: '1', reference: 'x'.repeat(201) }]))).toContain('too long');
    expect(msg(ok([{ date: '2026-10-16', amount: '1', balance: 'abc' }]))).toContain('balance');
    expect(msg(ok(['nope']))).toContain('not an object');
    expect(msg(ok([{ date: '2026-10-16', amount: '1' }], { closingBalance: 'abc' }))).toContain('closing balance');
  });
});

describe('the secret in a feed address', () => {
  it('is long, different each time, kept only as a fingerprint, and matched exactly', () => {
    const a = newFeedSecret();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(newFeedSecret()).not.toBe(a);
    const hash = feedSecretHash(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(feedSecretMatches(a, hash)).toBe(true);
    expect(feedSecretMatches(`${a}x`, hash)).toBe(false);
    expect(feedSecretMatches('', hash)).toBe(false);
    expect(feedSecretMatches(a, 'not-hex')).toBe(false);
  });
});
