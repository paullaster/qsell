import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { LookupFilterError, type LookupSource } from './runner';

const requirePermission = vi.fn();
const search = vi.fn();
let source: LookupSource | undefined;

vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'company-1' }) },
  }),
}));
vi.mock('./sources', () => ({ getLookupSource: () => source }));

const { searchLookupAction } = await import('./actions');

beforeEach(() => {
  requirePermission.mockReset().mockResolvedValue('user-1');
  search.mockReset().mockResolvedValue({ options: [{ id: '1', label: 'One' }], nextCursor: null });
  source = { key: 'things', permission: 'quotes:read', search };
});

describe('searchLookupAction', () => {
  it('refuses a request that is not shaped like one, before anything else happens', async () => {
    for (const raw of [null, 'x', 5, { source: '../etc' }, { source: 'things', limit: -1 }]) {
      const result = await searchLookupAction(raw);
      expect(result.ok).toBe(false);
    }
    expect(requirePermission).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('refuses a list the server does not define', async () => {
    source = undefined;
    expect(await searchLookupAction({ source: 'users' })).toEqual({
      ok: false,
      error: 'Unknown list.',
    });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it('checks the list’s own permission, and does not search without it', async () => {
    requirePermission.mockRejectedValue(
      new AccessDeniedError('quotes:read', { allowed: false, reason: 'deny-grant' }),
    );
    const result = await searchLookupAction({ source: 'things' });
    expect(requirePermission).toHaveBeenCalledWith('quotes:read');
    expect(result).toEqual({ ok: false, error: 'You do not have permission to see this list.' });
    expect(search).not.toHaveBeenCalled();
  });

  it('searches for the caller’s company with the cleaned, capped request', async () => {
    const result = await searchLookupAction({
      source: 'things',
      query: '  rice\u0000 ',
      limit: 9999,
      filters: { status: 'active' },
    });
    expect(result).toEqual({
      ok: true,
      data: { options: [{ id: '1', label: 'One' }], nextCursor: null },
    });
    expect(search).toHaveBeenCalledWith({
      companyId: 'company-1',
      query: 'rice',
      limit: 50,
      after: null,
      filters: { status: 'active' },
    });
  });

  it('never takes the company from the request', async () => {
    await searchLookupAction({
      source: 'things',
      companyId: 'someone-else',
      filters: { 'company-id': 'x' },
    });
    // The company comes from the signed-in company; a filter is only ever handed to the list,
    // which refuses any it does not define.
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', filters: { 'company-id': 'x' } }),
    );
    search.mockClear();
    expect(
      await searchLookupAction({ source: 'things', filters: { companyId: 'x' } }),
    ).toMatchObject({
      ok: false,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('turns a rejected filter into its message', async () => {
    search.mockRejectedValue(new LookupFilterError('Unsupported filter.'));
    expect(await searchLookupAction({ source: 'things' })).toEqual({
      ok: false,
      error: 'Unsupported filter.',
    });
  });

  it('keeps an unexpected failure off the screen', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    search.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const result = await searchLookupAction({ source: 'things' });
    expect(result).toEqual({ ok: false, error: 'Could not load the list. Try again.' });
    expect(JSON.stringify(result)).not.toContain('secret_table');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
