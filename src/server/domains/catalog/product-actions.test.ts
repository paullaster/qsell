import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { SettingsError } from '@/server/domains/settings/errors';

const requirePermission = vi.fn();
const createProduct = vi.fn();
const updateProduct = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
  AccessDeniedError,
}));
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args) as unknown,
}));
vi.mock('@/server/domains/finance/action-runner', () => ({
  injectedDelay: () => Promise.resolve(),
}));
vi.mock('@sentry/nextjs', () => ({}));
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/di/container', () => ({
  getContainer: () => ({
    companySettings: { ensureSeeded: () => Promise.resolve({ id: 'company-1' }) },
  }),
}));
vi.mock('./service', () => ({
  CatalogService: {
    createProduct: (...a: unknown[]) => createProduct(...a) as unknown,
    updateProduct: (...a: unknown[]) => updateProduct(...a) as unknown,
  },
}));

const actions = await import('./actions');
const denied = () =>
  new AccessDeniedError('products:create', { allowed: false, reason: 'deny-grant' });

beforeEach(() => {
  for (const f of [requirePermission, createProduct, updateProduct, revalidatePath]) f.mockReset();
  requirePermission.mockResolvedValue('user-1');
});

describe('saving a product answers as data (a thrown error is masked in production)', () => {
  it('returns the saved product, and refreshes the screens that show it', async () => {
    createProduct.mockResolvedValue({ id: 'p1', name: 'Fish' });
    const res = await actions.createProductAction({ name: 'Fish' } as never);
    expect(requirePermission).toHaveBeenCalledWith('products:create');
    expect(res).toEqual({ ok: true, data: { id: 'p1', name: 'Fish' } });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/products');
    updateProduct.mockResolvedValue({ id: 'p1' });
    await actions.updateProductAction('p1', {});
    expect(requirePermission).toHaveBeenCalledWith('products:update');
    expect(revalidatePath).toHaveBeenCalledWith('/product/p1');
  });

  it('says in words why a unit rule refused the save', async () => {
    updateProduct.mockRejectedValue(
      new SettingsError('Stock quantity must be a whole number: it is counted in Piece.'),
    );
    expect(await actions.updateProductAction('p1', { stockQuantity: 2.5 })).toEqual({
      ok: false,
      error: 'Stock quantity must be a whole number: it is counted in Piece.',
      code: 'INVALID',
    });
  });

  it('turns a taken SKU or a unit refusal of the database into plain words, and hides anything else', async () => {
    createProduct.mockRejectedValue({ code: '23505' });
    expect(await actions.createProductAction({} as never)).toEqual({
      ok: false,
      error: 'That SKU, stock code or URL slug is already used by another product.',
    });
    updateProduct.mockRejectedValue({ cause: { code: '23503' } });
    const res = await actions.updateProductAction('p1', {});
    expect(!res.ok && res.error).toMatch(/Switch it off instead/);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createProduct.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(await actions.createProductAction({} as never)).toEqual({
      ok: false,
      error: 'Something went wrong. Please try again.',
    });
    log.mockRestore();
  });

  it('does nothing without the permission', async () => {
    requirePermission.mockRejectedValue(denied());
    expect(await actions.createProductAction({} as never)).toEqual({
      ok: false,
      error: 'You do not have permission to do that.',
      forbidden: true,
    });
    expect(createProduct).not.toHaveBeenCalled();
  });
});
