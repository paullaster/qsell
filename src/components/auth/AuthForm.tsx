'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, UserPlus } from 'lucide-react';
import { loginAction, registerCustomerAction } from '@/server/domains/auth/actions';
import { isStaffRole } from '@/server/domains/auth/roles';

export function AuthForm({ mode = 'login' }: { mode?: 'login' | 'register' }) {
  const router = useRouter();
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
  const [pending, startTransition] = useTransition();
  const isRegister = mode === 'register';

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        setError(null);
        if (isRegister) {
          await registerCustomerAction({ name, email, phone, password });
          router.push(safeCallbackUrl ?? '/');
          router.refresh();
          return;
        }
        const res = await loginAction({ email, password });
        if (isStaffRole(res.role)) {
          // Staff must land in admin — ignore storefront callback leftovers (e.g. "/").
          router.push(safeCallbackUrl?.startsWith('/admin') ? safeCallbackUrl : '/admin');
        } else if (safeCallbackUrl) {
          router.push(safeCallbackUrl);
        } else {
          router.push('/');
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      }
    });
  };

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
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone (optional)"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
          />
        </>
      ) : null}
      <input
        required
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
      />
      <input
        required
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        minLength={8}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
      />
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
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
            <Link href="/" className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg-strong">
              Continue as guest
            </Link>
          </p>
        </div>
      )}
    </form>
  );
}
