'use client';

import React, { useId, useState, useTransition } from 'react';
import { KeyRound } from 'lucide-react';
import { changeOwnPasswordAction, logoutAction } from '@/server/domains/auth/actions';
import { PASSWORD_MIN_LENGTH, validatePassword } from '@/lib/passwordPolicy';
import { PasswordInput } from '@/components/auth/PasswordInput';

export function ChangePasswordForm({
  email,
  forced,
  callbackUrl,
}: {
  email: string;
  /** True when an admin set the current password and the user may not skip this step. */
  forced: boolean;
  callbackUrl: string | null;
}) {
  const hintId = useId();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const problem = validatePassword(newPassword);
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (newPassword !== confirmation) {
      setError('The new passwords don’t match.');
      return;
    }
    startTransition(async () => {
      try {
        setError(null);
        const result = await changeOwnPasswordAction({ currentPassword, newPassword });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const fallback = result.isStaff ? '/admin' : '/';
        // Full navigation so every part of the app picks up the re-issued session.
        window.location.assign(callbackUrl ?? fallback);
      } catch {
        setError(
          'We couldn’t change your password right now. Check your connection and try again.',
        );
      }
    });
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-3">
      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-2xl border border-line bg-surface-raised p-6"
        aria-describedby={hintId}
      >
        <KeyRound className="h-8 w-8 text-indigo-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">
          {forced ? 'Set your own password' : 'Change your password'}
        </h1>
        <p id={hintId} className="text-sm text-fg-muted">
          {forced ? (
            <>
              Your account <strong className="text-fg-strong">{email}</strong> was set up with a
              temporary password. Choose your own to continue.
            </>
          ) : (
            <>
              Signed in as <strong className="text-fg-strong">{email}</strong>.
            </>
          )}{' '}
          Use at least {PASSWORD_MIN_LENGTH} characters.
        </p>

        {/* Lets password managers attach the new password to the right account. */}
        <input type="hidden" name="username" autoComplete="username" value={email} />

        <div className="space-y-1">
          <label htmlFor="current-password" className="text-xs font-medium text-fg-muted">
            {forced ? 'Temporary password' : 'Current password'}
          </label>
          <PasswordInput
            id="current-password"
            name="currentPassword"
            required
            autoComplete="current-password"
            enterKeyHint="next"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new-password" className="text-xs font-medium text-fg-muted">
            New password
          </label>
          <PasswordInput
            id="new-password"
            name="newPassword"
            required
            autoComplete="new-password"
            enterKeyHint="next"
            minLength={PASSWORD_MIN_LENGTH}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="confirm-password" className="text-xs font-medium text-fg-muted">
            Confirm new password
          </label>
          <PasswordInput
            id="confirm-password"
            name="confirmPassword"
            required
            autoComplete="new-password"
            enterKeyHint="go"
            minLength={PASSWORD_MIN_LENGTH}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </div>

        {error !== null ? (
          <p
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="min-h-11 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? 'Please wait…' : 'Save new password'}
        </button>
      </form>

      <form action={logoutAction} className="text-center">
        <input type="hidden" name="returnTo" value="/login" />
        <button
          type="submit"
          className="min-h-11 px-3 text-xs font-medium text-fg-muted underline underline-offset-2 hover:text-fg-strong"
        >
          Not you? Sign out
        </button>
      </form>
    </div>
  );
}
