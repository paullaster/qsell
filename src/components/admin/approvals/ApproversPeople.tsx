'use client';

import { useId, useState } from 'react';
import { peoplePageAction, saveProfileAction } from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS, TRIGGERS } from '@/server/kernel/approvals/domain/triggers';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, Field } from '@/components/ui/screen-kit';
import { AUTHORITY_MODES, labelIn, limitsFrom, profilePayload, type LimitInput, type LimitMode, type ProfileForm } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import { Chip, EmptyState, Notice, buttonClass, cardClass, fieldClass, labelClass, money, primaryButtonClass, type Message } from './shared';

const KINDS = [...new Set(TRIGGERS.map((t) => t.documentKind))];
type FirstPage = Extract<Awaited<ReturnType<typeof peoplePageAction>>, { ok: true }>;
type Person = FirstPage['data']['rows'][number];

/** The word on a person's button: close the open form, or set up a new approver, or edit one. */
const buttonWords = (open: boolean, isNew: boolean): string => {
  if (open) return 'Close';
  return isNew ? 'Set up' : 'Edit';
};

const choiceOf = (id: string | null, label: string | null): Choice | null => (id === null ? null : { id, label: label ?? id });

export function ApproversPeople({ first }: { first: FirstPage }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const list = usePagedList<Person, { query: string }>({
    load: (filters, cursor) => peoplePageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  return (
    <div className="space-y-3">
      <Notice message={message} />
      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search staff
        </label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" className={fieldClass} autoComplete="off" />
      </div>
      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}
      {list.phase === 'idle' && list.rows.length === 0 ? <EmptyState title={query.trim() === '' ? 'There are no staff accounts yet' : `Nobody matches “${query.trim()}”`} /> : null}
      <ul className="space-y-3" aria-label="Staff">
        {list.rows.map((u) => (
          <li key={u.id} className={cardClass}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-fg-strong">{u.name}</h3>
                <p className="text-xs text-fg-muted">{u.email}</p>
                <Summary person={u} />
              </div>
              <button type="button" className={buttonClass} aria-expanded={editing === u.id} aria-label={`${buttonWords(editing === u.id, u.profile === null)} ${u.name}`} onClick={() => setEditing(editing === u.id ? null : u.id)}>
                {buttonWords(editing === u.id, u.profile === null)}
              </button>
            </div>
            {editing === u.id ? (
              <ProfileForm
                person={u}
                onSaved={() => {
                  setEditing(null);
                  setMessage({ kind: 'ok', text: `Saved ${u.name}.` });
                  list.reload();
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more people'}
        </button>
      )}
    </div>
  );
}

function Summary({ person: u }: { person: Person }) {
  const p = u.profile;
  if (p === null) return <p className="mt-2 text-sm text-fg-muted">Not set up as an approver.</p>;
  return (
    <div className="mt-2 space-y-1 text-sm text-fg">
      <p>Reports to: {u.reportsToName ?? 'nobody (top of the chain)'}</p>
      {has(p.substituteUserId) ? (
        <p>
          Covered by {u.coveredByName ?? 'someone'}
          {has(p.substituteFrom) || has(p.substituteTo) ? ` (${p.substituteFrom ?? '…'} to ${p.substituteTo ?? '…'})` : ''}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {p.isActive ? null : <Chip tone="grey">Not approving</Chip>}
        {p.limits.length === 0 ? <Chip tone="grey">No approval authority</Chip> : null}
        {p.limits.map((l) => (
          <Chip key={l.documentKind} tone={l.unlimited ? 'green' : 'sky'}>
            {DOCUMENT_KIND_LABELS[l.documentKind] ?? l.documentKind}: {l.unlimited ? 'unlimited' : `up to ${money(l.maxAmount ?? 0)}`}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function ProfileForm({ person, onSaved }: { person: Person; onSaved: () => void }) {
  const uid = useId();
  const profile = person.profile;
  const [form, setForm] = useState<ProfileForm>({
    approverUserId: profile?.approverUserId ?? '',
    substituteUserId: profile?.substituteUserId ?? '',
    substituteFrom: profile?.substituteFrom ?? '',
    substituteTo: profile?.substituteTo ?? '',
    isActive: profile?.isActive ?? true,
  });
  const [approver, setApprover] = useState<Choice | null>(choiceOf(profile?.approverUserId ?? null, person.reportsToName));
  const [cover, setCover] = useState<Choice | null>(choiceOf(profile?.substituteUserId ?? null, person.coveredByName));
  const [limits, setLimits] = useState<Record<string, LimitInput>>(() => limitsFrom(KINDS, profile?.limits ?? []));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = profilePayload(person.id, { ...form, approverUserId: approver?.id ?? '', substituteUserId: cover?.id ?? '' }, KINDS, limits);
    if (!checked.ok) {
      setMessage({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await attempt(saveProfileAction(checked.payload, reason));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    onSaved();
  };

  const setLimit = (kind: string, next: Partial<LimitInput>) => setLimits((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? { mode: 'none', amount: '' }), ...next } }));

  return (
    <form onSubmit={(e) => void save(e)} className="mt-4 space-y-5 border-t border-line pt-4" aria-label={`Approver settings for ${person.name}`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ChoicePicker label="Their approver (next level up)" source="approval-users" filters={{ exclude: person.id }} choice={approver} onChoice={setApprover} placeholder="Nobody: top of the chain" />
        <div className="flex items-end">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="size-4" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Takes part in approvals
          </label>
        </div>
        <ChoicePicker label="Covered by (while away)" source="approval-users" filters={{ exclude: person.id }} choice={cover} onChoice={setCover} placeholder="Nobody" />
        {cover === null ? null : (
          <div className="grid grid-cols-2 gap-3">
            <Field id={`${uid}-from`} label="From">
              <input id={`${uid}-from`} type="date" value={form.substituteFrom} onChange={(e) => setForm({ ...form, substituteFrom: e.target.value })} className={fieldClass} />
            </Field>
            <Field id={`${uid}-to`} label="To">
              <input id={`${uid}-to`} type="date" value={form.substituteTo} onChange={(e) => setForm({ ...form, substituteTo: e.target.value })} className={fieldClass} />
            </Field>
          </div>
        )}
      </div>

      <fieldset className="space-y-3">
        <legend className={labelClass}>What they may approve, by kind of document</legend>
        {KINDS.map((k) => {
          const l = limits[k] ?? { mode: 'none' as LimitMode, amount: '' };
          const kindLabel = DOCUMENT_KIND_LABELS[k] ?? k;
          return (
            <div key={k} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[13rem_14rem_1fr]">
              <span className="text-sm text-fg">{kindLabel}</span>
              <ChoicePicker
                label={`Authority for ${kindLabel}`}
                source="approval-authority-modes"
                choice={{ id: l.mode, label: labelIn(AUTHORITY_MODES, l.mode) }}
                onChoice={(c) => setLimit(k, { mode: (AUTHORITY_MODES.find((m) => m.id === c?.id)?.id ?? 'none') })}
                clearable={false}
              />
              {l.mode === 'up_to' ? (
                <Field id={`${uid}-${k}`} label={`Amount for ${kindLabel} (KES)`}>
                  <input id={`${uid}-${k}`} type="number" min={0} required value={l.amount} onChange={(e) => setLimit(k, { amount: e.target.value })} className={`${fieldClass} w-40`} />
                </Field>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-fg-muted">Limits decide how far up the chain a request climbs. Someone who can approve any amount ends it.</p>
      </fieldset>

      <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
      <Notice message={message} />
      <button type="submit" className={primaryButtonClass} disabled={busy || reason.code === ''}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
