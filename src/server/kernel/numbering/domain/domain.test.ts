import { describe, expect, it } from 'vitest';
import { formatNumber, isBeyondEnd, nextSequence } from './format';
import { isIsoDate, periodKey } from './period';
import { selectLines } from './select-line';
import { renderTemplate, TemplateError, validateTemplate } from './template';
import type { LineConfig } from './types';
import { findOverlap, frozenViolations, validateLine } from './validate';

const line = (over: Partial<LineConfig> = {}): LineConfig => ({
  id: 'l1',
  lineNo: 1,
  branchId: null,
  startsOn: '2026-01-01',
  endsOn: null,
  prefix: 'INV-',
  suffix: '',
  digits: 6,
  startNo: 1,
  endNo: null,
  increment: 1,
  warnAt: null,
  reset: 'never',
  isOpen: true,
  ...over,
});

describe('template', () => {
  it('accepts safe characters and tokens, rejects anything else', () => {
    expect(validateTemplate('INV-{BRANCH}-{YY}/')).toBeNull();
    expect(validateTemplate('INV #1')).not.toBeNull();
    expect(validateTemplate('INV-{DAY}')).not.toBeNull();
    expect(validateTemplate('x'.repeat(25))).not.toBeNull();
  });

  it('renders tokens from the document date, not the clock', () => {
    expect(renderTemplate('INV-{YYYY}{MM}-', { date: '2025-12-31' })).toBe('INV-202512-');
    expect(renderTemplate('{YY}/{BRANCH}', { date: '2026-02-03', branchCode: 'nbo-1' })).toBe(
      '26/NBO1',
    );
  });

  it('says so when a branch token has no branch', () => {
    expect(() => renderTemplate('{BRANCH}-', { date: '2026-01-01' })).toThrow(TemplateError);
  });

  it('rejects an impossible date', () => {
    expect(() => renderTemplate('A', { date: '2026-13-01' })).toThrow(TemplateError);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });
});

describe('period and format', () => {
  it('keys counters by reset policy', () => {
    expect(periodKey('never', '2026-05-09')).toBe('');
    expect(periodKey('yearly', '2026-05-09')).toBe('2026');
    expect(periodKey('monthly', '2026-05-09')).toBe('2026-05');
  });

  it('starts at the start number and then steps by the increment', () => {
    const l = line({ startNo: 100, increment: 5 });
    expect(nextSequence(null, l)).toBe(100);
    expect(nextSequence(100, l)).toBe(105);
  });

  it('pads, wraps with prefix and suffix, and refuses to overflow its digits', () => {
    const l = line({ prefix: 'INV-{YY}-', suffix: '-K', digits: 4 });
    expect(formatNumber(l, 7, { date: '2026-01-01' })).toBe('INV-26-0007-K');
    expect(() => formatNumber(l, 10000, { date: '2026-01-01' })).toThrow(/does not fit/);
  });

  it('knows when the range is used up', () => {
    expect(isBeyondEnd(11, line({ endNo: 10 }))).toBe(true);
    expect(isBeyondEnd(10, line({ endNo: 10 }))).toBe(false);
    expect(isBeyondEnd(1_000_000, line({ endNo: null, digits: 6 }))).toBe(true);
  });
});

