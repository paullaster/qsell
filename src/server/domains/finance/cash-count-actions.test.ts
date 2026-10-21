import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { FinanceError } from './errors';

const requirePermission = vi.fn();
const canPermission = vi.fn();
const overview = vi.fn();
const preview = vi.fn();
const post = vi.fn();
const list = vi.fn();
const revalidatePath = vi.fn();

vi.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a) as unknown,
}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a) as unknown,
  canPermission: (...a: unknown[]) => canPermission(...a) as unknown,
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'company-1' }) },
    reasonCodes: { ensureSystemReasons: () => Promise.resolve() },
    finance: {
      cashCounts: {
        overview: (...a: unknown[]) => overview(...a) as unknown,
        preview: (...a: unknown[]) => preview(...a) as unknown,
        post: (...a: unknown[]) => post(...a) as unknown,
        list: (...a: unknown[]) => list(...a) as unknown,
      },
    },
  }),
}));

const actions = await import('./cash-count-actions');

beforeEach(() => {
  for (const f of [requirePermission, canPermission, overview, preview, post, list, revalidatePath])
    f.mockReset();
  requirePermission.mockResolvedValue('user-1');
  canPermission.mockResolvedValue(true);
});

describe('the cash count actions', () => {
  it('list the cash accounts with the books figure as money text, for someone who may read counts', async () => {
    overview.mockResolvedValue([
      {
        id: 'a1',
        code: 'TILL',
        name: 'Till',
        currency: 'KES',
        bookCents: 70_000,
        last: {
          number: 'CCT-1',
          countDate: '2026-10-20',
          countedAmount: '700.00',
          difference: '0.00',
        },
      },
    ]);
    const res = await actions.cashCountsOverviewAction();
    expect(requirePermission).toHaveBeenCalledWith('cash_counts:read');
    expect(res).toMatchObject({
      ok: true,
      data: {
        canCount: true,
        accounts: [{ code: 'TILL', book: '700.00', last: { number: 'CCT-1', counted: '700.00' } }],
      },
    });
  });

  it('preview needs the permission to count, since it shows what the books hold', async () => {
    preview.mockResolvedValue({
      currency: 'KES',
      bookCents: 12_345,
      lastVariance: null,
      glChoiceCount: 1,
    });
    const res = await actions.cashCountPreviewAction('a1', '2026-10-21');
    expect(requirePermission).toHaveBeenCalledWith('cash_counts:post');
    expect(res).toMatchObject({ ok: true, data: { book: '123.45', bookCents: 12_345 } });
  });

  it('post sets the counter from the session, never from the request, and refreshes the screen', async () => {
    post.mockResolvedValue({ id: 'c1', number: 'CCT-2', difference: '-150.00', gl: false });
    const res = await actions.postCashCountAction({
      bankAccountId: 'a1',
      countDate: '2026-10-21',
      total: '1850',
      varianceGlAccountId: 'g1',
      note: 'short',
    });
    expect(requirePermission).toHaveBeenCalledWith('cash_counts:post');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', actor: { type: 'user', id: 'user-1' } }),
      expect.objectContaining({ bankAccountId: 'a1', total: '1850' }),
    );
    expect(res).toMatchObject({ ok: true, data: { number: 'CCT-2' } });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/finance/cash-counts');
  });

  it('answer a refused count as data, in words', async () => {
    post.mockRejectedValue(
      new FinanceError(
        'COUNT_INCOMPLETE',
        'Say why the cash does not agree with the books (at least 5 characters).',
      ),
    );
    const res = await actions.postCashCountAction({
      bankAccountId: 'a1',
      countDate: '2026-10-21',
      total: '1',
    });
    expect(res).toMatchObject({
      ok: false,
      error: 'Say why the cash does not agree with the books (at least 5 characters).',
      code: 'COUNT_INCOMPLETE',
    });
  });

  it('refuse someone without the permission and count nothing', async () => {
    requirePermission.mockRejectedValue(
      new AccessDeniedError('cash_counts:post', { allowed: false, reason: 'deny-grant' }),
    );
    const res = await actions.postCashCountAction({
      bankAccountId: 'a1',
      countDate: '2026-10-21',
      total: '1',
    });
    expect(res).toMatchObject({ ok: false, forbidden: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('history needs only the read permission and passes the cursor on', async () => {
    list.mockResolvedValue({
      rows: [
        {
          id: 'c1',
          number: 'CCT-1',
          countDate: '2026-10-20',
          countedAmount: '5.00',
          expectedAmount: '5.00',
          difference: '0.00',
          note: null,
          countedBy: 'u',
          createdAt: new Date('2026-10-20T10:00:00Z'),
        },
      ],
      next: 'cur',
    });
    const res = await actions.cashCountHistoryAction('a1', 'before-this');
    expect(requirePermission).toHaveBeenCalledWith('cash_counts:read');
    expect(list).toHaveBeenCalledWith('company-1', 'a1', 'before-this');
    expect(res).toMatchObject({
      ok: true,
      data: { next: 'cur', rows: [{ number: 'CCT-1', counted: '5.00' }] },
    });
  });
});
