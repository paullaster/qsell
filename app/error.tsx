'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-xl font-semibold text-fg-strong">Something went wrong</h2>
        <p className="text-sm text-fg-muted">{error.message || 'Unexpected error'}</p>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
