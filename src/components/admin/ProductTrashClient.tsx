'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RotateCcw, Search, Trash2 } from 'lucide-react';
import { listTrashAction, restoreProductsAction } from '@/server/domains/catalog/actions';
import type { ProductSelection } from '@/server/domains/catalog/bulk-delete';
import type { TrashPage } from '@/server/domains/catalog/trash';
import { ProductDeleteDialog } from '@/components/admin/ProductDeleteDialog';
import {
  BusyOverlay,
  ResultNotice,
  useWarnBeforeLeaving,
  type BulkNotice,
} from '@/components/admin/BulkFeedback';
import {
  EmptyState,
  PageHeader,
  When,
  buttonClass,
  dangerButtonClass,
  primaryButtonClass,
} from '@/components/admin/approvals/shared';

const n = (v: number) => v.toLocaleString('en-KE');

/**
 * Deleted products. Restoring brings them back as drafts (they were hidden when deleted);
 * erasing is permanent and refused for products orders, KRA or a live price list depend on.
 */
export function ProductTrashClient({ canPurge }: { canPurge: boolean }) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TrashPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** Everything in the trash, including other pages, except `excluded`. */
  const [everything, setEverything] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const [working, setWorking] = useState<string | null>(null);
  const workingRef = useRef(false);
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  const [erasing, setErasing] = useState<{
    selection: ProductSelection;
    count: number;
    label: string;
  } | null>(null);
  useWarnBeforeLeaving(working !== null);

  // Search waits for a pause in typing, and goes back to the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      setTerm(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const r = await listTrashAction({ search: term, page });
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [term, page]);
  useEffect(() => {
    let live = true;
    void listTrashAction({ search: term, page }).then((r) => {
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [term, page]);

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const isPicked = (id: string) => (everything ? !excluded.has(id) : picked.has(id));
  const count = everything ? total - excluded.size : picked.size;
  const pickedHere = rows.filter((r) => isPicked(r.id)).length;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const clear = () => {
    setPicked(new Set());
    setEverything(false);
    setExcluded(new Set());
  };
  const toggle = (id: string) => {
    const set = new Set(everything ? excluded : picked);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    if (everything) setExcluded(set);
    else setPicked(set);
  };
  const toggleAllHere = (checked: boolean) => {
    if (!checked) { clear(); return; }
    if (everything) {
      const next = new Set(excluded);
      for (const r of rows) next.delete(r.id);
      setExcluded(next);
    } else setPicked(new Set([...picked, ...rows.map((r) => r.id)]));
  };
  const selection = (): ProductSelection =>
    everything ? { mode: 'all', excludeIds: [...excluded] } : { mode: 'ids', ids: [...picked] };

  const restore = async (sel: ProductSelection, howMany: number) => {
    if (workingRef.current || howMany === 0) return;
    workingRef.current = true;
    setNotice(null);
    setWorking(`Restoring ${n(howMany)} product${howMany === 1 ? '' : 's'}…`);
    const r = await restoreProductsAction(sel, howMany);
    workingRef.current = false;
    setWorking(null);
    if (!r.ok) {
      setNotice({ tone: 'error', text: r.error, details: [] });
      return;
    }
    const d = r.data;
    setNotice({
      tone: d.skipped > 0 ? 'warn' : 'ok',
      text: [
        d.restored > 0
          ? `${n(d.restored)} product${d.restored === 1 ? '' : 's'} restored as draft${d.restored === 1 ? '' : 's'}. Publish them from Products when ready.`
          : 'Nothing was restored.',
        d.skipped > 0 ? `${n(d.skipped)} left in the trash.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      details: [
        ...d.skippedSample.map((x) => `${x.name} (${x.sku}): ${x.reason}`),
        ...(d.skipped > d.skippedSample.length
          ? [`…and ${n(d.skipped - d.skippedSample.length)} more.`]
          : []),
      ],
    });
    clear();
    await load();
  };

  const askErase = (sel: ProductSelection, howMany: number, label: string) =>
    setErasing({ selection: sel, count: howMany, label });

  return (
    <div className="space-y-5">
      <p className="text-xs">
        <Link
          href="/admin/products"
          className="inline-flex min-h-10 items-center text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          ← Products
        </Link>
      </p>
      <PageHeader
        title="Trash"
        actions={
          canPurge && total > 0 ? (
            <button
              type="button"
              className={dangerButtonClass}
              disabled={working !== null}
              onClick={() =>
                askErase(
                  { mode: 'all', excludeIds: [] },
                  total,
                  `all ${n(total)} products in the trash`,
                )
              }
            >
              Empty the trash
            </button>
          ) : null
        }
      >
        Deleted products wait here. Restoring brings them back as drafts, with their stock history.
        Erasing removes them for good, and is refused for products that orders, KRA or a live price
        list still depend on.
      </PageHeader>

      {working !== null ? <BusyOverlay text={working} /> : null}
      {notice ? <ResultNotice notice={notice} onDismiss={() => setNotice(null)} /> : null}
      {erasing ? (
        <ProductDeleteDialog
          selection={erasing.selection}
          count={erasing.count}
          label={erasing.label}
          canPurge={canPurge}
          scope="trash"
          onClose={() => setErasing(null)}
          onDeleted={() => {
            clear();
            void load();
          }}
        />
      ) : null}

      <div className="relative max-w-sm">
        <Search
          className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden="true"
        />
        <input
          type="search"
          aria-label="Search the trash"
          placeholder="Search by name, SKU or stock code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-10 w-full rounded-lg border border-line bg-surface py-1.5 pr-4 pl-9 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
        />
      </div>

      {count > 0 ? (
        <div
          role="region"
          aria-label="Selected products"
          className="space-y-2 rounded-lg border border-indigo-600 bg-indigo-50 p-2.5 text-sm text-indigo-600 dark:text-indigo-400"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold" role="status">
              {everything && excluded.size === 0
                ? `All ${n(count)} products in the trash selected`
                : `${n(count)} product${count === 1 ? '' : 's'} selected`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={working !== null}
                onClick={() => void restore(selection(), count)}
              >
                <RotateCcw className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
                Restore
              </button>
              {canPurge ? (
                <button
                  type="button"
                  className={dangerButtonClass}
                  disabled={working !== null}
                  onClick={() =>
                    askErase(selection(), count, `${n(count)} product${count === 1 ? '' : 's'}`)
                  }
                >
                  Delete permanently
                </button>
              ) : null}
              <button
                type="button"
                className="min-h-9 cursor-pointer rounded px-2.5 py-1 font-medium underline hover:no-underline"
                onClick={clear}
              >
                Clear
              </button>
            </div>
          </div>
          {!everything && total > count ? (
            <p className="text-fg">
              <button
                type="button"
                className="min-h-9 cursor-pointer font-semibold text-indigo-700 underline hover:no-underline"
                onClick={() => {
                  setEverything(true);
                  setExcluded(new Set());
                }}
              >
                Select all {n(total)} products in the trash
              </button>
              {term ? ' (including ones the search hides)' : ''}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : data === null ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading the trash…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title={term ? 'Nothing in the trash matches that.' : 'The trash is empty.'}>
          {term
            ? 'Try a different name or SKU.'
            : 'Products you delete will wait here until you restore or erase them.'}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                <tr>
                  <th className="w-8 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all products on this page"
                      checked={pickedHere === rows.length}
                      ref={(el) => {
                        if (el) el.indeterminate = pickedHere > 0 && pickedHere < rows.length;
                      }}
                      onChange={(e) => toggleAllHere(e.target.checked)}
                      className="cursor-pointer"
                    />
                  </th>
                  <th className="px-4 py-3">Product / SKU</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Stock on hand</th>
                  <th className="px-4 py-3">Deleted</th>
                  <th className="px-4 py-3">Can it come back?</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg">
                {rows.map((r) => (
                  <tr key={r.id} className={isPicked(r.id) ? 'bg-indigo-50' : ''}>
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name}`}
                        checked={isPicked(r.id)}
                        onChange={() => toggle(r.id)}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-fg-strong">{r.name}</div>
                      <div className="font-mono text-[11px] text-fg-muted">SKU: {r.sku}</div>
                    </td>
                    <td className="px-4 py-3">{r.category || '—'}</td>
                    <td className="px-4 py-3 text-right font-mono">{n(r.stockQuantity)}</td>
                    <td className="px-4 py-3 text-fg-muted">
                      <When iso={r.deletedAt} />
                    </td>
                    <td className="px-4 py-3">
                      {r.restoreBlockedBy ? (
                        <span className="text-amber-700">No: {r.restoreBlockedBy}.</span>
                      ) : (
                        <span className="text-emerald-700">Yes, as a draft</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={working !== null || r.restoreBlockedBy !== null}
                          aria-label={`Restore ${r.name}`}
                          onClick={() => void restore({ mode: 'ids', ids: [r.id] }, 1)}
                        >
                          Restore
                        </button>
                        {canPurge ? (
                          <button
                            type="button"
                            className={`${buttonClass} text-red-700`}
                            disabled={working !== null}
                            aria-label={`Delete ${r.name} permanently`}
                            title="Delete permanently"
                            onClick={() =>
                              askErase({ mode: 'ids', ids: [r.id] }, 1, `"${r.name}" (${r.sku})`)
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line p-3 text-xs text-fg-muted">
            <span>
              {n(total)} in the trash · page {page} of {pages}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
