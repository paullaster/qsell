import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { ChangePasswordForm } from '@/components/auth/ChangePasswordForm';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export const metadata: Metadata = { title: 'Change your password' };

function safeInternalPath(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // Never bounce back here, or the user loops after saving.
  if (value.startsWith('/change-password')) return null;
  return value;
}

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, params] = await Promise.all([auth(), searchParams]);
  const callbackUrl = safeInternalPath(params.callbackUrl);

  const email = session?.user.email;
  if (email === undefined || email === '') {
    const self = `/change-password${callbackUrl === null ? '' : `?callbackUrl=${encodeURIComponent(callbackUrl)}`}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(self)}`);
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <ChangePasswordForm
        email={email}
        forced={session?.user.mustChangePassword === true}
        callbackUrl={callbackUrl}
      />
    </div>
  );
}
