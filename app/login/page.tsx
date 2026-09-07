import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/AuthForm';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4 py-10">
      <Suspense fallback={<div className="text-sm text-zinc-400">Loading…</div>}>
        <AuthForm mode="login" />
      </Suspense>
    </div>
  );
}
