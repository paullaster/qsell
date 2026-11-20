import { describe, expect, it } from 'vitest';
import {
  decodeStatementCursor,
  encodeStatementCursor,
  isStatementId,
  statementFilterDate,
} from './statement-cursor';

const id = '123e4567-e89b-12d3-a456-426614174000';

describe('customer statement input', () => {
  it('round trips a dated page cursor', () => {
    expect(decodeStatementCursor(encodeStatementCursor({ date: '2026-09-01', id }))).toEqual({
      date: '2026-09-01',
      id,
    });
  });

  it('round trips a cursor after undated legacy entries', () => {
    expect(decodeStatementCursor(encodeStatementCursor({ date: null, id }))).toEqual({
      date: null,
      id,
    });
  });

  it('refuses a cursor that was not made by the server', () => {
    expect(() => decodeStatementCursor('not-a-cursor')).toThrow(/could not be read/);
    expect(() =>
      decodeStatementCursor(
        Buffer.from(JSON.stringify({ date: '2026-09-01', id: 'x' })).toString('base64url'),
      ),
    ).toThrow(/could not be read/);
  });

  it('accepts only real calendar dates and empty filters', () => {
    expect(statementFilterDate('2026-02-28')).toBe('2026-02-28');
    expect(statementFilterDate('')).toBeNull();
    expect(statementFilterDate(undefined)).toBeNull();
    expect(() => statementFilterDate('2026-02-31')).toThrow(/not valid/);
    expect(() => statementFilterDate('01/02/2026')).toThrow(/not valid/);
  });

  it('recognises only whole ids', () => {
    expect(isStatementId(id)).toBe(true);
    expect(isStatementId(`${id};drop`)).toBe(false);
  });
});
