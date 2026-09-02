'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <h2 className="text-xl font-semibold text-white">Something went wrong</h2>
        <p className="text-sm text-zinc-400">{error.message || 'Unexpected error'}</p>
        <button
          type="button"
          onClick={reset}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-500"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
