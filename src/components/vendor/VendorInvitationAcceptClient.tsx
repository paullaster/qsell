'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { vendorInvitationPreviewAction, acceptVendorInvitationAction, type InvitationPreview } from '@/server/domains/vendors/invitation-actions';
import { PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { logoutAction } from '@/server/domains/auth/actions';
import { Field, buttonClass, fieldClass, primaryClass } from '@/components/ui/screen-kit';

type View = 'loading' | 'ready' | 'accepted' | 'invalid';

const roleWord = (role: string): string => ({ owner: 'Vendor account owner', finance: 'Finance team member', sales: 'Sales team member', readonly: 'Read-only team member' })[role] ?? 'Vendor team member';

/** Accepts a secret-link invitation and creates vendor access only after the recipient proves control of the link. */
export function VendorInvitationAcceptClient({ token }: { token: string }) {
  const [view, setView] = useState<View>('loading');
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignOut, setNeedsSignOut] = useState(false);
  const [acceptedExistingAccount, setAcceptedExistingAccount] = useState(false);
  const [linkedCurrentSession, setLinkedCurrentSession] = useState(false);

  useEffect(() => {
    let current = true;
    vendorInvitationPreviewAction({ token }).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setError(result.error);
        setView('invalid');
        return;
      }
      setInvitation(result.data);
      setView('ready');
    }).catch(() => {
      if (current) {
        setError('We could not check this invitation. Please try again.');
        setView('invalid');
      }
    });
    return () => { current = false; };
  }, [token]);

  const accept = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    const result = await acceptVendorInvitationAction({ token, password }).catch(() => ({ ok: false as const, error: 'We could not accept this invitation. Please try again.' }));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setNeedsSignOut('needsSignOut' in result && result.needsSignOut === true);
      return;
    }
    setAcceptedExistingAccount(result.data.existingAccount);
    setLinkedCurrentSession(result.data.sessionLinked);
    setView('accepted');
  };

  if (view === 'loading') return <p role="status" className="mx-auto max-w-md rounded-xl border border-line bg-surface-raised p-5 text-sm text-fg-muted">Checking your invitation…</p>;
  if (view === 'invalid') return (
    <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
      <h1 className="text-xl font-bold text-fg-strong">Invitation unavailable</h1>
      <p role="alert" className="text-sm text-fg-muted">{error ?? 'This invitation is invalid or expired. Ask the buyer to send a fresh invitation.'}</p>
      <Link href="/login?callbackUrl=%2Fvendor" className={buttonClass}>Go to vendor sign in</Link>
    </section>
  );
  if (view === 'accepted') return (
    <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
      <h1 className="text-xl font-bold text-fg-strong">You have joined {invitation?.businessName ?? 'the vendor business'}</h1>
      <p className="text-sm text-fg-muted">{acceptedExistingAccount ? 'Your existing qsell account is now linked to the vendor portal.' : `Your vendor portal access is ready. Sign in with ${invitation?.email ?? 'your invited email'} to see your next steps.`}</p>
      {acceptedExistingAccount && linkedCurrentSession ? <form action={logoutAction}><input type="hidden" name="returnTo" value="/login" /><button type="submit" className={primaryClass}>Sign out and refresh vendor access</button></form> : <Link href="/login?callbackUrl=%2Fvendor" className={primaryClass}>Sign in to the vendor portal</Link>}
    </section>
  );
  if (invitation === null) return null;

  let invitationAction: ReactNode;
  if (invitation.existingAccountUnavailable) {
    invitationAction = <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-fg">This email already belongs to a qsell account that cannot be linked to a vendor login. Contact the buyer and ask them to invite an email address that is not already used by another qsell account.</p>;
  } else if (invitation.existingAccount) {
    invitationAction = (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">This invitation matches an existing qsell account. Sign in to that account to accept; your current password stays the same.</p>
        <Link href={`/login?callbackUrl=${encodeURIComponent(`/vendor/invitations/accept?token=${token}`)}`} className={buttonClass}>Sign in to accept</Link>
        <button type="button" className={primaryClass} disabled={busy} onClick={() => void accept()}>{busy ? 'Linking account…' : 'Accept invitation and link this account'}</button>
      </div>
    );
  } else if (invitation.signedIn === true) {
    invitationAction = (
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">You are signed in with another qsell account. This invitation creates a separate vendor login. Sign out first; your invitation link will be waiting when you return.</p>
        <form action={logoutAction}>
          <input type="hidden" name="returnTo" value={`/vendor/invitations/accept?token=${token}`} />
          <button type="submit" className={primaryClass}>Sign out and continue invitation</button>
        </form>
      </div>
    );
  } else {
    invitationAction = (
      <form onSubmit={(event) => void accept(event)} className="space-y-3">
        <Field id="invitation-password" label="Choose a password" hint={`Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`}>
          <PasswordInput id="invitation-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" className={fieldClass} required />
        </Field>
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Joining…' : 'Accept and create vendor sign-in'}</button>
        <p className="text-xs text-fg-muted">Your invitation makes a vendor portal login. It does not change the business classification or financial details qsell has for the vendor.</p>
      </form>
    );
  }

  return (
    <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
      <div>
        <h1 className="text-xl font-bold text-fg-strong">Join {invitation.businessName}</h1>
        <p className="mt-1 text-sm text-fg-muted">Hello {invitation.name}. You were invited as a {roleWord(invitation.role).toLowerCase()} using {invitation.email}. This link expires {new Date(invitation.expiresAt).toLocaleDateString()}.</p>
      </div>
      {error === null ? null : <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700">{error}</p>}
      {needsSignOut ? <form action={logoutAction}><input type="hidden" name="returnTo" value={`/vendor/invitations/accept?token=${token}`} /><button type="submit" className={buttonClass}>Sign out and return to invitation</button></form> : null}
      {invitationAction}
    </section>
  );
}
