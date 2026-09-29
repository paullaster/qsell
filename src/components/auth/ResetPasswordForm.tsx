'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { resetPasswordAction } from '@/server/domains/auth/actions';
import { PASSWORD_MIN_LENGTH, validatePassword } from '@/lib/passwordPolicy';
import { PasswordInput } from '@/components/auth/PasswordInput';

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const problem = validatePassword(password);
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (password !== confirmation) {
      setError('The two passwords don’t match.');
      return;
    }
    startTransition(async () => {
      try {
        setError(null);
        const result = await resetPasswordAction({ token, password });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPassword('');
        setConfirmation('');
        setDone(true);
      } catch {
        setError('We couldn’t reset your password right now. Check your connection and try again.');
      }
    });
  };

  if (done) {
    return (
      <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
        <CheckCircle2 className="h-8 w-8 text-emerald-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">Password updated</h1>
        <p className="text-sm text-fg-muted">You can now sign in with your new password.</p>
        <Link
          href="/login"
          className="flex min-h-12 w-full touch-manipulation items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Sign in
        </Link>
      </section>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6"
    >
      <h1 className="text-xl font-bold text-fg-strong">Choose a new password</h1>
      <p className="text-xs text-fg-muted">
        Use at least {PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong,
        memorable password.
      </p>
      <label htmlFor="reset-password" className="sr-only">
        New password
      </label>
      <PasswordInput
        id="reset-password"
        name="password"
        required
        autoComplete="new-password"
        enterKeyHint="next"
        minLength={PASSWORD_MIN_LENGTH}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="New password"
      />
      <label htmlFor="reset-password-confirm" className="sr-only">
        Confirm new password
      </label>
      <PasswordInput
        id="reset-password-confirm"
        name="passwordConfirmation"
        required
        autoComplete="new-password"
        enterKeyHint="go"
        minLength={PASSWORD_MIN_LENGTH}
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        placeholder="Confirm new password"
      />
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
        className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? 'Please wait…' : 'Update password'}
      </button>
      <p className="text-center text-xs text-fg-muted">
        Link expired?{' '}
        <Link
          href="/forgot-password"
          className="font-medium text-fg-strong underline underline-offset-2 hover:text-indigo-500"
        >
          Request a new one
        </Link>
      </p>
    </form>
  );
}
