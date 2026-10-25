'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, MailCheck, UserPlus } from 'lucide-react';
import {
  loginAction,
  registerCustomerAction,
  resendVerificationEmailAction,
} from '@/server/domains/auth/actions';
import { PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';
import { PasswordInput } from '@/components/auth/PasswordInput';

export function AuthForm({ mode = 'login' }: { mode?: 'login' | 'register' }) {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl');
  const safeCallbackUrl =
    callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//')
      ? callbackUrl
      : null;
  const authHref = (targetMode: 'login' | 'register') =>
    `/${targetMode}${safeCallbackUrl ? `?callbackUrl=${encodeURIComponent(safeCallbackUrl)}` : ''}`;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isRegister = mode === 'register';

  const onSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        setError(null);
        setNeedsVerification(false);
        if (isRegister) {
          const result = await registerCustomerAction({ name, email, phone, password });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setPassword('');
          setRegisteredEmail(email.trim().toLowerCase());
          return;
        }
        const res = await loginAction({ email: email.trim().toLowerCase(), password });
        if (!res.ok) {
          setError(res.error);
          setNeedsVerification(res.code === 'EMAIL_NOT_VERIFIED');
          return;
        }
        let destination: string;
        if (res.role === 'vendor') {
          destination = safeCallbackUrl?.startsWith('/vendor') === true ? safeCallbackUrl : '/vendor';
        } else if (res.isStaff) {
          // Staff must land in admin — ignore storefront callback leftovers (e.g. "/").
          destination = safeCallbackUrl?.startsWith('/admin') === true ? safeCallbackUrl : '/admin';
        } else {
          // Shoppers never land on admin routes, even if a stale callback points there.
          destination =
            safeCallbackUrl !== null && !safeCallbackUrl.startsWith('/admin')
              ? safeCallbackUrl
              : '/';
        }
        // A full navigation, not router.push: signing in changes the session for the
        // whole app, and parts of it (the storefront navbar, cart, account) read the
        // session once on load. A soft navigation left them showing "signed out" and,
        // from the sign-in popup, never completed at all.
        window.location.assign(
          res.mustChangePassword
            ? `/change-password?callbackUrl=${encodeURIComponent(destination)}`
            : destination,
        );
      } catch (err) {
        setError(
          isRegister
            ? 'We couldn’t create your account right now. Please try again.'
            : 'We couldn’t sign you in right now. Check your connection and try again.',
        );
      }
    });
  };

  if (registeredEmail !== null) {
    return (
      <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
        <MailCheck className="h-8 w-8 text-indigo-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-fg-strong">Check your email</h1>
        <p className="text-sm text-fg-muted">
          We sent a confirmation link to{' '}
          <strong className="text-fg-strong">{registeredEmail}</strong>. Open it to activate your
          account, then sign in.
        </p>
        <ResendVerification email={registeredEmail} />
        <Link
          href={authHref('login')}
          className="flex min-h-12 w-full touch-manipulation items-center justify-center rounded-xl border border-line-strong bg-surface px-4 py-3 text-sm font-semibold text-fg-strong transition-colors hover:border-indigo-500 hover:bg-hover"
        >
          Go to sign in
        </Link>
      </section>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6"
    >
      <h1 className="text-xl font-bold text-fg-strong">
        {isRegister ? 'Create account' : 'Sign in'}
      </h1>
      <p className="text-xs text-fg-muted">
        Guests can still checkout without an account. Sign in to save addresses and order history.
      </p>
      {isRegister ? (
        <>
          <label htmlFor="register-name" className="sr-only">
            Full name
          </label>
          <input
            id="register-name"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
          />
          <label htmlFor="register-phone" className="sr-only">
            Phone (optional)
          </label>
          <input
            id="register-phone"
            name="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone (optional)"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
          />
        </>
      ) : null}
      <label htmlFor="auth-email" className="sr-only">
        Email address
      </label>
      <input
        id="auth-email"
        name="email"
        required
        type="email"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="email"
        enterKeyHint="next"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
      />
      <label htmlFor="auth-password" className="sr-only">
        Password
      </label>
      <PasswordInput
        id="auth-password"
        name="password"
        required
        autoComplete={isRegister ? 'new-password' : 'current-password'}
        enterKeyHint="go"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        minLength={isRegister ? PASSWORD_MIN_LENGTH : undefined}
      />
      {isRegister ? null : (
        <div className="-mt-2 text-right">
          <Link
            href="/forgot-password"
            className="text-xs font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300"
          >
            Forgot password?
          </Link>
        </div>
      )}
      {error ? (
        <p
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {needsVerification ? <ResendVerification email={email} /> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
      </button>
      {isRegister ? (
        <div className="border-t border-line pt-4 text-center">
          <p className="mb-2 text-xs text-fg-muted">Already have an account?</p>
          <Link
            href={authHref('login')}
            className="flex min-h-12 w-full touch-manipulation items-center justify-center rounded-xl border border-line-strong bg-surface px-4 py-3 text-sm font-semibold text-fg-strong transition-colors hover:border-indigo-500 hover:bg-hover"
          >
            Sign in
          </Link>
        </div>
      ) : (
        <div className="space-y-3 border-t border-line pt-4">
          <div className="text-center">
            <p className="text-sm font-semibold text-fg-strong">New to the store?</p>
            <p className="mt-1 text-xs text-fg-muted">
              Create an account to save your details and track orders.
            </p>
          </div>
          <Link
            href={authHref('register')}
            className="flex min-h-12 w-full touch-manipulation items-center justify-center gap-2 rounded-xl border-2 border-indigo-600 bg-indigo-600/10 px-4 py-3 text-sm font-bold text-indigo-700 transition-colors hover:bg-indigo-600 hover:text-white dark:text-indigo-300 dark:hover:text-white"
          >
            <UserPlus className="h-4 w-4" />
            <span>Create your account</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="text-center text-xs text-fg-subtle">
            Prefer not to register?{' '}
            <Link
              href="/"
              className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg-strong"
            >
              Continue as guest
            </Link>
          </p>
        </div>
      )}
    </form>
  );
}

function ResendVerification({ email }: { email: string }) {
  const [status, setStatus] = useState<'idle' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const resend = () => {
    startTransition(async () => {
      try {
        const result = await resendVerificationEmailAction({ email });
        setStatus(result.ok ? 'sent' : 'error');
        setMessage(result.ok ? null : result.error);
      } catch {
        setStatus('error');
        setMessage('We couldn’t send the email right now. Please try again.');
      }
    });
  };

  return (
    <div className="space-y-2 text-xs text-fg-muted">
      <button
        type="button"
        onClick={resend}
        disabled={pending}
        className="font-semibold text-indigo-600 underline-offset-2 hover:underline disabled:opacity-50 dark:text-indigo-300"
      >
        {pending ? 'Sending…' : 'Resend confirmation email'}
      </button>
      <p aria-live="polite">
        {status === 'sent'
          ? 'If that address needs confirming, a new link is on its way. It can take a minute to arrive — check spam too.'
          : null}
        {status === 'error' ? message : null}
      </p>
    </div>
  );
}
