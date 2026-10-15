'use client';

import { useId, useState } from 'react';
import { groupsPageAction, saveGroupAction, type ApproverGroupView } from '@/server/kernel/approvals/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt } from '@/components/ui/screen-kit';
import { groupPayload, moveMember } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import { EmptyState, Notice, buttonClass, cardClass, fieldClass, labelClass, primaryButtonClass, type Message } from './shared';

type FirstPage = Extract<Awaited<ReturnType<typeof groupsPageAction>>, { ok: true }>;

export function ApproversGroups({ first }: { first: FirstPage }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const list = usePagedList<ApproverGroupView, { query: string }>({
    load: (filters, cursor) => groupsPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const saved = (text: string) => {
    setEditing(null);
    setMessage({ kind: 'ok', text });
    list.reload();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-sm flex-1">
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search groups
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or code" className={fieldClass} autoComplete="off" />
        </div>
        <button type="button" className={primaryButtonClass} onClick={() => setEditing(editing === 'new' ? null : 'new')} aria-expanded={editing === 'new'}>
          New group
        </button>
      </div>
      <Notice message={message} />
      {editing === 'new' ? (
        <div className={cardClass}>
          <GroupForm onSaved={() => saved('Group created.')} />
        </div>
      ) : null}
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
      {list.phase === 'idle' && list.rows.length === 0 && editing !== 'new' ? (
        <EmptyState title={query.trim() === '' ? 'No approver groups yet' : `No group matches “${query.trim()}”`}>
          A group lets a step be approved by several people, in order or by whoever responds first.
        </EmptyState>
      ) : null}
      <ul className="space-y-3" aria-label="Approver groups">
        {list.rows.map((g) => (
          <li key={g.id} className={cardClass}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-fg-strong">{g.name}</h3>
                <p className="font-mono text-xs text-fg-muted">{g.code}</p>
                <p className="mt-1 text-sm text-fg">{g.members.length === 0 ? 'No members yet.' : g.members.map((m) => m.name).join(' → ')}</p>
              </div>
              <button type="button" className={buttonClass} aria-expanded={editing === g.id} aria-label={`${editing === g.id ? 'Close' : 'Edit'} ${g.name}`} onClick={() => setEditing(editing === g.id ? null : g.id)}>
                {editing === g.id ? 'Close' : 'Edit'}
              </button>
            </div>
            {editing === g.id ? <GroupForm group={g} onSaved={() => saved(`Saved ${g.name}.`)} /> : null}
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more groups'}
        </button>
      )}
    </div>
  );
}

function GroupForm({ group, onSaved }: { group?: ApproverGroupView; onSaved: () => void }) {
  const uid = useId();
  const [form, setForm] = useState({ code: group?.code ?? '', name: group?.name ?? '' });
  const [members, setMembers] = useState<{ id: string; name: string }[]>(group?.members ?? []);
  const [adding, setAdding] = useState<Choice | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const move = (i: number, by: -1 | 1) => {
    const order = moveMember(members.map((m) => m.id), i, by);
    setMembers(order.flatMap((id) => members.filter((m) => m.id === id)));
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = groupPayload(group?.id, form, members.map((m) => m.id));
    if (!checked.ok) {
      setMessage({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await attempt(saveGroupAction(checked.payload, reason));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    onSaved();
  };

  return (
    <form onSubmit={(e) => void save(e)} className="mt-4 space-y-4 border-t border-line pt-4" aria-label={group ? `Edit ${group.name}` : 'New group'}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-n`} className={labelClass}>
            Name
          </label>
          <input id={`${uid}-n`} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fieldClass} />
        </div>
        <div>
          <label htmlFor={`${uid}-c`} className={labelClass}>
            Code
          </label>
          <input id={`${uid}-c`} required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className={`${fieldClass} font-mono`} />
        </div>
      </div>
      <div>
        <p className={labelClass}>Members, in the order they are asked</p>
        {members.length === 0 ? (
          <p className="text-sm text-fg-muted">No members yet.</p>
        ) : (
          <ol className="space-y-2">
            {members.map((m, i) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-sm text-fg-muted">{i + 1}.</span>
                <span className="min-w-32 flex-1 text-sm text-fg">{m.name}</span>
                <button type="button" className={buttonClass} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${m.name} up`}>
                  ↑
                </button>
                <button type="button" className={buttonClass} disabled={i === members.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${m.name} down`}>
                  ↓
                </button>
                <button type="button" className={buttonClass} onClick={() => setMembers(members.filter((x) => x.id !== m.id))} aria-label={`Remove ${m.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-3 grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_auto]">
          <ChoicePicker label="Add a member" source="approval-users" choice={adding} onChoice={setAdding} placeholder="Choose a person…" />
          <button
            type="button"
            className={buttonClass}
            disabled={adding === null || members.some((m) => m.id === adding.id)}
            onClick={() => {
              if (adding === null) return;
              setMembers([...members, { id: adding.id, name: adding.label }]);
              setAdding(null);
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
