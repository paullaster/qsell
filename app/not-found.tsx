import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-6">
      <div className="text-center space-y-4">
        <h2 className="text-xl font-semibold text-white">Page not found</h2>
        <Link href="/" className="text-indigo-400 text-sm hover:underline">
          Back to storefront
        </Link>
      </div>
    </div>
  );
}
