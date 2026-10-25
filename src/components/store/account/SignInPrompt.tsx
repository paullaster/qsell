import Link from 'next/link';

export function SignInPrompt({ what }: { what: string }) {
  return (
    <div role="status" className="rounded-xl border border-line bg-surface-raised p-6 text-center">
      <p className="font-medium text-fg-strong">Sign in to see {what}.</p>
      <Link
        href="/login"
        className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
      >
        Sign in
      </Link>
    </div>
  );
}
