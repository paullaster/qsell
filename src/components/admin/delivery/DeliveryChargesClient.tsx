'use client';

import { use, useId, useState } from 'react';
import {
  activateChargePolicyAction,
  chargePoliciesPageAction,
  deleteChargePolicyDraftAction,
  getChargePolicyAction,
  newChargePolicyVersionAction,
  retireChargePolicyAction,
  type PolicySummary,
  type PolicyView,
} from '@/server/domains/delivery/policy-actions';
import { ChargePolicyEditor } from './ChargePolicyEditor';
import { ChargeSimulator } from './ChargeSimulator';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { Field, attempt, buttonClass, cardClass, Chip, fieldClass, LoadFailed, Message, PageHeader, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { CHARGE_METHOD_WORDS, type ChargeMethod } from '@/server/domains/delivery/domain/types';

type FirstPage = Awaited<ReturnType<typeof chargePoliciesPageAction>>;
type Filter = 'live' | 'retired' | 'all';

const STATUS: Record<PolicySummary['status'], { words: string; tone: 'green' | 'amber' | 'gray' }> = { in_force: { words: 'In force', tone: 'green' }, draft: { words: 'Draft', tone: 'amber' }, retired: { words: 'Retired', tone: 'gray' } };

export function DeliveryChargesClient({ firstPage, canManage }: { firstPage: ReturnType<typeof chargePoliciesPageAction>; canManage: Promise<boolean> }) {
  const first = use(firstPage);
  const may = use(canManage);
  return first.ok ? <ChargesView first={first} may={may} /> : <LoadFailed error={first.error} />;
}

/** A button that asks why before it acts, so the reason is kept with the change. */
function ReasonAction({ label, action, confirm, busy, onConfirm }: { label: string; action: string; confirm: string; busy: boolean; onConfirm: (reason: string) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button type="button" className={buttonClass} disabled={busy} onClick={() => setOpen(true)} aria-label={label}>
        {action}
      </button>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 5) {
          setOpen(false);
          onConfirm(reason.trim());
          setReason('');
        }
      }}
    >
      <div className="min-w-0 flex-1 basis-64">
        <Field id={`${uid}-reason`} label="Why? (kept with the change)">
          <input id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} maxLength={300} autoComplete="off" autoFocus />
        </Field>
      </div>
      <button type="submit" className={primaryClass} disabled={busy || reason.trim().length < 5} aria-label={`Confirm: ${label}`}>
        {confirm}
      </button>
      <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
        Keep it as it is
      </button>
    </form>
  );
}

