'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { requestPasswordResetAction } from '@/server/domains/auth/actions';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        setError(null);
        const normalized = email.trim().toLowerCase();
        const result = await requestPasswordResetAction({ email: normalized });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSentTo(normalized);
      } catch {
        setError(
          'We couldn’t send the reset email right now. Check your connection and try again.',
        );
      }
    });
  };

  if (sentTo !== null) {
    return (
      <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
        <MailCheck className="h-8 w-8 text-indigo-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">Check your email</h1>
        <p className="text-sm text-fg-muted">
          If an account exists for <strong className="text-fg-strong">{sentTo}</strong>, we’ve sent
          a link to reset your password. It expires in 1 hour. Check your spam folder if it doesn’t
          arrive within a few minutes.
        </p>
        <Link
          href="/login"
          className="flex min-h-12 w-full touch-manipulation items-center justify-center rounded-xl border border-line-strong bg-surface px-4 py-3 text-sm font-semibold text-fg-strong transition-colors hover:border-indigo-500 hover:bg-hover"
        >
          Back to sign in
        </Link>
      </section>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6"
    >
      <h1 className="text-xl font-bold text-fg-strong">Reset your password</h1>
      <p className="text-xs text-fg-muted">
        Enter the email address you signed up with and we’ll send you a link to choose a new
        password.
      </p>
      <label htmlFor="forgot-email" className="sr-only">
        Email address
      </label>
      <input
        id="forgot-email"
        name="email"
        required
        type="email"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="email"
        enterKeyHint="send"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
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
        {pending ? 'Please wait…' : 'Send reset link'}
      </button>
      <p className="text-center text-xs text-fg-muted">
        Remembered it?{' '}
        <Link
          href="/login"
          className="font-medium text-fg-strong underline underline-offset-2 hover:text-indigo-500"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
