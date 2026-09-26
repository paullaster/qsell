import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="space-y-4 text-center">
        <h2 className="text-xl font-semibold text-fg-strong">Page not found</h2>
        <Link href="/" className="text-sm text-indigo-400 hover:underline">
          Back to storefront
        </Link>
      </div>
    </div>
  );
}
