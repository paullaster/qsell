'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { deleteProductsAction, previewProductDeleteAction } from '@/server/domains/catalog/actions';
import Link from 'next/link';
import type {
  DeletePreview,
  DeleteResult,
  DeleteScope,
  ProductSelection,
} from '@/server/domains/catalog/bulk-delete';

interface Props {
  selection: ProductSelection;
  /** How many products the person believes they selected; the server refuses if it differs. */
  count: number;
  /** "3 products", or the product's name for a single delete. */
  label: string;
  canPurge: boolean;
  /** 'trash': the products are already deleted, so the only choice is to erase them for good. */
  scope?: DeleteScope;
  onClose: () => void;
  /** Called when the person closes the dialog after something was deleted. */
  onDeleted: () => void;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-KE')} ${n === 1 ? one : many}`;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Asks before every product delete. Soft delete is the default and says what is kept; ticking
 * "permanently" switches to a red warning that it cannot be undone, asks for a reason, and shows
 * beforehand which products will be left alone because history depends on them.
 */
export function ProductDeleteDialog({
  selection,
  count,
  label,
  canPurge,
  scope = 'live',
  onClose,
  onDeleted,
}: Props) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const asked = useRef(0);

  const [permanent, setPermanent] = useState(scope === 'trash');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);

  // Remember where focus was, start on the safe button, give focus back on close.
  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  // What would happen, for the mode currently chosen. A late answer for an earlier mode is dropped.
  useEffect(() => {
    const ticket = ++asked.current;
    let live = true;
    void previewProductDeleteAction(selection, permanent, scope).then((r) => {
      if (!live || ticket !== asked.current) return;
      if (r.ok) {
        setPreview(r.data);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [selection, permanent, scope]);

  // Leaving mid-delete would not undo it, but the person would not see how it ended.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const close = useCallback(() => {
    if (busy) return;
    if (result && result.deleted > 0) onDeleted();
    onClose();
  }, [busy, result, onClose, onDeleted]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const r = await deleteProductsAction(selection, {
      permanent,
      scope,
      expectedCount: count,
      reason: reason.trim() || undefined,
    });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setError(r.error);
  };

  const gone = preview?.deletable ?? 0;
  const reasonOk = !permanent || reason.trim().length >= 3;
  const canConfirm = preview !== null && gone > 0 && reasonOk && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
        className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface-raised p-5 shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        {result ? (
          <Done
            result={result}
            titleId={titleId}
            descId={descId}
            onClose={close}
            offerTrash={scope === 'live'}
          />
        ) : busy ? (
          <div role="status" aria-live="polite" aria-busy="true" className="py-6 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-red-600" aria-hidden="true" />
            <h2 id={titleId} className="mt-3 text-base font-bold text-fg-strong">
              {permanent ? 'Permanently deleting' : 'Deleting'} {label}…
            </h2>
            <p id={descId} className="mt-1 text-sm text-fg-muted">
              This can take a little while for a long list. Please keep this window open; nothing
              else can be changed until it finishes.
            </p>
          </div>
        ) : (
          <>
            <h2 id={titleId} className="flex items-center gap-2 text-base font-bold text-fg-strong">
              <Trash2 className="h-5 w-5 text-red-600" aria-hidden="true" />
              {permanent ? 'Permanently delete' : 'Delete'} {label}?
            </h2>

            <div id={descId} className="mt-3 space-y-3 text-sm text-fg">
              {permanent ? (
                <div
                  role="alert"
                  className="rounded-lg border border-red-600/40 bg-red-500/10 p-3 text-red-700 dark:text-red-300"
                >
                  <p className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                    This cannot be undone.
                  </p>
                  <p className="mt-1">
                    {preview ? plural(gone, 'product') : 'The products'} will be erased for good,
                    with their image links, stock movement records and entries in retired price
                    lists. They cannot be restored or recovered afterwards.
                  </p>
                  {preview &&
                  (preview.erases.movements > 0 || preview.erases.productsWithStock > 0) ? (
                    <p className="mt-1 font-semibold">
                      That includes {plural(preview.erases.movements, 'stock movement record')}
                      {preview.erases.productsWithStock > 0
                        ? `, and ${plural(preview.erases.productsWithStock, 'product')} with stock on hand (${preview.erases.units.toLocaleString('en-KE')} units in total)`
                        : ''}
                      .
                    </p>
                  ) : null}
                </div>
              ) : (
                <p>
                  {plural(count, 'product')} will be moved to the Trash and removed from the
                  catalogue and the shop. Orders and stock history are kept, their SKUs can be used
                  again, and you can restore them from the Trash.
                </p>
              )}

              {previewError ? (
                <p role="alert" className="text-red-700">
                  {previewError}
                </p>
              ) : preview === null ? (
                <p className="flex items-center gap-2 text-fg-muted" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Checking what this affects…
                </p>
              ) : permanent && preview.blocked.length > 0 ? (
                <div
                  role="status"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200"
                >
                  <p className="font-semibold">
                    {plural(preview.total - gone, 'product')} will be left as they are, because
                    orders, KRA or a live price list depend on them:
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {preview.blocked.map((b) => (
                      <li key={b.reason}>
                        {plural(b.count, 'product')}: {b.text}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs">
                    Delete those normally (not permanently) to take them off the catalogue.
                  </p>
                  {gone === 0 ? (
                    <p className="mt-1 font-semibold">Nothing here can be permanently deleted.</p>
                  ) : null}
                </div>
              ) : null}

              {scope === 'trash' ? null : canPurge ? (
                <label className="flex min-h-10 cursor-pointer items-start gap-2.5 rounded-lg border border-line p-3">
                  <input
                    type="checkbox"
                    checked={permanent}
                    disabled={busy}
                    onChange={(e) => {
                      setPermanent(e.target.checked);
                      setPreview(null);
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-red-600"
                  />
                  <span>
                    <span className="font-semibold text-fg-strong">Delete permanently</span>
                    <span className="block text-xs text-fg-muted">
                      Erase them instead of just hiding them. Off by default.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="text-xs text-fg-muted">
                  Permanent deletion needs an extra permission, which you do not have.
                </p>
              )}

              {permanent ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-fg-strong">
                    Why are these being erased? (recorded)
                  </span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={300}
                    disabled={busy}
                    className="w-full rounded-lg border border-line bg-surface p-2 text-sm text-fg-strong focus:border-red-500 focus:outline-none"
                  />
                </label>
              ) : null}

              {error ? (
                <p role="alert" className="text-red-700">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                ref={cancelRef}
                type="button"
                onClick={close}
                disabled={busy}
                className="min-h-11 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-4 py-2 text-sm font-semibold text-fg hover:bg-hover disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={!canConfirm}
                className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {busy
                  ? 'Deleting…'
                  : permanent
                    ? `Permanently delete ${preview ? plural(gone, 'product') : ''}`.trim()
                    : `Delete ${plural(count, 'product')}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Done({
  result,
  titleId,
  descId,
  onClose,
  offerTrash,
}: {
  result: DeleteResult;
  titleId: string;
  descId: string;
  onClose: () => void;
  offerTrash: boolean;
}) {
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => doneRef.current?.focus(), []);
  return (
    <>
      <h2 id={titleId} className="flex items-center gap-2 text-base font-bold text-fg-strong">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
        {result.deleted > 0 ? 'Done' : 'Nothing was deleted'}
      </h2>
      <div id={descId} className="mt-3 space-y-2 text-sm text-fg" role="status">
        <p>
          {plural(result.deleted, 'product')}{' '}
          {result.permanent ? 'permanently deleted' : 'moved to the Trash. Their history is kept'}.
        </p>
        {offerTrash && !result.permanent && result.deleted > 0 ? (
          <p>
            You can bring them back from the{' '}
            <Link href="/admin/trash/products" className="font-semibold text-indigo-700 underline">
              Trash
            </Link>
            .
          </p>
        ) : null}
        {result.skipped > 0 ? (
          <div>
            <p className="font-semibold text-amber-800 dark:text-amber-200">
              {plural(result.skipped, 'product')} left as they are:
            </p>
            <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
              {result.skippedSample.map((s) => (
                <li key={s.id}>
                  {s.name} ({s.sku}): {s.reasons.join('; ')}
                </li>
              ))}
            </ul>
            {result.skipped > result.skippedSample.length ? (
              <p className="mt-1 text-xs text-fg-muted">
                …and {(result.skipped - result.skippedSample.length).toLocaleString('en-KE')} more.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end">
        <button
          ref={doneRef}
          type="button"
          onClick={onClose}
          className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-bold text-white hover:bg-indigo-500"
        >
          Done
        </button>
      </div>
    </>
  );
}
