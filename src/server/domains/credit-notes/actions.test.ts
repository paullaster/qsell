import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { CreditNoteError } from './service';

const requirePermission = vi.fn();
const issueForOrderGated = vi.fn();
const creditableForOrder = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
}));
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args) as unknown,
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    creditNotes: {
      issueForOrderGated: (...a: unknown[]) => issueForOrderGated(...a) as unknown,
      creditableForOrder: (...a: unknown[]) => creditableForOrder(...a) as unknown,
    },
  }),
}));

const actions = await import('./actions');

beforeEach(() => {
  for (const f of [requirePermission, issueForOrderGated, creditableForOrder, revalidatePath])
    f.mockReset();
  requirePermission.mockResolvedValue('user-1');
});

const note = {
  id: 'cn1',
  creditNoteNo: 'CN-1',
  totalAmount: '9000.00',
  currency: 'KES',
  kraStatus: 'pending',
  reasonCode: 'returned_goods',
  createdAt: new Date('2026-10-20T08:00:00Z'),
};

describe('issuing a credit note in the unit the goods were sold in', () => {
  it('needs the credit note permission and passes the unit on with the typed quantity, from the server side user', async () => {
    issueForOrderGated.mockResolvedValue({ status: 'issued', creditNote: note });
    const res = await actions.issueOrderCreditNoteAction({
      orderId: 'o1',
      lines: [{ productId: 'fish', quantity: 1.5, unitId: 'crate' }],
      reasonCode: 'returned_goods',
      restock: true,
    });
    expect(requirePermission).toHaveBeenCalledWith('credit_notes:create');
    expect(issueForOrderGated).toHaveBeenCalledWith({
      orderId: 'o1',
      lines: [{ productId: 'fish', quantity: 1.5, unitId: 'crate' }],
      reason: { code: 'returned_goods', note: undefined },
      issuedBy: 'user-1',
      restock: true,
    });
    expect(res).toMatchObject({
      ok: true,
      data: { status: 'issued', creditNote: { creditNoteNo: 'CN-1', totalAmount: 9000 } },
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/inventory');
  });

  it('says in words why a quantity was refused, as data', async () => {
    issueForOrderGated.mockRejectedValue(
      new CreditNoteError(
        'INVALID_LINE',
        '"Fish" was sold in CRATE. Credit it in CRATE or in Kilogram.',
      ),
    );
    const res = await actions.issueOrderCreditNoteAction({
      orderId: 'o1',
      lines: [{ productId: 'fish', quantity: 1, unitId: 'sack' }],
      reasonCode: 'returned_goods',
    });
    expect(res).toEqual({
      ok: false,
      error: '"Fish" was sold in CRATE. Credit it in CRATE or in Kilogram.',
    });
  });

  it('refuses without the permission, and does not issue anything', async () => {
    requirePermission.mockRejectedValue(
      new AccessDeniedError('credit_notes:create', { allowed: false, reason: 'deny-grant' }),
    );
    const res = await actions.issueOrderCreditNoteAction({
      orderId: 'o1',
      lines: [{ productId: 'fish', quantity: 1 }],
      reasonCode: 'returned_goods',
    });
    expect(res).toMatchObject({ ok: false, forbidden: true });
    expect(issueForOrderGated).not.toHaveBeenCalled();
  });

  it('offers what can be credited with the unit the goods were sold in', async () => {
    creditableForOrder.mockResolvedValue({
      lines: [{ productId: 'fish', unit: { id: 'crate', code: 'CRATE', qtyPerUnit: '20' } }],
    });
    const res = await actions.getOrderCreditableAction('o1');
    expect(requirePermission).toHaveBeenCalledWith('credit_notes:create');
    expect(res).toMatchObject({ ok: true, data: { lines: [{ unit: { code: 'CRATE' } }] } });
  });
});
