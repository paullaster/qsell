import Form from 'next/form';
import Link from 'next/link';
import { Search } from 'lucide-react';

/** Inside the shop's frame, so a missing page still has the header, the search and the footer to get back with. */
export default function StoreNotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-6 py-16 text-center">
      <p className="text-sm font-semibold tracking-wide text-indigo-500 uppercase">Error 404</p>
      <h1 className="text-3xl font-bold tracking-tight text-fg-strong">We could not find that page</h1>
      <p className="text-base text-fg-muted">The product or page may have been moved or is no longer for sale. Try searching, or go back to the shop.</p>
      <Form action="/" role="search" className="relative mx-auto max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <input type="text" name="q" aria-label="Search the shop" placeholder="Search products" maxLength={100} className="h-12 w-full rounded-xl border border-line bg-surface-raised pr-4 pl-10 text-base text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40" />
      </Form>
      <Link href="/" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500">
        Back to the shop
      </Link>
    </div>
  );
}
