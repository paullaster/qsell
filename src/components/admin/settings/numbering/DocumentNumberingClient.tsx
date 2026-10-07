'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  clearNumberBindingAction,
  setNumberBindingAction,
  type BindingsView,
} from '@/server/kernel/numbering/actions';
import { ReasonField, reasonReady, type ReasonValue } from './ReasonField';

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none';
const buttonClass =
  'min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:opacity-50';

interface Pending {
  kind: string;
  kindLabel: string;
  branchId: string | null;
  branchLabel: string;
  seriesId: string | null;
}

export function DocumentNumberingClient({ view }: { view: BindingsView }) {
  const uid = useId();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [adding, setAdding] = useState<{ kind: string; branchId: string; seriesId: string } | null>(
    null,
  );

  const seriesById = new Map(view.series.map((s) => [s.id, s]));
  const branchById = new Map(view.branches.map((b) => [b.id, b]));
  const current = (kind: string, branchId: string | null) =>
    view.bindings.find((b) => b.documentKind === kind && b.branchId === branchId)?.seriesId ?? '';

  const askToChange = (
    kind: BindingsView['kinds'][number],
    branchId: string | null,
    seriesId: string | null,
  ) => {
    setMessage(null);
    setReason({ code: '', text: '' });
    setPending({
      kind: kind.kind,
      kindLabel: kind.label,
      branchId,
      branchLabel: branchId ? (branchById.get(branchId)?.name ?? 'branch') : 'all branches',
      seriesId,
    });
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    const res = pending.seriesId
      ? await setNumberBindingAction(
          { documentKind: pending.kind, branchId: pending.branchId, seriesId: pending.seriesId },
          reason,
        )
      : await clearNumberBindingAction(pending.kind, pending.branchId, reason);
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    setMessage({ kind: 'ok', text: `${pending.kindLabel} numbering updated.` });
    setPending(null);
    setAdding(null);
    router.refresh();
  };

  const options = (kind: BindingsView['kinds'][number]) =>
    view.series.map((s) => {
      const blocked = !s.isActive || (kind.fiscal && s.mode !== 'gap_free');
      return (
        <option key={s.id} value={s.id} disabled={blocked}>
          {s.code} — {s.description}
          {!s.isActive
            ? ' (inactive)'
            : kind.fiscal && s.mode !== 'gap_free'
              ? ' (allows gaps)'
              : ''}
        </option>
      );
    });

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <Link
          href="/admin/settings/number-series"
          className="text-xs font-semibold text-indigo-500 underline"
        >
          ← All number series
        </Link>
        <h2 className="mt-2 text-xl font-bold text-fg-strong">Document numbering</h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Choose which series numbers each kind of document. A branch can have its own series;
          otherwise the default applies. Fiscal documents can only use gap-free series.
        </p>
      </div>

      <div aria-live="polite" className="space-y-2">
        {message ? (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`text-sm ${message.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      {pending ? (
        <section
          className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4"
          aria-label="Confirm change"
        >
          <p className="text-sm font-semibold text-fg-strong">
            {pending.seriesId
              ? `Number ${pending.kindLabel.toLowerCase()} (${pending.branchLabel}) with ${seriesById.get(pending.seriesId)?.code}?`
              : `Stop using a specific series for ${pending.kindLabel.toLowerCase()} (${pending.branchLabel})?`}
          </p>
          <ReasonField value={reason} onChange={setReason} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !reasonReady(reason)}
              onClick={confirm}
              className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Confirm change'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <ul className="space-y-3">
        {view.kinds.map((kind) => {
          const overrides = view.bindings.filter(
            (b) => b.documentKind === kind.kind && b.branchId !== null,
          );
          const def = current(kind.kind, null);
          return (
            <li
              key={kind.kind}
              className="space-y-3 rounded-xl border border-line bg-surface-raised p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong">
                  {kind.label}
                  {kind.fiscal ? (
                    <span className="ml-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      Fiscal · gap-free only
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-fg-muted">
                  Next number:{' '}
                  <span className="font-mono text-fg-strong">
                    {view.examples[kind.kind] ?? '— not set up —'}
                  </span>
                </p>
              </div>
              <div>
                <label
                  htmlFor={`${uid}-${kind.kind}`}
                  className="mb-1 block text-xs font-semibold text-fg"
                >
                  Default series
                </label>
                <select
                  id={`${uid}-${kind.kind}`}
                  value={def}
                  onChange={(e) => askToChange(kind, null, e.target.value || null)}
                  className={fieldClass}
                >
                  <option value="">None — this document cannot be numbered</option>
                  {options(kind)}
                </select>
              </div>

              <details className="text-xs">
                <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">
                  Branch overrides ({overrides.length})
                </summary>
                <div className="space-y-3 pt-2">
                  {overrides.map((o) => (
                    <div
                      key={o.branchId}
                      className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_2fr_auto]"
                    >
                      <p className="font-semibold text-fg-strong">
                        {branchById.get(o.branchId!)?.name ?? o.branchId}
                      </p>
                      <select
                        aria-label={`Series for ${branchById.get(o.branchId!)?.name ?? 'branch'}`}
                        value={o.seriesId}
                        onChange={(e) => askToChange(kind, o.branchId, e.target.value || null)}
                        className={fieldClass}
                      >
                        {options(kind)}
                      </select>
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => askToChange(kind, o.branchId, null)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {adding?.kind === kind.kind ? (
                    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_2fr_auto]">
                      <select
                        aria-label="Branch"
                        value={adding.branchId}
                        onChange={(e) => setAdding({ ...adding, branchId: e.target.value })}
                        className={fieldClass}
                      >
                        <option value="">Choose a branch…</option>
                        {view.branches
                          .filter((b) => !overrides.some((o) => o.branchId === b.id))
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name} ({b.code})
                            </option>
                          ))}
                      </select>
                      <select
                        aria-label="Series"
                        value={adding.seriesId}
                        onChange={(e) => setAdding({ ...adding, seriesId: e.target.value })}
                        className={fieldClass}
                      >
                        <option value="">Choose a series…</option>
                        {options(kind)}
                      </select>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={!adding.branchId || !adding.seriesId}
                        onClick={() => askToChange(kind, adding.branchId, adding.seriesId)}
                      >
                        Add
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => setAdding({ kind: kind.kind, branchId: '', seriesId: '' })}
                    >
                      Add a branch override
                    </button>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
