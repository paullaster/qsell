import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

const { ensureSeeded, requirePermission } = vi.hoisted(() => ({
  ensureSeeded: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock('@/server/di/container', () => ({
  getContainer: () => ({ companySettings: { ensureSeeded } }),
}));
vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission,
}));
vi.mock('@/server/domains/access-control/engine', () => ({
  AccessDeniedError: class AccessDeniedError extends Error {},
}));
vi.mock('@/server/domains/finance/action-runner', () => ({
  injectedDelay: () => Promise.resolve(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { runSetting } = await import('./action-runner');

const company = { id: 'company-1', primaryColor: '#123456' } as CompanySettingsRow;

beforeEach(() => {
  ensureSeeded.mockReset().mockResolvedValue(company);
  requirePermission.mockReset().mockResolvedValue('user-1');
});

describe('runSetting company context', () => {
  it('passes its authorized company read to the operation instead of requiring a second read', async () => {
    const result = await runSetting('company:manage', ({ company: authorizedCompany }) =>
      Promise.resolve({
        companyId: authorizedCompany.id,
        primaryColor: authorizedCompany.primaryColor,
      }),
    );

    expect(result).toEqual({
      ok: true,
      data: { companyId: 'company-1', primaryColor: '#123456' },
    });
    expect(ensureSeeded).toHaveBeenCalledOnce();
  });
});
