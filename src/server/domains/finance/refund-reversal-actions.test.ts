import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { OperationRefused } from '@/server/domains/payments/daraja/operations';
import { FinanceError } from './errors';

const requirePermission = vi.fn();
const canPermission = vi.fn();
const prepareReversal = vi.fn();
const request = vi.fn();
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
      refunds: { prepareReversal: (...a: unknown[]) => prepareReversal(...a) as unknown },
    },
    paymentEngine: { disbursements: { request: (...a: unknown[]) => request(...a) as unknown } },
  }),
}));

const actions = await import('./refund-actions');

const plan = {
  providerId: 'p1',
  methodId: 'm1',
  transactionId: 'NLJ7RT61SV',
  amount: '1500.00',
  number: 'RF-1',
  attempt: 1,
};

beforeEach(() => {
  for (const f of [requirePermission, canPermission, prepareReversal, request, revalidatePath])
    f.mockReset();
  requirePermission.mockResolvedValue('user-1');
  canPermission.mockResolvedValue(true);
});

describe("reversing the customer's payment to pay a refund", () => {
  it('needs its own permission, and sends one reversal of the whole payment with the refund as its subject and the same key for a repeat', async () => {
    prepareReversal.mockResolvedValue(plan);
    request.mockResolvedValue({ op: { id: 'op1' }, status: 'queued' });
    const res = await actions.reverseRefundPaymentAction('r1');
    expect(requirePermission).toHaveBeenCalledWith('refunds:reverse_payment');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        providerId: 'p1',
        methodId: 'm1',
        operation: 'reversal',
        preApproved: true,
        input: { transactionId: 'NLJ7RT61SV', amount: '1500', remarks: 'Refund RF-1' },
        requestedBy: 'user-1',
        subject: { type: 'refund', id: 'r1' },
        idempotencyKey: 'refund:r1:reversal:1',
      }),
    );
    expect(res).toMatchObject({ ok: true, data: { operationId: 'op1', status: 'queued' } });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/finance/refunds/r1');
  });

  it('answers a refusal of the rules, or of the payment engine, as data in words', async () => {
    prepareReversal.mockRejectedValue(
      new FinanceError(
        'NOT_REVERSIBLE',
        "A reversal gives back the customer's whole payment. This refund is for a different amount, so pay it another way.",
      ),
    );
    expect(await actions.reverseRefundPaymentAction('r1')).toMatchObject({
      ok: false,
      code: 'NOT_REVERSIBLE',
      error: expect.stringContaining('whole payment'),
    });
    prepareReversal.mockResolvedValue(plan);
    request.mockRejectedValue(
      new OperationRefused(
        'OPERATION_OFF',
        'Reverse a customer payment is switched off for this provider (Settings → Payments).',
      ),
    );
    expect(await actions.reverseRefundPaymentAction('r1')).toMatchObject({
      ok: false,
      code: 'OPERATION_OFF',
      error: expect.stringContaining('switched off'),
    });
  });

  it('refuses someone without the permission and prepares nothing', async () => {
    requirePermission.mockRejectedValue(
      new AccessDeniedError('refunds:reverse_payment', { allowed: false, reason: 'deny-grant' }),
    );
    expect(await actions.reverseRefundPaymentAction('r1')).toMatchObject({
      ok: false,
      forbidden: true,
    });
    expect(prepareReversal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
