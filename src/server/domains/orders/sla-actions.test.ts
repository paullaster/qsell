import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TARGETS } from '@/lib/order-sla';

const { ensureSeeded, requirePermission, save, settings, open, acknowledge } = vi.hoisted(() => ({
  ensureSeeded: vi.fn(),
  requirePermission: vi.fn(),
  save: vi.fn(),
  settings: vi.fn(),
  open: vi.fn(),
  acknowledge: vi.fn(),
}));
class Denied extends Error {}

vi.mock('@/server/di/container', () => ({
  getContainer: () => ({ companySettings: { ensureSeeded }, orderSla: { save, settings, open, acknowledge } }),
}));
vi.mock('@/server/domains/access-control/guard', () => ({ requirePermission }));
vi.mock('@/server/domains/access-control/engine', () => ({ AccessDeniedError: Denied }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { acknowledgeLateOrderAction, lateOrdersAction, orderTargetsAction, saveOrderTargetsAction } = await import('./sla-actions');

const good = { stage: 'packed', targetMinutes: 120, escalateAfterMinutes: 60, enabled: true };
const form = (over: Record<string, unknown> = {}) => ({ targets: [good], raiseEmails: 'ops@shop.co.ke', escalateEmails: '', ...over });

beforeEach(() => {
  ensureSeeded.mockReset().mockResolvedValue({ id: 'company-1' });
  requirePermission.mockReset().mockResolvedValue('user-1');
  save.mockReset().mockResolvedValue(undefined);
  settings.mockReset().mockResolvedValue({ targets: DEFAULT_TARGETS, raiseEmails: ['a@b.co'], escalateEmails: [] });
  open.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  acknowledge.mockReset().mockResolvedValue(undefined);
});

describe('the order target actions', () => {
  it('each ask for one explicit permission, and answer a refusal as data', async () => {
    await orderTargetsAction();
    await saveOrderTargetsAction(form());
    await lateOrdersAction();
    await acknowledgeLateOrderAction('3f2b6a52-0f6e-4c1c-9a3b-6d3d8d0a9a11', '');
    expect(requirePermission.mock.calls.map((c: unknown[]) => c[0])).toEqual(['orders:sla_manage', 'orders:sla_manage', 'orders:timeline', 'orders:update']);
    requirePermission.mockRejectedValue(new Denied('no'));
    expect(await saveOrderTargetsAction(form())).toEqual({ ok: false, error: 'You do not have permission to do that.', forbidden: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shows every waiting stage with its label and the address lists one per line', async () => {
    const r = await orderTargetsAction();
    expect(r).toMatchObject({ ok: true, data: { raiseEmails: 'a@b.co', escalateEmails: '' } });
    if (r.ok) expect(r.data.targets.find((t) => t.stage === 'payment_started')?.label).toBe('Payment started');
  });

  it('save with the company and the person from the server, and the cleaned values', async () => {
    const r = await saveOrderTargetsAction({ ...form({ raiseEmails: 'Ops@Shop.co.ke, ops@shop.co.ke' }), companyId: 'someone-else', userId: 'mallory' });
    expect(r).toEqual({ ok: true, data: { saved: 1 } });
    expect(save).toHaveBeenCalledWith('company-1', 'user-1', [good], ['ops@shop.co.ke'], []);
  });

  it.each([
    ['no targets', form({ targets: [] })],
    ['not a list', form({ targets: 'all' })],
    ['too many', form({ targets: Array.from({ length: 41 }, () => good) })],
    ['a stage that is finished', form({ targets: [{ ...good, stage: 'completed' }] })],
    ['a target below five minutes', form({ targets: [{ ...good, targetMinutes: 4 }] })],
    ['text for minutes', form({ targets: [{ ...good, targetMinutes: '120' }] })],
    ['a bad address', form({ raiseEmails: 'nope' })],
    ['a bad escalation address', form({ escalateEmails: 'ok@x.co, nope' })],
  ])('refuses %s and saves nothing', async (_name, input) => {
    const r = await saveOrderTargetsAction(input);
    expect(r.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses input that is not an object at all', async () => {
    expect((await saveOrderTargetsAction(null)).ok).toBe(false);
    expect((await saveOrderTargetsAction('x')).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('pass a sane cursor on and drop a silly one', async () => {
    await lateOrdersAction('abc');
    await lateOrdersAction('x'.repeat(401));
    await lateOrdersAction(42);
    expect(open.mock.calls.map((c: unknown[]) => c[1])).toEqual(['abc', null, null]);
  });

  it('acknowledge only a well-formed id, and show the service’s words when it refuses', async () => {
    expect(await acknowledgeLateOrderAction('1 or 1=1', '')).toMatchObject({ ok: false, error: 'That late order could not be found.' });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await acknowledgeLateOrderAction('3f2b6a52-0f6e-4c1c-9a3b-6d3d8d0a9a11', 42)).toEqual({ ok: true, data: { acknowledged: true } });
    expect(acknowledge).toHaveBeenCalledWith('company-1', 'user-1', '3f2b6a52-0f6e-4c1c-9a3b-6d3d8d0a9a11', '');
  });
});
