'use client';

import React, { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { AlertCircle, CheckCircle2, Download, FileUp, Loader2, RotateCw, X } from 'lucide-react';
import {
  getProductImportAction,
  listProductImportsAction,
  productImportFailuresCsvAction,
  productImportTemplateCsvAction,
  retryProductImportAction,
  startProductImportAction,
} from '@/server/domains/catalog/actions';
import type { ImportJobView, ImportProblem } from '@/server/domains/catalog/import-service';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, productCsvColumnGuide } from '@/lib/productCsv';
import { toCsv, UTF8_BOM } from '@/lib/csv';
import { downloadCsv } from '@/lib/downloadPdf';

const POLL_MS = 1500;
/** After this long in the queue, hint that the background worker may not be running. */
const STALLED_QUEUE_MS = 30_000;
const COLUMN_GUIDE = productCsvColumnGuide();

type View =
  | { kind: 'idle' }
  | { kind: 'rejected'; problems: ImportProblem[]; rowsWithProblems: number; totalRows: number }
  | { kind: 'tracking'; job: ImportJobView };

const isActive = (job: ImportJobView) => job.status === 'queued' || job.status === 'processing';

interface ProductImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once when an import finishes creating products. */
  onImported: () => void;
}

/**
 * Rendered only while open: each opening mounts a fresh dialog, so no file,
 * error or previous import view carries over. Past imports stay reachable
 * through the "Recent imports" list.
 */
export function ProductImportDialog({ isOpen, onClose, onImported }: ProductImportDialogProps) {
  if (!isOpen) return null;
  return <ImportDialogContent onClose={onClose} onImported={onImported} />;
}

