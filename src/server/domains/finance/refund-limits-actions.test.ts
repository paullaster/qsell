import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { NO_LIMITS } from './domain/refund-limits';

const requirePermission = vi.fn();
const canPermission = vi.fn();
const view = vi.fn();
const save = vi.fn();
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
      refundLimits: {
        view: (...a: unknown[]) => view(...a) as unknown,
        save: (...a: unknown[]) => save(...a) as unknown,
      },
    },
  }),
}));

const actions = await import('./refund-actions');

beforeEach(() => {
  for (const f of [requirePermission, canPermission, view, save, revalidatePath]) f.mockReset();
  requirePermission.mockResolvedValue('user-1');
  canPermission.mockResolvedValue(true);
});

describe('the refund limits actions', () => {
  it('show the limits to someone who may read them, and say whether they may change them', async () => {
    view.mockResolvedValue({ values: NO_LIMITS, version: 0, updatedBy: null, updatedAt: null });
    canPermission.mockResolvedValue(false);
    const res = await actions.refundLimitsAction();
    expect(requirePermission).toHaveBeenCalledWith('refund_limits:read');
    expect(res).toMatchObject({ ok: true, data: { version: 0, canManage: false } });
    expect(canPermission).toHaveBeenCalledWith('refund_limits:manage');
  });

  it('save with the manage permission, check the values again on the server, and refresh the page', async () => {
    save.mockResolvedValue({ values: NO_LIMITS, version: 1 });
    const res = await actions.saveRefundLimitsAction(
      { ...NO_LIMITS, enabled: true, maxPerCustomer: 2 },
      0,
    );
    expect(requirePermission).toHaveBeenCalledWith('refund_limits:manage');
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1' }),
      { ...NO_LIMITS, enabled: true, maxPerCustomer: 2 },
      0,
    );
    expect(res).toMatchObject({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/finance/refunds/limits');
  });

  it('refuse values the form would refuse, whatever the browser sent', async () => {
    const bad = await actions.saveRefundLimitsAction(
      { ...NO_LIMITS, enabled: true, maxPerCustomer: 0 },
      0,
    );
    expect(bad).toMatchObject({ ok: false, code: 'LIMITS_INVALID' });
    const none = await actions.saveRefundLimitsAction({ ...NO_LIMITS, enabled: true }, 0);
    expect(none).toMatchObject({
      ok: false,
      error: 'Set at least one limit, or switch the limits off.',
    });
    const window = await actions.saveRefundLimitsAction(
      { ...NO_LIMITS, enabled: true, maxPerCustomer: 1, windowHours: 9999 },
      0,
    );
    expect(window).toMatchObject({ ok: false });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuse someone without the permission', async () => {
    requirePermission.mockRejectedValue(
      new AccessDeniedError('refund_limits:manage', { allowed: false, reason: 'deny-grant' }),
    );
    const res = await actions.saveRefundLimitsAction(
      { ...NO_LIMITS, enabled: true, maxPerCustomer: 1 },
      0,
    );
    expect(res).toMatchObject({ ok: false, forbidden: true });
    expect(save).not.toHaveBeenCalled();
  });
});
