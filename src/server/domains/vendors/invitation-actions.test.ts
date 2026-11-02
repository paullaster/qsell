import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationPreview } from './invitation-actions';

const { container, auth } = vi.hoisted(() => ({
  container: {
    rateLimits: { hit: vi.fn<(rule: string, subject: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }>>() },
    vendorInvitations: {
      preview: vi.fn<(token: string) => Promise<InvitationPreview | null>>(),
      accept: vi.fn<(token: string, password: string, userId: string | null) => Promise<boolean>>(),
    },
  },
  auth: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
}));

vi.mock('@/server/di/container', () => ({ getContainer: () => container }));
vi.mock('@/auth', () => ({ auth }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

describe('vendor invitation actions', () => {
  beforeEach(() => {
    container.rateLimits.hit.mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    container.vendorInvitations.preview.mockReset();
    container.vendorInvitations.accept.mockReset().mockResolvedValue(false);
    auth.mockReset().mockResolvedValue(null);
  });

  it('previews only the opaque invitation token and returns a non-specific unavailable response', async () => {
    const { vendorInvitationPreviewAction } = await import('./invitation-actions');
    container.vendorInvitations.preview.mockResolvedValue(null);
    const result = await vendorInvitationPreviewAction({ token: 'short' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid or has expired');
    expect(container.vendorInvitations.preview).toHaveBeenCalledWith('short');
    expect(container.rateLimits.hit).toHaveBeenCalledOnce();
  });

  it('validates new-user passwords before accepting and passes no client-supplied account identity', async () => {
    const { acceptVendorInvitationAction } = await import('./invitation-actions');
    const token = 'a'.repeat(43);
    container.vendorInvitations.preview.mockResolvedValue({ name: 'Invited User', email: 'invite@example.test', role: 'owner', businessName: 'Example Vendor', expiresAt: new Date(Date.now() + 60_000).toISOString(), existingAccount: false, existingAccountUnavailable: false });
    expect(await acceptVendorInvitationAction({ token, password: 'short' })).toMatchObject({ ok: false });
    expect(container.vendorInvitations.accept).not.toHaveBeenCalled();

    expect(await acceptVendorInvitationAction({ token, password: 'Strong-password-123!' })).toEqual({
      ok: true,
      data: { existingAccount: false, sessionLinked: false },
    });
    expect(container.vendorInvitations.accept).toHaveBeenCalledWith(token, 'Strong-password-123!', null);
  });

  it('requires an existing signed-in user to sign out before creating a new invite login', async () => {
    auth.mockResolvedValue({ user: { id: 'signed-in' } });
    container.vendorInvitations.preview.mockResolvedValue({ name: 'Invited User', email: 'invite@example.test', role: 'owner', businessName: 'Example Vendor', expiresAt: new Date(Date.now() + 60_000).toISOString(), existingAccount: false, existingAccountUnavailable: false });
    const { acceptVendorInvitationAction } = await import('./invitation-actions');
    const result = await acceptVendorInvitationAction({ token: 'a'.repeat(43), password: 'Strong-password-123!' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Sign out before accepting');
    expect(container.vendorInvitations.accept).not.toHaveBeenCalled();
  });

  it('links an existing account only after explicit acceptance with that signed-in identity', async () => {
    auth.mockResolvedValue({ user: { id: 'existing-vendor' } });
    container.vendorInvitations.preview.mockResolvedValue({ name: 'Invited User', email: 'vendor@example.test', role: 'finance', businessName: 'Example Vendor', expiresAt: new Date(Date.now() + 60_000).toISOString(), existingAccount: true, existingAccountUnavailable: false });
    container.vendorInvitations.accept.mockResolvedValue(true);
    const { acceptVendorInvitationAction } = await import('./invitation-actions');
    const result = await acceptVendorInvitationAction({ token: 'a'.repeat(43), password: '' });
    expect(result).toEqual({ ok: true, data: { existingAccount: true, sessionLinked: true } });
    expect(container.vendorInvitations.accept).toHaveBeenCalledWith('a'.repeat(43), '', 'existing-vendor');
  });

});