describe('line selection', () => {
  const general = line({ id: 'g', lineNo: 1 });
  const nairobi = line({ id: 'n', lineNo: 2, branchId: 'B1' });

  it('prefers a branch-specific line over a general one', () => {
    const r = selectLines([general, nairobi], { branchId: 'B1', date: '2026-05-01' });
    expect(r.ranked.map((l) => l.id)).toEqual(['n', 'g']);
  });

  it('skips lines for other branches, closed, not started and ended lines, and says why', () => {
    const lines = [
      line({ id: 'a', lineNo: 1, branchId: 'B2' }),
      line({ id: 'b', lineNo: 2, isOpen: false }),
      line({ id: 'c', lineNo: 3, startsOn: '2027-01-01' }),
      line({ id: 'd', lineNo: 4, endsOn: '2025-12-31' }),
      line({ id: 'e', lineNo: 5 }),
    ];
    const r = selectLines(lines, { branchId: 'B1', date: '2026-05-01' });
    expect(r.ranked.map((l) => l.id)).toEqual(['e']);
    expect(r.considered.map((c) => c.reason)).toEqual([
      'for a different branch',
      'closed',
      'starts on 2027-01-01',
      'ended on 2025-12-31',
      'open, for every branch',
    ]);
  });

  it('prefers the line that started most recently', () => {
    const r = selectLines(
      [
        line({ id: 'old', lineNo: 1, startsOn: '2025-01-01' }),
        line({ id: 'new', lineNo: 2, startsOn: '2026-01-01' }),
      ],
      { branchId: null, date: '2026-05-01' },
    );
    expect(r.ranked[0]!.id).toBe('new');
  });

  it('returns nothing usable when nothing matches', () => {
    expect(
      selectLines([line({ isOpen: false })], { branchId: null, date: '2026-05-01' }).ranked,
    ).toEqual([]);
  });
});

describe('line validation', () => {
  const rules = { mode: 'gap_free' as const, dateOrder: false };
  const base = (over: Partial<LineConfig> = {}) => {
    const { id: _id, lineNo: _lineNo, ...rest } = line(over);
    return rest;
  };

  it('accepts a sensible line', () => {
    expect(validateLine(base({ endNo: 999999, warnAt: 990000 }), rules)).toEqual([]);
  });

  it('reports each problem against its field', () => {
    const fields = (over: Partial<LineConfig>) =>
      validateLine(base(over), rules).map((i) => i.field);
    expect(fields({ startsOn: '2026-02-30' })).toContain('startsOn');
    expect(fields({ endsOn: '2025-01-01' })).toContain('endsOn');
    expect(fields({ prefix: 'bad prefix' })).toContain('prefix');
    expect(fields({ digits: 0 })).toContain('digits');
    expect(fields({ digits: 16 })).toContain('digits');
    expect(fields({ increment: 0 })).toContain('increment');
    expect(fields({ startNo: 5, endNo: 4 })).toContain('endNo');
    expect(fields({ digits: 3, endNo: 1000 })).toContain('endNo');
    expect(fields({ startNo: 10, endNo: 100, warnAt: 5 })).toContain('warnAt');
  });

  it('allows date order only on gap-free series', () => {
    expect(
      validateLine(base(), { mode: 'allow_gaps', dateOrder: true }).map((i) => i.field),
    ).toContain('dateOrder');
  });

  it('finds overlapping open lines in the same branch scope only', () => {
    const existing = [line({ id: 'x', lineNo: 1, startsOn: '2026-01-01', endsOn: '2026-12-31' })];
    expect(
      findOverlap(existing, {
        id: 'new',
        branchId: null,
        startsOn: '2026-06-01',
        endsOn: null,
        isOpen: true,
      })?.id,
    ).toBe('x');
    expect(
      findOverlap(existing, {
        id: 'new',
        branchId: null,
        startsOn: '2027-01-01',
        endsOn: null,
        isOpen: true,
      }),
    ).toBeNull();
    expect(
      findOverlap(existing, {
        id: 'new',
        branchId: 'B1',
        startsOn: '2026-06-01',
        endsOn: null,
        isOpen: true,
      }),
    ).toBeNull();
    expect(
      findOverlap(existing, {
        id: 'new',
        branchId: null,
        startsOn: '2026-06-01',
        endsOn: null,
        isOpen: false,
      }),
    ).toBeNull();
    expect(
      findOverlap([{ ...existing[0]!, isOpen: false }], {
        id: 'new',
        branchId: null,
        startsOn: '2026-06-01',
        endsOn: null,
        isOpen: true,
      }),
    ).toBeNull();
  });

  it('freezes what would change the meaning of numbers already issued', () => {
    const existing = line();
    expect(frozenViolations(existing, { prefix: 'X-' }).map((i) => i.field)).toEqual(['prefix']);
    expect(frozenViolations(existing, { prefix: 'INV-', endNo: 5000 })).toEqual([]);
  });
});
