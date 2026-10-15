'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveGroupAction,
  saveProfileAction,
  type Lookups,
  type ProfileView,
} from '@/server/kernel/approvals/actions';
import { DOCUMENT_KIND_LABELS, TRIGGERS } from '@/server/kernel/approvals/domain/triggers';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  money,
  primaryButtonClass,
  type Message,
} from './shared';

import { emptyToNull, has } from '@/lib/values';

const KINDS = [...new Set(TRIGGERS.map((t) => t.documentKind))];
type User = Lookups['users'][number];
type Group = Lookups['groups'][number];

export function ApproversClient({
  lookups,
  profiles,
}: {
  lookups: Lookups;
  profiles: ProfileView[];
}) {
  const uid = useId();
  const [tab, setTab] = useState<'people' | 'groups'>('people');
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Approvers">
        Set who is above whom, who covers while someone is away, and how much each person may
        approve for each kind of document. Changes apply to approvals that have not been asked yet;
        ones already waiting are not touched.
      </PageHeader>
      <div role="tablist" aria-label="Approvers" className="flex gap-2">
        {(
          [
            ['people', 'People and limits'],
            ['groups', 'Groups'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            id={`${uid}-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`${uid}-panel-${key}`}
            onClick={() => setTab(key)}
            className={`${buttonClass} ${tab === key ? 'border-indigo-500 bg-indigo-500/10' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`}>
        {tab === 'people' ? (
          <People lookups={lookups} profiles={profiles} />
        ) : (
          <Groups lookups={lookups} />
        )}
      </div>
    </div>
  );
}

function People({ lookups, profiles }: { lookups: Lookups; profiles: ProfileView[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const name = (id: string | null) => lookups.users.find((u) => u.id === id)?.name ?? null;

  if (lookups.users.length === 0) return <EmptyState title="There are no staff accounts yet" />;
  return (
    <div className="space-y-3">
      <Notice message={message} />
      <ul className="space-y-3">
        {lookups.users.map((u) => {
          const p = profiles.find((x) => x.userId === u.id);
          return (
            <li key={u.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-fg-strong">{u.name}</h3>
                  <p className="text-xs text-fg-muted">{u.email}</p>
                  {p ? (
                    <div className="mt-2 space-y-1 text-sm text-fg">
                      <p>Reports to: {name(p.approverUserId) ?? 'nobody (top of the chain)'}</p>
                      {has(p.substituteUserId) ? (
                        <p>
                          Covered by {name(p.substituteUserId)}
                          {has(p.substituteFrom) || has(p.substituteTo)
                            ? ` (${p.substituteFrom ?? '…'} to ${p.substituteTo ?? '…'})`
                            : ''}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {!p.isActive ? <Chip tone="grey">Not approving</Chip> : null}
                        {p.limits.length === 0 ? (
                          <Chip tone="grey">No approval authority</Chip>
                        ) : null}
                        {p.limits.map((l) => (
                          <Chip key={l.documentKind} tone={l.unlimited ? 'green' : 'sky'}>
                            {DOCUMENT_KIND_LABELS[l.documentKind] ?? l.documentKind}:{' '}
                            {l.unlimited ? 'unlimited' : `up to ${money(l.maxAmount ?? 0)}`}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-fg-muted">Not set up as an approver.</p>
                  )}
                </div>
                <button
                  type="button"
                  className={buttonClass}
                  aria-expanded={editing === u.id}
                  onClick={() => setEditing(editing === u.id ? null : u.id)}
                >
                  {editing === u.id ? 'Close' : p ? 'Edit' : 'Set up'}
                </button>
              </div>
              {editing === u.id ? (
                <ProfileForm
                  user={u}
                  profile={p}
                  lookups={lookups}
                  onSaved={() => {
                    setEditing(null);
                    setMessage({ kind: 'ok', text: `Saved ${u.name}.` });
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type LimitMode = 'none' | 'up_to' | 'unlimited';

function ProfileForm({
  user,
  profile,
  lookups,
  onSaved,
}: {
  user: User;
  profile: ProfileView | undefined;
  lookups: Lookups;
  onSaved: () => void;
}) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState({
    approverUserId: profile?.approverUserId ?? '',
    substituteUserId: profile?.substituteUserId ?? '',
    substituteFrom: profile?.substituteFrom ?? '',
    substituteTo: profile?.substituteTo ?? '',
    isActive: profile?.isActive ?? true,
  });
  const [limits, setLimits] = useState<Record<string, { mode: LimitMode; amount: string }>>(
    () =>
      Object.fromEntries(
        KINDS.map((k) => {
          const l = profile?.limits.find((x) => x.documentKind === k);
          return [
            k,
            l
              ? l.unlimited
                ? { mode: 'unlimited', amount: '' }
                : { mode: 'up_to', amount: String(l.maxAmount ?? 0) }
              : { mode: 'none', amount: '' },
          ];
        }),
      ),
  );
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const others = lookups.users.filter((u) => u.id !== user.id);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await saveProfileAction(
      {
        userId: user.id,
        approverUserId: emptyToNull(form.approverUserId),
        substituteUserId: emptyToNull(form.substituteUserId),
        substituteFrom: has(form.substituteUserId) ? emptyToNull(form.substituteFrom) : null,
        substituteTo: has(form.substituteUserId) ? emptyToNull(form.substituteTo) : null,
        isActive: form.isActive,
        limits: KINDS.filter((k) => limits[k]!.mode !== 'none').map((k) => ({
          documentKind: k,
          unlimited: limits[k]!.mode === 'unlimited',
          maxAmount: limits[k]!.mode === 'up_to' ? Number(limits[k]!.amount) : null,
        })),
      },
      reason,
    );
    setBusy(false);
    if (!res.ok) { setMessage({ kind: 'error', text: res.error }); return; }
    router.refresh();
    onSaved();
  };

  return (
    <form
      onSubmit={save}
      className="mt-4 space-y-5 border-t border-line pt-4"
      aria-label={`Approver settings for ${user.name}`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-up`} className={labelClass}>
            Their approver (next level up)
          </label>
          <select
            id={`${uid}-up`}
            value={form.approverUserId}
            onChange={(e) => setForm({ ...form, approverUserId: e.target.value })}
            className={fieldClass}
          >
            <option value="">Nobody: top of the chain</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            Can approve (untick while they are away for good)
          </label>
        </div>
        <div>
          <label htmlFor={`${uid}-sub`} className={labelClass}>
            Covered by (while away)
          </label>
          <select
            id={`${uid}-sub`}
            value={form.substituteUserId}
            onChange={(e) => setForm({ ...form, substituteUserId: e.target.value })}
            className={fieldClass}
          >
            <option value="">Nobody</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        {has(form.substituteUserId) ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-from`} className={labelClass}>
                From
              </label>
              <input
                id={`${uid}-from`}
                type="date"
                value={form.substituteFrom}
                onChange={(e) => setForm({ ...form, substituteFrom: e.target.value })}
                className={fieldClass}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-to`} className={labelClass}>
                Until
              </label>
              <input
                id={`${uid}-to`}
                type="date"
                value={form.substituteTo}
                onChange={(e) => setForm({ ...form, substituteTo: e.target.value })}
                className={fieldClass}
              />
            </div>
          </div>
        ) : null}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-xs font-bold tracking-wide text-fg-muted uppercase">
          What they may approve (KES)
        </legend>
        {KINDS.map((k) => (
          <div key={k} className="flex flex-wrap items-center gap-3">
            <span className="w-52 text-sm text-fg">{DOCUMENT_KIND_LABELS[k] ?? k}</span>
            <select
              aria-label={`Authority for ${DOCUMENT_KIND_LABELS[k] ?? k}`}
              value={limits[k]!.mode}
              onChange={(e) =>
                setLimits({ ...limits, [k]: { ...limits[k]!, mode: e.target.value as LimitMode } })
              }
              className={`${fieldClass} w-auto`}
            >
              <option value="none">Cannot cover amounts</option>
              <option value="up_to">Up to…</option>
              <option value="unlimited">Any amount</option>
            </select>
            {limits[k]!.mode === 'up_to' ? (
              <input
                type="number"
                min={0}
                required
                aria-label={`Limit for ${DOCUMENT_KIND_LABELS[k] ?? k}`}
                value={limits[k]!.amount}
                onChange={(e) =>
                  setLimits({ ...limits, [k]: { ...limits[k]!, amount: e.target.value } })
                }
                className={`${fieldClass} w-40`}
              />
            ) : null}
          </div>
        ))}
        <p className="text-xs text-fg-muted">
          Limits decide how far up the chain a request climbs. Someone who can approve any amount
          ends it.
        </p>
      </fieldset>

      <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
      <Notice message={message} />
      <button type="submit" className={primaryButtonClass} disabled={busy || reason.code === ''}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function Groups({ lookups }: { lookups: Lookups }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const name = (id: string) => lookups.users.find((u) => u.id === id)?.name ?? 'Unknown';
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          type="button"
          className={primaryButtonClass}
          onClick={() => setEditing(editing === 'new' ? null : 'new')}
          aria-expanded={editing === 'new'}
        >
          New group
        </button>
      </div>
      <Notice message={message} />
      {editing === 'new' ? (
        <div className={cardClass}>
          <GroupForm
            lookups={lookups}
            onSaved={() => {
              setEditing(null);
              setMessage({ kind: 'ok', text: 'Group created.' });
            }}
          />
        </div>
      ) : null}
      {lookups.groups.length === 0 && editing !== 'new' ? (
        <EmptyState title="No approver groups yet">
          A group lets a step be approved by several people, in order or by whoever responds first.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {lookups.groups.map((g) => (
            <li key={g.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-fg-strong">{g.name}</h3>
                  <p className="font-mono text-xs text-fg-muted">{g.code}</p>
                  <p className="mt-1 text-sm text-fg">
                    {g.memberIds.length === 0
                      ? 'No members yet.'
                      : g.memberIds.map(name).join(' → ')}
                  </p>
                </div>
                <button
                  type="button"
                  className={buttonClass}
                  aria-expanded={editing === g.id}
                  onClick={() => setEditing(editing === g.id ? null : g.id)}
                >
                  {editing === g.id ? 'Close' : 'Edit'}
                </button>
              </div>
              {editing === g.id ? (
                <GroupForm
                  group={g}
                  lookups={lookups}
                  onSaved={() => {
                    setEditing(null);
                    setMessage({ kind: 'ok', text: `Saved ${g.name}.` });
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupForm({
  group,
  lookups,
  onSaved,
}: {
  group?: Group;
  lookups: Lookups;
  onSaved: () => void;
}) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState({ code: group?.code ?? '', name: group?.name ?? '' });
  const [members, setMembers] = useState<string[]>(group?.memberIds ?? []);
  const [adding, setAdding] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const name = (id: string) => lookups.users.find((u) => u.id === id)?.name ?? 'Unknown';
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= members.length) return;
    const next = [...members];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setMembers(next);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await saveGroupAction({ id: group?.id, ...form, memberUserIds: members }, reason);
    setBusy(false);
    if (!res.ok) { setMessage({ kind: 'error', text: res.error }); return; }
    router.refresh();
    onSaved();
  };

  return (
    <form
      onSubmit={save}
      className="mt-4 space-y-4 border-t border-line pt-4"
      aria-label={group ? `Edit ${group.name}` : 'New group'}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-n`} className={labelClass}>
            Name
          </label>
          <input
            id={`${uid}-n`}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-c`} className={labelClass}>
            Code
          </label>
          <input
            id={`${uid}-c`}
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            className={`${fieldClass} font-mono`}
          />
        </div>
      </div>
      <div>
        <p className={labelClass}>Members, in the order they are asked</p>
        {members.length === 0 ? (
          <p className="text-sm text-fg-muted">No members yet.</p>
        ) : (
          <ol className="space-y-2">
            {members.map((m, i) => (
              <li key={m} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-sm text-fg-muted">{i + 1}.</span>
                <span className="min-w-32 flex-1 text-sm text-fg">{name(m)}</span>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${name(m)} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={i === members.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${name(m)} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => setMembers(members.filter((x) => x !== m))}
                  aria-label={`Remove ${name(m)}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor={`${uid}-add`} className="sr-only">
            Add a member
          </label>
          <select
            id={`${uid}-add`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className={`${fieldClass} w-auto`}
          >
            <option value="">Add a member…</option>
            {lookups.users
              .filter((u) => !members.includes(u.id))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className={buttonClass}
            disabled={adding === ''}
            onClick={() => {
              setMembers([...members, adding]);
              setAdding('');
            }}
          >
            Add
          </button>
        </div>
      </div>
      <ReasonField value={reason} onChange={setReason} source="approval-config-reasons" />
      <Notice message={message} />
      <button type="submit" className={primaryButtonClass} disabled={busy || reason.code === ''}>
        {busy ? 'Saving…' : 'Save group'}
      </button>
    </form>
  );
}
