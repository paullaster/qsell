import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { UnitError } from './errors';

const requirePermission = vi.fn();
const page = vi.fn();
const getByIds = vi.fn();
const getById = vi.fn();
const usageOf = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const makeDefault = vi.fn();
const planForProduct = vi.fn();
const getProductById = vi.fn();

vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/domains/finance/action-runner', () => ({
  injectedDelay: () => Promise.resolve(),
}));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'company-1' }) },
    units: { page, getByIds, getById, usageOf },
    unitWriter: { create, update, remove, makeDefault, planForProduct },
    catalog: { getProductById },
  }),
}));

const actions = await import('./actions');
const denied = () =>
  new AccessDeniedError('units:manage', { allowed: false, reason: 'deny-grant' });

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  code: 'KG',
  name: 'Kilogram',
  description: null,
  symbol: 'kg',
  kind: 'mass',
  baseUnitId: null,
  factorToBase: '1.0000000000',
  decimals: 3,
  internationalCode: 'KGM',
  etimsCode: 'KG',
  isDefault: false,
  isActive: true,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
const draft = {
  code: 'KG',
  name: 'Kilogram',
  description: '',
  symbol: '',
  kind: 'mass',
  baseUnitId: '',
  factorToBase: '1',
  decimals: '3',
  internationalCode: '',
  etimsCode: '',
};

beforeEach(() => {
  for (const f of [
    requirePermission,
    page,
    getByIds,
    getById,
    usageOf,
    create,
    update,
    remove,
    makeDefault,
    planForProduct,
    getProductById,
  ])
    f.mockReset();
  requirePermission.mockResolvedValue('user-1');
  getByIds.mockResolvedValue([]);
  usageOf.mockImplementation((ids: string[]) =>
    Promise.resolve(
      Object.fromEntries(
        ids.map((id) => [id, { products: 0, packagings: 0, derivedUnits: 0, documentLines: 0 }]),
      ),
    ),
  );
});

describe('reading units', () => {
  it('needs units:read and answers a page with usage and whether it can be deleted', async () => {
    page.mockResolvedValue({
      rows: [row(), row({ id: 'u2', code: 'G', baseUnitId: 'u1', factorToBase: '0.0010000000' })],
      nextCursor: 'next',
    });
    getByIds.mockResolvedValue([row()]);
    usageOf.mockResolvedValue({
      u1: { products: 2, packagings: 0, derivedUnits: 1, documentLines: 0 },
      u2: { products: 0, packagings: 0, derivedUnits: 0, documentLines: 0 },
    });
    const res = await actions.unitsPageAction({ query: 'k' });
    expect(requirePermission).toHaveBeenCalledWith('units:read');
    expect(res.ok && res.data.nextCursor).toBe('next');
    const [kg, g] = res.ok ? res.data.rows : [];
    expect(kg).toMatchObject({
      code: 'KG',
      canDelete: false,
      usageWords: 'Used by 2 products, 1 other unit',
      kindLabel: 'Mass / weight',
    });
    expect(g).toMatchObject({
      code: 'G',
      baseUnitCode: 'KG',
      factorToBase: '0.001',
      canDelete: true,
      usageWords: null,
    });
    expect(usageOf).toHaveBeenCalledTimes(1);
  });

  it('ignores a kind or state it does not know instead of passing it on', async () => {
    page.mockResolvedValue({ rows: [], nextCursor: null });
    await actions.unitsPageAction({ kind: 'weight; drop table', status: 'both' as 'active' });
    expect(page).toHaveBeenCalledWith({
      query: undefined,
      cursor: undefined,
      kind: undefined,
      status: undefined,
    });
  });

  it('answers a missing unit as data', async () => {
    getById.mockResolvedValue(null);
    expect(await actions.getUnitAction('nope')).toEqual({
      ok: false,
      error: 'That unit of measure does not exist.',
      code: 'NOT_FOUND',
    });
  });
});

