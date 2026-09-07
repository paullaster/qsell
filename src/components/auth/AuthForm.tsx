'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginAction, registerCustomerAction } from '@/server/domains/auth/actions';

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
        if (safeCallback) {
          router.push(safeCallback);
        } else {
          router.push(res.role === 'admin' || res.role === 'manager' ? '/admin' : '/');
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
      <h1 className="text-xl font-bold text-white">{isRegister ? 'Create account' : 'Sign in'}</h1>
      <p className="text-xs text-zinc-400">
        Guests can still checkout without an account. Sign in to save addresses and order history.
      </p>
      {isRegister ? (
        <>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone (optional)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
          />
        </>
      ) : null}
      <input
        required
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
      />
      <input
        required
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        minLength={8}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white"
      />
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
      </button>
      <p className="text-center text-xs text-zinc-500">
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
            <Link href="/" className="text-zinc-400 hover:underline">
              Continue as guest
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
