'use client';

import { useDeferredValue, useId, useMemo, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import type { CatalogueEntry } from '@/lib/quote-layout';
import { parseBulkList, type CatalogueIndexEntry } from '@/lib/catalogue-entry';
import { useModalKeys } from './useModalKeys';

/** Rows and problems drawn in the preview; the full list is still added. */
const PREVIEW = 100;

const EXAMPLE = 'PAN-550, 10\nINV-5K, 2, 450000, 5\nRAIL-1, 40';

/**
 * Adds a whole list at once: paste it (from a spreadsheet, an email or a customer's order) or load
 * a CSV file. Each line is checked and shown before anything is added, so a bad code or number is
 * found by line number, not discovered later.
 */
export function BulkAddDialog({
  index,
  places,
  initialSlot,
  noun,
  onAdd,
  onClose,
}: {
  index: CatalogueIndexEntry[];
  /** Where the items can go. `id` null is the individual items. */
  places: { id: string | null; label: string }[];
  initialSlot: string | null;
  noun: 'quote' | 'template';
  onAdd: (entries: CatalogueEntry[]) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const dialogRef = useModalKeys<HTMLElement>(onClose);
  const [text, setText] = useState('');
  const [slot, setSlot] = useState<string | null>(initialSlot);
  const [fileError, setFileError] = useState<string | null>(null);
  const deferred = useDeferredValue(text);
  const parsed = useMemo(() => parseBulkList(deferred, index), [deferred, index]);
  const place = places.find((p) => p.id === slot)?.label ?? 'the individual items';
  const pending = deferred !== text;

  const load = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    if (file.size > 2_000_000) {
      setFileError('That file is over 2 MB. Split it into smaller lists.');
      return;
    }
    try {
      setText(await file.text());
    } catch {
      setFileError('That file could not be read.');
    }
  };

  const total = parsed.rows.length;
  const add = () => {
    if (total === 0) return;
    onAdd(parsed.rows.map((row) => ({ ...row.entry, sectionId: slot })));
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-backdrop/70 p-2 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Paste or import a list into the ${noun}`}
        className="flex max-h-[96dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line p-3 sm:p-4">
          <div className="min-w-0">
            <h2 className="font-semibold text-fg-strong">Paste or import a list</h2>
            <p className="text-xs text-fg-muted">
              One item per line: <strong>code, quantity, price, discount %</strong>. The code is the
              SKU or stock code. Quantity, price and discount are optional (quantity defaults to 1,
              an empty price uses the usual price). Commas, tabs and semicolons all work, so you can
              paste straight from a spreadsheet.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="text-sm font-medium text-fg">
              Add to
              <select
                value={slot ?? ''}
                onChange={(event) => setSlot(event.target.value === '' ? null : event.target.value)}
                className="mt-1 block min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
              >
                {places.map((p) => (
                  <option key={p.id ?? 'none'} value={p.id ?? ''}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-fg focus-within:outline-2 focus-within:outline-indigo-500 hover:bg-hover">
              <FileUp className="h-4 w-4" aria-hidden /> Load a CSV file
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="sr-only"
                onChange={(event) => {
                  void load(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          {fileError && (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {fileError}
            </p>
          )}

          <label className="block text-sm font-medium text-fg" htmlFor={`${uid}-text`}>
            The list
          </label>
          <textarea
            id={`${uid}-text`}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={EXAMPLE}
            className="block w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
          />

          <p role="status" aria-live="polite" className="text-sm text-fg">
            {text.trim() === '' ? (
              <span className="text-fg-muted">Nothing to check yet.</span>
            ) : pending ? (
              <span className="text-fg-muted">Checking…</span>
            ) : (
              <>
                <strong className="text-emerald-800 dark:text-emerald-300">
                  {total.toLocaleString()} ready
                </strong>
                {parsed.problems.length > 0 && (
                  <>
                    {' · '}
                    <strong className="text-red-700">
                      {parsed.problems.length.toLocaleString()} with a problem
                    </strong>{' '}
                    (left out)
                  </>
                )}
              </>
            )}
          </p>
          {parsed.truncated && (
            <p role="alert" className="text-sm font-semibold text-amber-800">
              Only the first lines were read. Split a list of this size in two.
            </p>
          )}

          {parsed.problems.length > 0 && (
            <section aria-label="Lines with a problem">
              <h3 className="mb-1 text-sm font-semibold text-red-700">Fix these lines</h3>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-red-300 bg-red-50 p-2 text-sm dark:border-red-800 dark:bg-red-950/30">
                {parsed.problems.slice(0, PREVIEW).map((p) => (
                  <li key={p.line}>
                    <span className="font-mono text-xs font-semibold text-red-800 dark:text-red-300">
                      Line {p.line}
                    </span>{' '}
                    <span className="font-mono text-xs text-fg">{p.text}</span>
                    <span className="block text-xs text-red-800 dark:text-red-300">
                      {p.message}
                    </span>
                  </li>
                ))}
              </ul>
              {parsed.problems.length > PREVIEW && (
                <p className="mt-1 text-xs text-fg-muted">
                  …and {(parsed.problems.length - PREVIEW).toLocaleString()} more.
                </p>
              )}
            </section>
          )}

          {total > 0 && (
            <section aria-label="Items ready to add">
              <h3 className="mb-1 text-sm font-semibold text-fg-strong">Ready to add</h3>
              <div className="max-h-56 overflow-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-surface text-fg-muted">
                    <tr>
                      <th className="p-2">Line</th>
                      <th className="p-2">Product</th>
                      <th className="p-2 text-right">Qty</th>
                      <th className="p-2 text-right">Price</th>
                      <th className="p-2 text-right">Disc %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {parsed.rows.slice(0, PREVIEW).map((row) => (
                      <tr key={row.line}>
                        <td className="p-2 font-mono text-fg-muted">{row.line}</td>
                        <td className="p-2 text-fg-strong">
                          {row.product.name}{' '}
                          <span className="text-fg-muted">{row.product.sku}</span>
                        </td>
                        <td className="p-2 text-right font-mono">{row.entry.quantity}</td>
                        <td className="p-2 text-right font-mono">
                          {row.entry.unitPrice ?? <span className="text-fg-muted">usual</span>}
                        </td>
                        <td className="p-2 text-right font-mono">{row.entry.discountPercent}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > PREVIEW && (
                <p className="mt-1 text-xs text-fg-muted">
                  Showing the first {PREVIEW}. All {total.toLocaleString()} are added.
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-3 sm:p-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={add}
            disabled={total === 0 || pending}
            className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {total > 0 ? `Add ${total.toLocaleString()} items to ${place}` : 'Add items'}
          </button>
        </footer>
      </section>
    </div>
  );
}