function ImportDialogContent({ onClose, onImported }: Omit<ProductImportDialogProps, 'isOpen'>) {
  const titleId = useId();
  const fileInputId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const notifiedRef = useRef<string | null>(null);

  const [view, setView] = useState<View>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const [recent, setRecent] = useState<ImportJobView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** When the tracked job was last fetched; drives the "worker may be down" hint without reading the clock during render. */
  const [polledAt, setPolledAt] = useState(0);

  // On open: remember focus, move it into the dialog, load recent imports for reference.
  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    listProductImportsAction()
      .then(setRecent)
      .catch(() => {
        /* the list is a convenience; the dialog still works without it */
      });
  }, []);

  const close = useCallback(() => {
    onClose();
    returnFocusRef.current?.focus();
  }, [onClose]);

  // Poll the tracked job until it finishes.
  const trackedId = view.kind === 'tracking' && isActive(view.job) ? view.job.id : null;
  useEffect(() => {
    if (trackedId === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getProductImportAction(trackedId)
        .then((job) => {
          if (cancelled || job === null) return;
          setPolledAt(Date.now());
          setView({ kind: 'tracking', job });
          if (!isActive(job)) {
            setRecent((list) => [job, ...list.filter((j) => j.id !== job.id)].slice(0, 5));
            if (job.createdCount > 0 && notifiedRef.current !== job.id) {
              notifiedRef.current = job.id;
              onImported();
            }
          }
        })
        .catch(() => {
          if (!cancelled)
            setError('Lost contact with the server. Progress will resume when it reconnects.');
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trackedId, view, onImported]);

  const startOver = () => {
    setView({ kind: 'idle' });
    setFile(null);
    setError(null);
  };

  const upload = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (file === null) {
      setError('Choose a CSV file first.');
      return;
    }
    startTransition(async () => {
      try {
        setError(null);
        const data = new FormData();
        data.set('file', file);
        const result = await startProductImportAction(data);
        if (!result.ok) {
          setView({ kind: 'rejected', ...result });
          return;
        }
        const job = await getProductImportAction(result.jobId);
        if (job) setView({ kind: 'tracking', job });
        setFile(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The upload failed. Please try again.');
      }
    });
  };

  const downloadTemplate = () => {
    startTransition(async () => {
      try {
        downloadCsv(await productImportTemplateCsvAction(), 'product-import-template.csv');
      } catch {
        setError('Could not download the template.');
      }
    });
  };

  const downloadProblems = (problems: ImportProblem[]) => {
    downloadCsv(
      UTF8_BOM +
        toCsv([
          ['Row', 'Column', 'Problem'],
          ...problems.map((p) => [p.row === null ? '' : String(p.row), p.column ?? '', p.message]),
        ]),
      'product-import-problems.csv',
    );
  };

  const downloadFailures = (jobId: string) => {
    startTransition(async () => {
      try {
        downloadCsv(await productImportFailuresCsvAction(jobId), 'product-import-failed-rows.csv');
      } catch {
        setError('Could not download the failed rows.');
      }
    });
  };

  const retry = (jobId: string) => {
    startTransition(async () => {
      try {
        setError(null);
        if (await retryProductImportAction(jobId)) {
          const job = await getProductImportAction(jobId);
          if (job) setView({ kind: 'tracking', job });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not restart the import.');
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-backdrop/80 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
        className="flex max-h-dvh w-full flex-col overflow-hidden bg-surface shadow-2xl sm:max-h-[90vh] sm:max-w-2xl sm:rounded-2xl sm:border sm:border-line"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line p-4 sm:p-5">
          <div className="min-w-0">
            <h2
              id={titleId}
              ref={headingRef}
              tabIndex={-1}
              className="text-base font-bold text-fg-strong focus:outline-none"
            >
              Import products from CSV
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Creates new products. The whole file is checked first — if any row has a problem,
              nothing is imported and you get a list of what to fix.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close import"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg-strong"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          {error !== null ? (
            <p
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </p>
          ) : null}

          {view.kind === 'tracking' ? (
            <JobProgress
              job={view.job}
              polledAt={polledAt}
              onDownloadFailures={downloadFailures}
              onRetry={retry}
              onStartOver={startOver}
              pending={pending}
            />
          ) : (
            <form onSubmit={upload} className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-fg">
                <li>
                  <button
                    type="button"
                    onClick={downloadTemplate}
                    disabled={pending}
                    className="font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-600 disabled:opacity-50 dark:text-indigo-300"
                  >
                    Download the template
                  </button>{' '}
                  (or export your products and edit that file).
                </li>
                <li>Fill in one product per row. Keep the header row as it is.</li>
                <li>
                  Save as <strong>CSV UTF-8</strong> and upload it below (up to{' '}
                  {MAX_IMPORT_ROWS.toLocaleString()} rows, {MAX_IMPORT_BYTES / 1024 / 1024} MB).
                </li>
              </ol>

              <div className="space-y-1">
                <label htmlFor={fileInputId} className="block text-xs font-medium text-fg-muted">
                  CSV file
                </label>
                <input
                  id={fileInputId}
                  type="file"
                  accept=".csv,text/csv"
                  required
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setView({ kind: 'idle' });
                    setError(null);
                  }}
                  className="block min-h-11 w-full rounded-lg border border-line bg-surface-raised text-sm text-fg file:mr-3 file:min-h-11 file:border-0 file:bg-surface-sunken file:px-4 file:text-sm file:font-medium file:text-fg-strong"
                />
              </div>

              <button
                type="submit"
                disabled={pending || file === null}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FileUp className="h-4 w-4" aria-hidden="true" />
                )}
                {pending ? 'Checking file…' : 'Check & import'}
              </button>

              {view.kind === 'rejected' ? (
                <Problems
                  problems={view.problems}
                  rowsWithProblems={view.rowsWithProblems}
                  totalRows={view.totalRows}
                  onDownload={() => downloadProblems(view.problems)}
                />
              ) : null}
            </form>
          )}

          <details className="rounded-lg border border-line">
            <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium text-fg-strong">
              Column guide
            </summary>
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full min-w-[32rem] text-left text-xs">
                <caption className="sr-only">CSV columns</caption>
                <thead className="bg-surface-raised text-fg-subtle">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Column
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Required
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      What to enter
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COLUMN_GUIDE.map((column) => (
                    <tr key={column.header} className="border-t border-line">
                      <td className="px-3 py-2 font-mono text-fg-strong">{column.header}</td>
                      <td className="px-3 py-2 text-fg">{column.required ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-2 text-fg-muted">{column.help}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {recent.length > 0 && view.kind !== 'tracking' ? (
            <section aria-labelledby={`${titleId}-recent`} className="space-y-2">
              <h3 id={`${titleId}-recent`} className="text-xs font-semibold text-fg-muted">
                Recent imports
              </h3>
              <ul className="space-y-2">
                {recent.map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => setView({ kind: 'tracking', job })}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-left text-xs hover:bg-hover"
                    >
                      <span className="min-w-0 truncate text-fg-strong">{job.fileName}</span>
                      <span className="shrink-0 text-fg-muted">
                        {statusLabel(job)} · {new Date(job.createdAt).toLocaleString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function statusLabel(job: ImportJobView): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting to start';
    case 'processing':
      return `Importing ${job.createdCount + job.failedCount} of ${job.totalRows}`;
    case 'completed':
      return job.failedCount > 0
        ? `Done — ${job.createdCount} created, ${job.failedCount} failed`
        : `Done — ${job.createdCount} created`;
    case 'failed':
      return 'Stopped';
  }
}

function StatusIcon({ job }: { job: ImportJobView }) {
  if (isActive(job)) {
    return <Loader2 className="h-6 w-6 shrink-0 animate-spin text-indigo-500" aria-hidden="true" />;
  }
  if (job.status === 'completed' && job.failedCount === 0) {
    return <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden="true" />;
  }
  return <AlertCircle className="h-6 w-6 shrink-0 text-amber-600" aria-hidden="true" />;
}

function JobProgress({
  job,
  polledAt,
  onDownloadFailures,
  onRetry,
  onStartOver,
  pending,
}: {
  job: ImportJobView;
  polledAt: number;
  onDownloadFailures: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  /** Back to a fresh upload form; a running import keeps going in the background. */
  onStartOver: () => void;
  pending: boolean;
}) {
  const done = job.createdCount + job.failedCount;
  const percent = job.totalRows === 0 ? 0 : Math.round((done / job.totalRows) * 100);
  const queuedFor = polledAt - new Date(job.createdAt).getTime();

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <StatusIcon job={job} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg-strong">{job.fileName}</p>
          <p className="text-sm text-fg-muted" aria-live="polite">
            {statusLabel(job)}
          </p>
        </div>
      </div>

      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={job.totalRows}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${job.totalRows} rows processed`}
        className="h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-indigo-600 transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg border border-line p-2">
          <dt className="text-fg-muted">Rows</dt>
          <dd className="text-base font-semibold text-fg-strong">{job.totalRows}</dd>
        </div>
        <div className="rounded-lg border border-line p-2">
          <dt className="text-fg-muted">Created</dt>
          <dd className="text-base font-semibold text-emerald-700 dark:text-emerald-400">
            {job.createdCount}
          </dd>
        </div>
        <div className="rounded-lg border border-line p-2">
          <dt className="text-fg-muted">Failed</dt>
          <dd className="text-base font-semibold text-red-700 dark:text-red-400">
            {job.failedCount}
          </dd>
        </div>
      </dl>

      {job.status === 'queued' && queuedFor > STALLED_QUEUE_MS ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Still waiting for the background worker. It will start automatically once the worker
          service is running; you can close this window.
        </p>
      ) : null}
      {job.status === 'failed' ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          The import stopped: {job.errorMessage ?? 'unknown error'}. Products already created are
          kept; retrying continues from where it stopped.
        </p>
      ) : null}
      {isActive(job) ? (
        <p className="text-xs text-fg-muted">
          You can close this window; the import keeps running.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        {job.failedCount > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onDownloadFailures(job.id)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line-strong px-4 text-sm text-fg hover:bg-hover disabled:opacity-50"
          >
            <Download className="h-4 w-4" aria-hidden="true" /> Download failed rows
          </button>
        ) : null}
        {job.status === 'failed' ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onRetry(job.id)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" /> Retry import
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={onStartOver}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line-strong px-4 text-sm text-fg hover:bg-hover disabled:opacity-50 sm:ml-auto"
        >
          <FileUp className="h-4 w-4" aria-hidden="true" /> Import another file
        </button>
      </div>
    </div>
  );
}

function Problems({
  problems,
  rowsWithProblems,
  totalRows,
  onDownload,
}: {
  problems: ImportProblem[];
  rowsWithProblems: number;
  totalRows: number;
  onDownload: () => void;
}) {
  const shown = problems.slice(0, 100);
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-red-300 bg-red-50 p-3 text-red-900"
    >
      <p className="text-sm font-semibold">
        Nothing was imported.{' '}
        {rowsWithProblems > 0
          ? `${rowsWithProblems} of ${totalRows} rows need fixing.`
          : 'The file itself needs fixing.'}
      </p>
      <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">
        {shown.map((problem, index) => (
          // Problems have no stable id; order is fixed for a given upload.
          // eslint-disable-next-line react/no-array-index-key
          <li key={index}>
            {problem.row !== null ? <strong>Row {problem.row}: </strong> : null}
            {problem.message}
          </li>
        ))}
      </ul>
      {problems.length > shown.length ? (
        <p className="text-xs">…and {problems.length - shown.length} more.</p>
      ) : null}
      <button
        type="button"
        onClick={onDownload}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-400 bg-white px-3 text-sm font-medium text-red-900 hover:bg-red-100"
      >
        <Download className="h-4 w-4" aria-hidden="true" /> Download all problems (CSV)
      </button>
    </div>
  );
}
