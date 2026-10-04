'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Loader2, Search, Trash2, X } from 'lucide-react';
import { deleteMediaAction, listMediaAction } from '@/server/domains/media/actions';
import { MediaThumb } from '@/components/admin/MediaThumb';
import type { MediaAssetView } from '@/types/index';

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;

interface MediaLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Assets already on the product: shown but not selectable. */
  excludeIds: Set<string>;
  /** How many more images the product can take. */
  remaining: number;
  onAdd: (assets: MediaAssetView[]) => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Mounts a fresh panel on every open, so search, selection and results always start clean. */
export function MediaLibraryDialog(props: MediaLibraryDialogProps) {
  return props.open ? <LibraryPanel {...props} /> : null;
}

function LibraryPanel({ onClose, excludeIds, remaining, onAdd }: MediaLibraryDialogProps) {
  const uid = useId();
  const panel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeSearch = useRef('');

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<MediaAssetView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  /** The search the current `items` belong to; differs from `debounced` while a new search loads. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, MediaAssetView>>(new Map());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** The tile showing its "delete permanently?" prompt. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const loading = loadedFor !== debounced || loadingMore;

  useEffect(() => {
    searchInput.current?.focus();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // A new search replaces the list. State is only set once the request settles, and a
  // superseded request is ignored, so fast typing can never show stale results.
  useEffect(() => {
    let cancelled = false;
    activeSearch.current = debounced;
    listMediaAction({ query: debounced, purpose: 'product', limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNextBefore(page.nextBefore);
        setError(null);
        setLoadedFor(debounced);
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not load the media library. Please try again.');
        setLoadedFor(debounced);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const loadMore = async () => {
    if (nextBefore === null) return;
    const search = debounced;
    setLoadingMore(true);
    try {
      const page = await listMediaAction({ query: search, purpose: 'product', limit: PAGE_SIZE, before: nextBefore });
      if (activeSearch.current !== search) return;
      setItems((prev) => [...prev, ...page.items]);
      setNextBefore(page.nextBefore);
    } catch {
      setError('Could not load more images. Please try again.');
    } finally {
      setLoadingMore(false);
    }
  };

  /** Permanently removes an image (and its file) from the library, if no product uses it. */
  const removeFromLibrary = async (asset: MediaAssetView, name: string) => {
    setConfirmingId(null);
    setDeletingId(asset.id);
    setMessage(null);
    try {
      const result = await deleteMediaAction(asset.id);
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.error });
        return;
      }
      setItems((prev) => prev.filter((item) => item.id !== asset.id));
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(asset.id);
        return next;
      });
      setMessage({
        kind: 'info',
        text:
          result.data.outcome === 'removed'
            ? `"${name}" was deleted.`
            : `"${name}" was removed from the library. Its file is kept because past orders show it.`,
      });
    } catch {
      setMessage({ kind: 'error', text: 'You do not have permission to delete media, or the request failed.' });
    } finally {
      setDeletingId(null);
    }
  };

  const toggle = (asset: MediaAssetView) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else if (next.size < remaining) next.set(asset.id, asset);
      return next;
    });

  // Escape closes only this dialog; Tab stays inside it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      // Escape backs out of the delete prompt first, and only then closes the dialog.
      if (confirmingId !== null) setConfirmingId(null);
      else onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const confirm = () => {
    onAdd([...selected.values()]);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-backdrop/80 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        onKeyDown={onKeyDown}
        className="flex h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-line bg-surface-raised shadow-2xl sm:h-[min(640px,85vh)] sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
          <h3 id={`${uid}-title`} className="text-sm font-bold text-fg-strong">
            Media library
          </h3>
          <button
            type="button"
            aria-label="Close media library"
            onClick={onClose}
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="shrink-0 border-b border-line px-4 py-3">
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search images by name or description
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input
              ref={searchInput}
              id={`${uid}-search`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or description"
              className="min-h-11 w-full rounded-lg border border-line bg-surface py-2 pr-3 pl-9 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none sm:min-h-10"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {message !== null ? (
            <p
              role={message.kind === 'error' ? 'alert' : 'status'}
              className={`mb-3 rounded-lg border p-3 text-xs ${
                message.kind === 'error'
                  ? 'border-red-800 bg-red-50/80 text-red-800'
                  : 'border-emerald-800 bg-emerald-50/80 text-emerald-800'
              }`}
            >
              {message.text}
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="rounded-lg border border-red-800 bg-red-50/80 p-3 text-xs text-red-800">
              {error}
            </p>
          ) : null}

          {error === null && !loading && items.length === 0 ? (
            <p className="py-10 text-center text-xs text-fg-muted">
              {debounced !== '' ? 'No images match that search.' : 'No images in the library yet. Upload some from the product form.'}
            </p>
          ) : null}

          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Library images">
            {items.map((asset) => {
              const already = excludeIds.has(asset.id);
              const isSelected = selected.has(asset.id);
              const full = !isSelected && selected.size >= remaining;
              const name = [asset.originalName, asset.altText].find((text) => text !== '') ?? 'Untitled image';
              return (
                <li key={asset.id} className="relative">
                  <label
                    className={`group relative block rounded-xl border p-1.5 ${
                      already || full ? 'cursor-not-allowed' : 'cursor-pointer hover:border-indigo-400'
                    } ${isSelected ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-line'} bg-surface focus-within:outline-2 focus-within:outline-indigo-500`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isSelected || already}
                      disabled={already || full}
                      onChange={() => toggle(asset)}
                      aria-label={already ? `${name} (already on this product)` : name}
                    />
                    <div
                      className={`relative aspect-square overflow-hidden rounded-lg bg-surface-sunken ${already || full ? 'opacity-50' : ''}`}
                    >
                      <MediaThumb src={asset.thumbUrl} alt={asset.altText !== '' ? asset.altText : name} sizes="(min-width: 1024px) 190px, (min-width: 640px) 28vw, 44vw" />
                      {isSelected || already ? (
                        <span className="absolute top-1 right-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white">
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-[10px] text-fg-subtle" title={name}>
                      {already ? 'Already added' : name}
                    </p>
                  </label>
                  <button
                    type="button"
                    aria-label={`Delete ${name} from the library`}
                    title={already ? 'Remove it from this product first' : 'Delete from library'}
                    disabled={already || deletingId === asset.id}
                    onClick={() => setConfirmingId(asset.id)}
                    className="absolute top-2.5 left-2.5 z-10 inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg bg-surface/90 text-fg shadow transition-colors hover:bg-red-100 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {deletingId === asset.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                  {confirmingId === asset.id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Delete ${name}?`}
                      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl bg-surface p-2 text-center"
                    >
                      <p className="text-[11px] font-semibold text-fg-strong">Delete permanently?</p>
                      <p className="text-[10px] text-fg-muted">The file is removed from storage.</p>
                      <div className="flex w-full flex-col gap-1.5">
                        <button
                          type="button"
                          ref={(element) => element?.focus()}
                          onClick={() => setConfirmingId(null)}
                          className="min-h-10 cursor-pointer rounded-lg border border-line bg-surface-sunken px-2 text-xs font-semibold text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeFromLibrary(asset, name)}
                          className="min-h-10 cursor-pointer rounded-lg bg-red-600 px-2 text-xs font-semibold text-white hover:bg-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {loading ? (
            <p role="status" className="flex items-center justify-center gap-2 py-4 text-xs text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading…
            </p>
          ) : null}

          {!loading && nextBefore !== null ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={() => void loadMore()}
                className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line bg-surface-sunken px-4 text-xs font-semibold text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 sm:min-h-10"
              >
                Load more
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-fg-muted" aria-live="polite">
            {selected.size === 0
              ? `Select up to ${remaining} image${remaining === 1 ? '' : 's'}.`
              : `${selected.size} selected${selected.size >= remaining ? ' (limit reached)' : ''}`}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 cursor-pointer rounded-lg border border-line bg-surface-sunken px-4 text-xs font-semibold text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 sm:min-h-10"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={confirm}
              className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 text-xs font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10"
            >
              Add {selected.size > 0 ? selected.size : ''} selected
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
