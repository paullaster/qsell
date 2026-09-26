import { Suspense } from 'react';
import { AuthForm } from '@/components/auth/AuthForm';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Suspense fallback={<div className="text-sm text-fg-muted">Loading…</div>}>
        <AuthForm mode="login" />
      </Suspense>
    </div>
  );
}
