import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { ReturnError } from './return-receipt-service';

const requirePermission = vi.fn();
const canPermission = vi.fn();
const detail = vi.fn();
const confirm = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
  canPermission: (...args: unknown[]) => canPermission(...args) as unknown,
}));
vi.mock('@/server/domains/finance/action-runner', () => ({
  injectedDelay: () => Promise.resolve(),
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'company-1' }) },
    reasonCodes: { ensureSystemReasons: () => Promise.resolve() },
    returns: {
      detail: (...a: unknown[]) => detail(...a) as unknown,
      confirm: (...a: unknown[]) => confirm(...a) as unknown,
    },
  }),
}));

const actions = await import('./actions');

beforeEach(() => {
  for (const f of [requirePermission, canPermission, detail, confirm]) f.mockReset();
  requirePermission.mockResolvedValue('user-1');
  canPermission.mockResolvedValue(true);
});

const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  productId: 'fish',
  description: 'Fish',
  expectedQty: 20,
  receivedQty: 10,
  unitCost: '200.0000',
  unitId: null,
  unitCode: null,
  qtyPerUnit: null,
  ...over,
});
const head = {
  r: {
    id: 'r1',
    number: 'RR-1',
    status: 'partially_confirmed',
    closedAt: null,
    closeReasonCode: null,
    closeReasonText: null,
  },
  creditNoteNo: 'CN-1',
  sourceRef: 'O-1',
  reasonCode: 'returned_goods',
};

describe('a return in the unit the goods were sold in', () => {
  it('shows what is expected and received in crates, with the unit to count in', async () => {
    detail.mockResolvedValue({
      ...head,
      lines: [line({ unitId: 'crate', unitCode: 'CRATE', qtyPerUnit: '20.0000000000' })],
      confirmations: [
        {
          id: 5,
          lineId: 'l1',
          quantity: 10,
          condition: 'good',
          disposition: 'return_to_stock',
          stockAdded: true,
          note: null,
          confirmedBy: 'u',
          createdAt: new Date('2026-10-20T08:00:00Z'),
        },
      ],
    });
    const res = await actions.returnDetailAction('r1');
    expect(requirePermission).toHaveBeenCalledWith('return_receipts:read');
    if (!res.ok) throw new Error(res.error);
    expect(res.data.lines[0]).toMatchObject({
      expected: 20,
      received: 10,
      unit: { id: 'crate', code: 'CRATE' },
      perUnit: 20,
      expectedWords: '1 CRATE',
      receivedWords: '0.5 CRATE',
    });
    expect(res.data.confirmations[0]).toMatchObject({ quantity: 10, words: '0.5 CRATE' });
  });

  it('shows plain numbers for goods sold in the base unit', async () => {
    detail.mockResolvedValue({ ...head, lines: [line()], confirmations: [] });
    const res = await actions.returnDetailAction('r1');
    if (!res.ok) throw new Error(res.error);
    expect(res.data.lines[0]).toMatchObject({
      unit: null,
      perUnit: 1,
      expectedWords: '20',
      receivedWords: '10',
    });
  });

  it('confirms with the permission to restock, passing the unit through, and answers refusals as data', async () => {
    confirm.mockResolvedValue({ status: 'confirmed', stockAdded: 10 });
    const items = [
      {
        lineId: 'l1',
        quantity: 0.5,
        unitId: 'crate',
        condition: 'good' as const,
        disposition: 'return_to_stock' as const,
      },
    ];
    expect(await actions.confirmReturnAction('r1', items)).toEqual({
      ok: true,
      data: { status: 'confirmed', stockAdded: 10 },
    });
    expect(requirePermission).toHaveBeenCalledWith('restock:confirm');
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', actorId: 'user-1' }),
      'r1',
      items,
    );
    confirm.mockRejectedValue(
      new ReturnError('OVER_RECEIVED', 'Fish: 10 still expected, you entered 20.'),
    );
    expect(await actions.confirmReturnAction('r1', items)).toMatchObject({
      ok: false,
      error: 'Fish: 10 still expected, you entered 20.',
      code: 'OVER_RECEIVED',
    });
    requirePermission.mockRejectedValue(
      new AccessDeniedError('restock:confirm', { allowed: false, reason: 'deny-grant' }),
    );
    expect(await actions.confirmReturnAction('r1', items)).toMatchObject({
      ok: false,
      forbidden: true,
    });
  });
});