describe('changing units', () => {
  it.each([
    ['create', () => actions.createUnitAction(draft)],
    ['update', () => actions.updateUnitAction('u1', 1, draft)],
    ['switch', () => actions.setUnitActiveAction('u1', 1, false)],
    ['default', () => actions.makeDefaultUnitAction('u1')],
    ['delete', () => actions.deleteUnitAction('u1')],
  ])('%s needs units:manage and does nothing without it', async (_name, call) => {
    requirePermission.mockRejectedValue(denied());
    const res = await call();
    expect(requirePermission).toHaveBeenCalledWith('units:manage');
    expect(res).toEqual({
      ok: false,
      error: 'You do not have permission to do that.',
      forbidden: true,
    });
    for (const f of [create, update, remove, makeDefault]) expect(f).not.toHaveBeenCalled();
  });

  it('creates and answers the new unit', async () => {
    create.mockResolvedValue(row());
    const res = await actions.createUnitAction(draft);
    expect(create).toHaveBeenCalledWith(draft);
    expect(res.ok && res.data?.code).toBe('KG');
  });

  it('shows the words of a rule that was not met, and nothing from a failure it does not know', async () => {
    remove.mockRejectedValue(new UnitError('Used by 1 product, so it cannot be deleted.'));
    expect(await actions.deleteUnitAction('u1')).toEqual({
      ok: false,
      error: 'Used by 1 product, so it cannot be deleted.',
      code: 'INVALID',
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    remove.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'));
    const res = await actions.deleteUnitAction('u1');
    expect(res).toEqual({ ok: false, error: 'Something went wrong. Please try again.' });
    log.mockRestore();
  });

  it('turns a database duplicate or reference refusal into plain words', async () => {
    create.mockRejectedValue({ code: '23505' });
    expect(await actions.createUnitAction(draft)).toEqual({
      ok: false,
      error: 'A unit with that code or name already exists.',
    });
    remove.mockRejectedValue({ cause: { code: '23503' } });
    const res = await actions.deleteUnitAction('u1');
    expect(!res.ok && res.error).toMatch(/Switch it off instead/);
  });

  it('switches a unit off by sending its own details with the new state', async () => {
    getById.mockResolvedValue(row({ symbol: 'kg' }));
    update.mockResolvedValue(row({ isActive: false, version: 2 }));
    const res = await actions.setUnitActiveAction('u1', 1, false);
    expect(update).toHaveBeenCalledWith(
      'u1',
      1,
      expect.objectContaining({
        code: 'KG',
        name: 'Kilogram',
        symbol: 'kg',
        decimals: '3',
        factorToBase: '1.0000000000',
      }),
      false,
    );
    expect(res.ok && res.data?.isActive).toBe(false);
  });
});

describe('a product’s units', () => {
  it('checks the choices with products:read and passes the product as the server knows it', async () => {
    getProductById.mockResolvedValue({
      id: 'p1',
      baseUnitId: 'u1',
      stockQuantity: 3,
      reservedQuantity: 0,
    });
    planForProduct.mockResolvedValue({});
    const res = await actions.checkProductUnitsAction({
      productId: 'p1',
      baseUnitId: 'u2',
      packagings: [],
    });
    expect(requirePermission).toHaveBeenCalledWith('products:read');
    expect(res).toEqual({ ok: true, data: true });
    expect(planForProduct).toHaveBeenCalledWith({
      productId: 'p1',
      requestedUnitId: 'u2',
      current: expect.objectContaining({ stockQuantity: 3 }) as unknown,
      packagings: [],
    });
  });

  it('says in words why a change is not allowed', async () => {
    getProductById.mockResolvedValue({ id: 'p1' });
    planForProduct.mockRejectedValue(
      new UnitError(
        'This product already has stock or history counted in its current unit, so the unit cannot be changed.',
      ),
    );
    const res = await actions.checkProductUnitsAction({
      productId: 'p1',
      baseUnitId: 'u2',
      packagings: [],
    });
    expect(!res.ok && res.error).toMatch(/cannot be changed/);
  });

  it('answers a product that does not exist as data', async () => {
    getProductById.mockResolvedValue(null);
    const res = await actions.checkProductUnitsAction({
      productId: 'gone',
      baseUnitId: 'u1',
      packagings: [],
    });
    expect(res).toEqual({ ok: false, error: 'That product does not exist.', code: 'NOT_FOUND' });
    expect((await actions.productUnitsAction('gone')).ok).toBe(false);
  });
});
