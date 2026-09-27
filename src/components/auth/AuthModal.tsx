'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { AuthForm } from '@/components/auth/AuthForm';

export function AuthModal({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const title = mode === 'login' ? 'Welcome back' : 'Create your customer account';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center overflow-y-auto bg-backdrop/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) router.back();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex min-h-dvh w-full flex-col items-center justify-center bg-canvas px-4 py-12 sm:min-h-0 sm:max-w-xl sm:rounded-2xl sm:border sm:border-line sm:bg-surface sm:shadow-2xl"
      >
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Close sign in"
          className="absolute top-4 right-4 flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl border border-line bg-surface-raised text-fg-muted hover:bg-hover hover:text-fg-strong"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="mb-4 w-full max-w-md px-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-500">
            Secure checkout
          </p>
          <p className="mt-1 text-sm text-fg-muted">
            Sign in or create an account, then return to your checkout.
          </p>
        </div>
        <Suspense
          fallback={
            <div className="w-full max-w-md rounded-2xl border border-line bg-surface-raised p-6 text-sm text-fg-muted">
              Loading account form…
            </div>
          }
        >
          <AuthForm mode={mode} />
        </Suspense>
      </section>
    </div>
  );
}
