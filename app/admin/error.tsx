'use client';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-red-900/50 bg-red-50 p-6">
      <h2 className="font-semibold text-fg-strong">Admin error</h2>
      <p className="text-sm text-fg-muted">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white"
      >
        Retry
      </button>
    </div>
  );
}
