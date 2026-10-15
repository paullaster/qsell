'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { clearNumberBindingAction, getBindingsAction, setNumberBindingAction, type BindingsView } from '@/server/kernel/numbering/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, Chip, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { bindingQuestion, defaultBinding, overridesOf, seriesCodeOf } from '@/lib/number-series-forms';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';
import { ReasonField, reasonReady, type ReasonValue } from './ReasonField';

type Kind = BindingsView['kinds'][number];

interface Pending {
  kind: Kind;
  branchId: string | null;
  branchLabel: string;
  series: Choice | null;
}

const noReason: ReasonValue = { code: '', text: '' };
const toChoice = (id: string | undefined, label: string | undefined): Choice | null => (id === undefined ? null : { id, label: label ?? id });

export function DocumentNumberingClient({ viewPromise }: { viewPromise: ReturnType<typeof getBindingsAction> }) {
  const first = use(viewPromise);
  return first.ok ? <BindingsScreen initial={first.data} /> : <LoadFailed error={first.error} />;
}

function BindingsScreen({ initial }: { initial: BindingsView }) {
  const [view, setView] = useState(initial);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState<{ kind: string; branch: Choice | null; series: Choice | null } | null>(null);

  const askToChange = (kind: Kind, branch: Choice | null, series: Choice | null) => {
    setNotice(null);
    setReason(noReason);
    setPending({ kind, branchId: branch?.id ?? null, branchLabel: branch?.label ?? 'all branches', series });
  };

  const confirm = async () => {
    if (pending === null) return;
    setBusy(true);
    const res =
      pending.series === null
        ? await attempt(clearNumberBindingAction(pending.kind.kind, pending.branchId, reason))
        : await attempt(setNumberBindingAction({ documentKind: pending.kind.kind, branchId: pending.branchId, seriesId: pending.series.id }, reason));
    if (!res.ok) {
      setBusy(false);
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    const fresh = await attempt(getBindingsAction());
    setBusy(false);
    if (fresh.ok) setView(fresh.data);
    setNotice({ kind: 'ok', text: `${pending.kind.label} numbering updated.` });
    setPending(null);
    setAdding(null);
  };

  return (
    <div className="max-w-5xl space-y-6">
      <Link href="/admin/settings/number-series" className="inline-flex min-h-10 items-center text-xs font-semibold text-indigo-500 underline">
        ← All number series
      </Link>
      <PageHeader
        title="Document numbering"
        intro="Choose which series numbers each kind of document. A branch can have its own series; otherwise the default applies. Fiscal documents can only use gap-free series."
      />
      <Message notice={notice} />

      {pending === null ? null : (
        <section className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4" aria-label="Confirm change">
          <p className="text-sm font-semibold text-fg-strong">
            {bindingQuestion({ kindLabel: pending.kind.label, branchLabel: pending.branchLabel, seriesCode: pending.series === null ? null : seriesCodeOf(pending.series.label) })}
          </p>
          <ReasonField value={reason} onChange={setReason} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !reasonReady(reason)} onClick={() => void confirm()} className={primaryClass}>
              {busy ? 'Saving…' : 'Confirm change'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <ul className="space-y-3" aria-label="Kinds of document">
        {view.kinds.map((kind) => {
          const def = defaultBinding(view.bindings, kind.kind);
          const overrides = overridesOf(view.bindings, kind.kind);
          const seriesFilters = kind.fiscal ? { fiscal: '1' } : undefined;
          const addingHere = adding?.kind === kind.kind ? adding : null;
          return (
            <li key={kind.kind} className="space-y-3 rounded-xl border border-line bg-surface-raised p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-fg-strong">
                  {kind.label} {kind.fiscal ? <Chip tone="green">Fiscal · gap-free only</Chip> : null}
                </p>
                <p className="text-xs text-fg-muted">
                  Next number: <span className="font-mono text-fg-strong">{view.examples[kind.kind] ?? '— not set up —'}</span>
                </p>
              </div>
              <ChoicePicker
                label={`Default series for ${kind.label}`}
                source="number-series"
                filters={seriesFilters}
                choice={toChoice(def?.seriesId, def?.seriesLabel)}
                onChoice={(next) => askToChange(kind, null, next)}
                placeholder="None — this document cannot be numbered"
              />

              <details className="text-xs">
                <summary className="min-h-10 cursor-pointer py-2 font-semibold text-indigo-500">Branch overrides ({overrides.length})</summary>
                <div className="space-y-3 pt-2">
                  {overrides.map((o) => (
                    <div key={o.branchId} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_2fr_auto]">
                      <p className="font-semibold text-fg-strong">{o.branchLabel ?? o.branchId}</p>
                      <ChoicePicker
                        label={`Series for ${o.branchLabel ?? 'branch'}`}
                        source="number-series"
                        filters={seriesFilters}
                        choice={toChoice(o.seriesId, o.seriesLabel)}
                        onChoice={(next) => askToChange(kind, toChoice(o.branchId ?? undefined, o.branchLabel ?? undefined), next)}
                        clearable={false}
                      />
                      <button type="button" className={buttonClass} onClick={() => askToChange(kind, toChoice(o.branchId ?? undefined, o.branchLabel ?? undefined), null)} aria-label={`Remove the override for ${o.branchLabel ?? 'branch'}`}>
                        Remove
                      </button>
                    </div>
                  ))}
                  {addingHere === null ? (
                    <button type="button" className={buttonClass} onClick={() => setAdding({ kind: kind.kind, branch: null, series: null })}>
                      Add a branch override
                    </button>
                  ) : (
                    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_2fr_auto]" role="group" aria-label={`New override for ${kind.label}`}>
                      <ChoicePicker label="Branch" source="numbering-branches" filters={{ unbound: kind.kind }} choice={addingHere.branch} onChoice={(branch) => setAdding({ ...addingHere, branch })} placeholder="Choose a branch…" />
                      <ChoicePicker label="Series" source="number-series" filters={seriesFilters} choice={addingHere.series} onChoice={(series) => setAdding({ ...addingHere, series })} placeholder="Choose a series…" />
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={addingHere.branch === null || addingHere.series === null || !has(addingHere.branch.id)}
                        onClick={() => askToChange(kind, addingHere.branch, addingHere.series)}
                      >
                        Add
                      </button>
                    </div>
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
