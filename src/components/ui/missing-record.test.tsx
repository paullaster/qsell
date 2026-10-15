// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { isMissing, MissingAs404 } from './missing-record';

const notFound = vi.hoisted(() => vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }));
vi.mock('next/navigation', () => ({ notFound }));

describe('missing records', () => {
  it('reads only a not-found answer as missing', () => {
    expect(isMissing({ ok: false, code: 'NOT_FOUND' })).toBe(true);
    expect(isMissing({ ok: false, code: 'ACCOUNT_NOT_FOUND' })).toBe(true);
    expect(isMissing({ ok: false, code: 'NOT_FOUNDER' })).toBe(false);
    expect(isMissing({ ok: false, code: 'INVALID' })).toBe(false);
    expect(isMissing({ ok: false })).toBe(false);
    expect(isMissing({ ok: true, code: 'NOT_FOUND' })).toBe(false);
  });

  it('shows the not-found page for a missing record and the screen for anything else', async () => {
    await expect(MissingAs404({ result: Promise.resolve({ ok: false, code: 'NOT_FOUND' }), children: 'screen' })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    await expect(MissingAs404({ result: Promise.resolve({ ok: true }), children: 'screen' })).resolves.toBe('screen');
    await expect(MissingAs404({ result: Promise.resolve({ ok: false, code: 'FORBIDDEN' }), children: 'screen' })).resolves.toBe('screen');
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
