import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

// The token is a credential in the URL; never leak it to other origins via Referer.
export const metadata: Metadata = { title: 'Choose a new password', referrer: 'no-referrer' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      {typeof token === 'string' && token !== '' ? (
        <ResetPasswordForm token={token} />
      ) : (
        <section className="mx-auto w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-6">
          <h1 className="text-xl font-bold text-fg-strong">Reset link missing</h1>
          <p className="text-sm text-fg-muted">
            Open the link from your password reset email, or request a new one.
          </p>
          <Link
            href="/forgot-password"
            className="flex min-h-12 w-full items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Request a reset link
          </Link>
        </section>
      )}
    </div>
  );
}
