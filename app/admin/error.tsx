'use client';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 space-y-3">
      <h2 className="text-white font-semibold">Admin error</h2>
      <p className="text-sm text-zinc-400">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm"
      >
        Retry
      </button>
    </div>
  );
}
