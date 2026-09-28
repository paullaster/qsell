'use client';

import { use, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { listApplicationErrorsAction } from '@/server/domains/application-errors/actions';

type ErrorList = Awaited<ReturnType<typeof listApplicationErrorsAction>>;

export function AdminApplicationErrors({
  errorsPromise,
  search,
}: {
  errorsPromise: Promise<ErrorList>;
  search: string;
}) {
  const { rows, total, page, pageSize } = use(errorsPromise);
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState(search);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = new URLSearchParams();
    if (searchTerm.trim()) query.set('search', searchTerm.trim());
    query.set('page', '1');
    router.push(`/admin/application-errors?${query.toString()}`);
  };

  const goToPage = (nextPage: number) => {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    query.set('page', String(nextPage));
    router.push(`/admin/application-errors?${query.toString()}`);
  };

  return (
    <main className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold text-fg-strong">Application Error Logs</h1>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">
            Server errors captured by Next.js, including full error details, route, and digest for
            matching production failures. Logs are retained in the application database.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-fg hover:bg-hover"
        >
          <RefreshCw className="h-4 w-4" /> Refresh logs
        </button>
      </header>

      <form
        onSubmit={submitSearch}
        className="flex flex-col gap-2 rounded-xl border border-line bg-surface-raised p-3 sm:flex-row"
      >
        <label className="relative flex-1">
          <span className="sr-only">Search errors</span>
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search message, digest, path, or error type"
            className="w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Search
        </button>
      </form>

      <section className="overflow-hidden rounded-xl border border-line bg-surface-raised">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 text-sm">
          <span className="font-semibold text-fg-strong">Recent errors</span>
          <span className="text-fg-muted">{total.toLocaleString()} total</span>
        </div>
        {rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-fg-muted">
            {search
              ? 'No application errors match that search.'
              : 'No application errors have been recorded.'}
          </p>
        ) : (
          <div className="divide-y divide-line">
            {rows.map((entry) => (
              <article key={entry.id} className="space-y-3 p-4">
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <h2 className="font-semibold break-words text-red-800 dark:text-red-300">
                      {entry.errorName}: {entry.message}
                    </h2>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
                      <time dateTime={entry.createdAt.toISOString()}>
                        {entry.createdAt.toLocaleString()}
                      </time>
                      <span>
                        {entry.method ?? '—'} {entry.path ?? entry.routePath ?? '—'}
                      </span>
                      <span>{entry.routeType ?? entry.source}</span>
                      {entry.runtime && <span>{entry.runtime}</span>}
                    </div>
                  </div>
                  {entry.digest && (
                    <div className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-xs text-amber-900">
                      Digest: {entry.digest}
                    </div>
                  )}
                </div>
                <details className="rounded-lg border border-line bg-surface p-3">
                  <summary className="cursor-pointer text-sm font-medium text-indigo-700 dark:text-indigo-300">
                    View full error details
                  </summary>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <Detail label="Route file" value={entry.routePath} />
                    <Detail label="Request ID" value={entry.requestId} />
                    <Detail label="Source" value={entry.source} />
                    <Detail label="User agent" value={entry.userAgent} />
                  </dl>
                  <pre className="mt-3 max-h-[32rem] overflow-auto rounded-md bg-slate-950 p-3 text-xs break-words whitespace-pre-wrap text-slate-100">
                    {entry.stack ?? entry.message}
                  </pre>
                  {Object.keys(entry.context).length > 0 && (
                    <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs break-words whitespace-pre-wrap text-fg">
                      {JSON.stringify(entry.context, null, 2)}
                    </pre>
                  )}
                </details>
              </article>
            ))}
          </div>
        )}
        {pageCount > 1 && (
          <footer className="flex items-center justify-between border-t border-line px-4 py-3">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
              className="inline-flex items-center gap-1 rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </button>
            <span className="text-xs text-fg-muted">
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              disabled={page >= pageCount}
              onClick={() => goToPage(page + 1)}
              className="inline-flex items-center gap-1 rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg disabled:opacity-40"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </footer>
        )}
      </section>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-fg-muted">{label}</dt>
      <dd className="mt-0.5 break-all text-fg">{value ?? '—'}</dd>
    </div>
  );
}