function ChargesView({ first, may }: { first: FirstPage; may: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('live');
  const [editing, setEditing] = useState<PolicyView | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<PolicySummary, { query: string; filter: Filter }>({
    load: (filters, cursor) => chargePoliciesPageAction({ query: filters.query, cursor, status: filters.filter }),
    filters: { query: query.trim(), filter },
    initialPage: first,
  });

  const run = async (call: Promise<{ ok: true } | { ok: false; error: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(call);
    setBusy(false);
    if (res.ok) {
      setNotice({ kind: 'ok', text: success });
      list.reload();
    } else setNotice({ kind: 'error', text: res.error });
  };
  const open = async (p: PolicySummary) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(getChargePolicyAction(p.id));
    setBusy(false);
    if (res.ok) setEditing(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Delivery charges"
        intro="How much delivery costs. A policy says how the charge is worked out (by zone, a flat fee or by weight, or by distance), who it is for, and the extras: busy-time charges, discounts for bigger orders, a least and most charge. A policy in force is never edited, so every past charge can be explained: change it by making a new version."
        actions={
          may && editing === null ? (
            <button
              type="button"
              className={primaryClass}
              onClick={() => {
                setNotice(null);
                setEditing('new');
              }}
            >
              New policy
            </button>
          ) : null
        }
      />
      <Message notice={notice} />

      {editing === null ? null : (
        <section className={`${cardClass} space-y-3`} aria-label={editing === 'new' ? 'New charge policy' : `${editing.code} version ${String(editing.version)}`}>
          <h3 className="text-sm font-bold text-fg-strong">{editing === 'new' ? 'New charge policy' : `${editing.name} (${editing.code}, version ${String(editing.version)})`}</h3>
          <ChargePolicyEditor
            key={editing === 'new' ? 'new' : `${editing.id}-${String(editing.revision)}`}
            policy={editing === 'new' ? null : editing}
            currency="KES"
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null);
              setNotice({ kind: 'ok', text: `${saved.code} version ${String(saved.version)} saved as a draft. Put it in force when it is ready.` });
              list.reload();
            }}
          />
        </section>
      )}

      <ChargeSimulator />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end">
        <div>
          <label htmlFor={`${uid}-search`} className="sr-only">
            Search policies
          </label>
          <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code or name" className={fieldClass} autoComplete="off" />
        </div>
        <div role="radiogroup" aria-label="Which policies to show" className="flex flex-wrap gap-x-4">
          {([['live', 'In force and drafts'], ['retired', 'Retired'], ['all', 'All']] as const).map(([value, words]) => (
            <label key={value} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${uid}-filter`} checked={filter === value} onChange={() => setFilter(value)} />
              {words}
            </label>
          ))}
        </div>
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

      <ul className="space-y-2" aria-label="Charge policies">
        {list.rows.map((p) => {
          const scopeCount = Object.values(p.scopes).filter((r) => r.values.length > 0).length;
          return (
            <li key={p.id} className="rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold break-words text-fg-strong">
                    <span className="font-mono">{p.code}</span> · {p.name} <span className="font-normal text-fg-muted">version {p.version}</span>
                  </p>
                  <p className="mt-1.5 flex flex-wrap gap-1.5">
                    <Chip tone={STATUS[p.status].tone}>{STATUS[p.status].words}</Chip>
                    <Chip tone="gray">{CHARGE_METHOD_WORDS[p.method as ChargeMethod].name}</Chip>
                    <Chip tone="gray">{p.currency}</Chip>
                    <Chip tone="gray">{scopeCount === 0 ? 'Every order' : `Limited in ${String(scopeCount)} way${scopeCount === 1 ? '' : 's'}`}</Chip>
                    {p.priority === 0 ? null : <Chip tone="gray">Priority {p.priority}</Chip>}
                    <Chip tone="gray">
                      {p.firstDay}
                      {p.lastDay === null ? ' onwards' : ` to ${p.lastDay}`}
                    </Chip>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => void open(p)} aria-label={`${p.status === 'draft' && may ? 'Edit' : 'Open'} ${p.code} version ${String(p.version)}`}>
                    {p.status === 'draft' && may ? 'Edit' : 'Open'}
                  </button>
                  {may && p.status !== 'draft' ? (
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(newChargePolicyVersionAction(p.id), `A draft of ${p.code} version ${String(p.version + 1)} is ready to change.`)} aria-label={`Make a new version of ${p.code}`}>
                      New version
                    </button>
                  ) : null}
                  {may && p.status === 'draft' ? <InlineConfirm label={`Discard ${p.code} version ${String(p.version)}`} action="Discard" confirm="Yes, discard it" busy={busy} onConfirm={() => void run(deleteChargePolicyDraftAction(p.id), `${p.code} version ${String(p.version)} discarded.`)} /> : null}
                </div>
              </div>
              {may && (p.status === 'draft' || p.status === 'in_force') ? (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  {p.status === 'draft' ? (
                    <ReasonAction label={`Put ${p.code} version ${String(p.version)} in force`} action="Put in force" confirm="Put in force" busy={busy} onConfirm={(reason) => void run(activateChargePolicyAction(p.id, reason), `${p.code} version ${String(p.version)} is in force.`)} />
                  ) : (
                    <ReasonAction label={`Retire ${p.code} version ${String(p.version)}`} action="Retire" confirm="Retire it" busy={busy} onConfirm={(reason) => void run(retireChargePolicyAction(p.id, reason), `${p.code} version ${String(p.version)} retired.`)} />
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {list.phase === 'idle' && list.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-fg-muted">{query.trim() === '' ? 'No delivery charge policies yet. Add the first one to start charging for delivery.' : 'No policy matches that search.'}</p>
      ) : null}
      {list.cursor !== null ? (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
