'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginAction, registerCustomerAction } from '@/server/domains/auth/actions';
import { isStaffRole } from '@/server/domains/auth/roles';

export function AuthForm({ mode = 'login' }: { mode?: 'login' | 'register' }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl');
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
          router.push(callbackUrl && callbackUrl.startsWith('/') ? callbackUrl : '/');
          router.refresh();
          return;
        }
        const res = await loginAction({ email, password });
        const safeCallback =
          callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//')
            ? callbackUrl
            : null;
        if (isStaffRole(res.role)) {
          // Staff must land in admin — ignore storefront callback leftovers (e.g. "/").
          router.push(safeCallback?.startsWith('/admin') ? safeCallback : '/admin');
        } else if (safeCallback) {
          router.push(safeCallback);
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
      <p className="text-center text-xs text-fg-subtle">
        {isRegister ? (
          <>
            Already have an account?{' '}
            <Link href="/login" className="text-indigo-400 hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            Need an account?{' '}
            <Link href="/register" className="text-indigo-400 hover:underline">
              Register
            </Link>
            {' · '}
            <Link href="/" className="text-fg-muted hover:underline">
              Continue as guest
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
