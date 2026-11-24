import { describe, expect, it } from 'vitest';
import {
  asRecord,
  readChoice,
  readOverviewParams,
  readShortText,
  readUuid,
  readYmd,
} from './params';

const ID = '3f2b8c1e-5a4d-4e8b-9c0a-1d2e3f4a5b6c';

describe('parameter readers', () => {
  it('keeps a well-formed id and drops anything else', () => {
    expect(readUuid(ID)).toBe(ID);
    expect(readUuid(ID.toUpperCase())).toBe(ID.toUpperCase());
    expect(readUuid("x'; drop table orders; --")).toBeUndefined();
    expect(readUuid(`${ID} `)).toBeUndefined();
    expect(readUuid('')).toBeUndefined();
    expect(readUuid(42)).toBeUndefined();
    expect(readUuid(null)).toBeUndefined();
    expect(readUuid({ toString: () => ID })).toBeUndefined();
  });

  it('keeps a day that really exists and drops one that does not', () => {
    expect(readYmd('2026-03-10')).toBe('2026-03-10');
    expect(readYmd('2028-02-29')).toBe('2028-02-29');
    expect(readYmd('2026-02-29')).toBeUndefined();
    expect(readYmd('2026-13-01')).toBeUndefined();
    expect(readYmd('2026-3-1')).toBeUndefined();
    expect(readYmd('2026-03-10T00:00:00Z')).toBeUndefined();
    expect(readYmd(20260310)).toBeUndefined();
  });

  it('keeps only a word from the allowed list', () => {
    const words = ['due', 'invoice'] as const;
    expect(readChoice('due', words)).toBe('due');
    expect(readChoice('Due', words)).toBeUndefined();
    expect(readChoice('constructor', words)).toBeUndefined();
    expect(readChoice(['due'], words)).toBeUndefined();
  });

  it('cuts text and refuses non-text', () => {
    expect(readShortText('abcdef', 3)).toBe('abc');
    expect(readShortText(123, 3)).toBeUndefined();
    expect(readShortText(['a'], 3)).toBeUndefined();
  });

  it('treats only a plain object as parameters', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
    expect(asRecord('text')).toEqual({});
    expect(asRecord(undefined)).toEqual({});
  });
});

describe('overview parameters', () => {
  it('reads a normal request', () => {
    expect(
      readOverviewParams({ preset: 'this_month', compare: 'previous_year', branchId: ID }),
    ).toEqual({
      preset: 'this_month',
      compare: 'previous_year',
      from: undefined,
      to: undefined,
      branchId: ID,
    });
  });

  it('cuts the period and dates to the lengths the period resolver expects', () => {
    const out = readOverviewParams({
      preset: 'custom'.repeat(10),
      from: '2026-03-10T00:00:00Z extra',
      to: '2026-03-11-and-more',
    });
    expect(out.preset).toHaveLength(20);
    expect(out.from).toBe('2026-03-10');
    expect(out.to).toBe('2026-03-11');
  });

  it('drops a bad branch and survives hostile input', () => {
    expect(readOverviewParams({ branchId: 'not-an-id' }).branchId).toBeUndefined();
    expect(readOverviewParams({ preset: { evil: true }, from: 5 })).toEqual({
      preset: undefined,
      compare: undefined,
      from: undefined,
      to: undefined,
      branchId: undefined,
    });
    expect(readOverviewParams(undefined).branchId).toBeUndefined();
    expect(readOverviewParams('junk').preset).toBeUndefined();
  });
});
