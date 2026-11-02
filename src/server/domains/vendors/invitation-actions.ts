'use server';

import { headers } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { randomUUID } from 'node:crypto';
import { auth } from '@/auth';
import { validatePassword } from '@/lib/passwordPolicy';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isRecord } from '@/lib/values';
import { getContainer } from '@/server/di/container';
import { ProfileError } from './profile-service';

export type InvitationResult<T> = { ok: true; data: T } | { ok: false; error: string; needsSignOut?: true };

export interface InvitationPreview {
  name: string;
  email: string;
  role: string;
  businessName: string;
  expiresAt: string;
  existingAccount: boolean;
  existingAccountUnavailable: boolean;
  /** Whether the viewer must sign out before creating a distinct vendor login. */
  signedIn?: boolean;
}

const tokenOf = (raw: unknown): string => {
  if (!isRecord(raw) || typeof raw.token !== 'string' || raw.token.length > 100) return '';
  return raw.token;
};

async function rateLimited(): Promise<string | null> {
  const h = await headers();
  const result = await getContainer().rateLimits.hit('register_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  return result.allowed ? null : waitMessage(result.retryAfterSeconds);
}

export async function vendorInvitationPreviewAction(raw: unknown): Promise<InvitationResult<InvitationPreview>> {
  const token = tokenOf(raw);
  if (token === '') return { ok: false, error: 'This invitation link is invalid or has expired. Ask the buyer to send a fresh invitation.' };
  const wait = await rateLimited();
  if (wait !== null) return { ok: false, error: wait };
  try {
    const data = await getContainer().vendorInvitations.preview(token);
    return data === null
      ? { ok: false, error: 'This invitation link is invalid or has expired. Ask the buyer to send a fresh invitation.' }
      : { ok: true, data: { ...data, signedIn: (await auth()) !== null } };
  } catch (error) {
    console.error('[vendor.invitation.preview]', error);
    return { ok: false, error: 'We could not check this invitation just now. Please try again.' };
  }
}

export async function acceptVendorInvitationAction(raw: unknown): Promise<InvitationResult<{ existingAccount: boolean; sessionLinked: boolean }>> {
  const token = tokenOf(raw);
  const password = isRecord(raw) && typeof raw.password === 'string' ? raw.password : '';
  if (token === '') return { ok: false, error: 'This invitation link is invalid or has expired. Ask the buyer to send a fresh invitation.' };
  const wait = await rateLimited();
  if (wait !== null) return { ok: false, error: wait };
  const requestId = randomUUID();
  try {
    const invitations = getContainer().vendorInvitations;
    const session = await auth();
    const preview = await invitations.preview(token);
    if (preview === null) return { ok: false, error: 'This invitation link is invalid or has expired. Ask the buyer to send a fresh invitation.' };
    if (preview.existingAccountUnavailable) return { ok: false, error: 'This existing qsell login cannot be linked to this vendor account. Contact the buyer to arrange a new portal email or account review.' };
    if (!preview.existingAccount) {
      if (session !== null) return { ok: false, error: 'Sign out before accepting this invitation. It creates a separate vendor portal login.' };
      const problem = validatePassword(password);
      if (problem !== null) return { ok: false, error: problem };
    }
    const sessionUserId = preview.existingAccount ? (session?.user.id ?? null) : null;
    const existingAccount = await invitations.accept(token, password, sessionUserId);
    return { ok: true, data: { existingAccount, sessionLinked: existingAccount && sessionUserId !== null } };
  } catch (error) {
    if (error instanceof ProfileError) {
      return error.code === 'ACCOUNT_MISMATCH'
        ? { ok: false, error: error.message, needsSignOut: true }
        : { ok: false, error: error.message };
    }
    console.error('[vendor.invitation.accept]', { requestId, error });
    Sentry.captureException(error, { tags: { area: 'vendor', action: 'invitation_accept' }, extra: { requestId } });
    return { ok: false, error: `We could not accept this invitation. Please try again or contact the buyer with reference ${requestId}.` };
  }
}
