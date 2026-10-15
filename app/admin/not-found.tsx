import Link from 'next/link';

export default function AdminNotFound() {
  return (
    <div className="mx-auto max-w-lg space-y-3 rounded-xl border border-dashed border-line-strong p-8 text-center" role="status">
      <h2 className="text-xl font-bold text-fg-strong">Not found</h2>
      <p className="text-sm text-fg-muted">That record does not exist, or the address is wrong. It may have been removed.</p>
      <Link href="/admin" className="inline-flex min-h-10 items-center rounded-lg border border-line-strong bg-surface-sunken px-4 py-2 text-xs font-semibold text-fg hover:bg-hover">
        Back to the dashboard
      </Link>
    </div>
  );
}
