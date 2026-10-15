'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createWorkflowAction, workflowsPageAction, type WorkflowSummary } from '@/server/kernel/approvals/actions';
import { MODULE_LABELS } from '@/server/kernel/approvals/domain/triggers';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { attempt, LoadFailed } from '@/components/ui/screen-kit';
import { newWorkflowPayload } from '@/lib/approval-forms';
import type { Choice } from '@/lib/payment-options';
import { Chip, EmptyState, Notice, PageHeader, StatusChip, buttonClass, cardClass, fieldClass, labelClass, primaryButtonClass, type Message } from './shared';

type FirstPage = Extract<Awaited<ReturnType<typeof workflowsPageAction>>, { ok: true }>;

export function WorkflowListClient({ firstPage }: { firstPage: ReturnType<typeof workflowsPageAction> }) {
  const first = use(firstPage);
  return first.ok ? <Workflows first={first} /> : <LoadFailed error={first.error} />;
}

function Workflows({ first }: { first: FirstPage }) {
  const uid = useId();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [form, setForm] = useState({ code: '', name: '' });
  const [trigger, setTrigger] = useState<Choice | null>(null);
  const [branch, setBranch] = useState<Choice | null>(null);

  const list = usePagedList<WorkflowSummary, { query: string }>({
    load: (filters, cursor) => workflowsPageAction({ query: filters.query, cursor }),
    filters: { query: query.trim() },
    initialPage: first,
  });

  const create = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const checked = newWorkflowPayload(form, trigger?.id ?? null, branch?.id ?? null);
    if (!checked.ok) {
      setMessage({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    setMessage(null);
    const res = await attempt(createWorkflowAction(checked.payload));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    router.push(`/admin/settings/approvals/workflows/${res.data.id}`);
  };

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Approval workflows"
        actions={
          <>
            <Link href="/admin/settings/approvals/approvers" className={buttonClass}>
              Approvers
            </Link>
            <Link href="/admin/settings/approvals/switches" className={buttonClass}>
              Switches
            </Link>
            <button type="button" className={primaryButtonClass} aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
              New workflow
            </button>
          </>
        }
      >
        A workflow says when a document needs approval and who approves it, step by step. When several workflows match one document, all of them apply.
      </PageHeader>

      <Notice message={message} />

      {creating ? (
        <form onSubmit={(e) => void create(e)} aria-label="New workflow" className={`${cardClass} space-y-4`}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-n`} className={labelClass}>
                Name
              </label>
              <input id={`${uid}-n`} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={fieldClass} placeholder="Large discounts" />
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
                placeholder="SO-DISCOUNT"
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}"
                title="Letters, numbers, - and _"
              />
            </div>
            <ChoicePicker label="When is approval asked for?" source="approval-triggers" choice={trigger} onChoice={setTrigger} placeholder="Choose a situation…" required />
            <ChoicePicker label="Branch" source="approval-branches" choice={branch} onChoice={setBranch} placeholder="All branches" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy}>
              {busy ? 'Creating…' : 'Create and design'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="max-w-sm">
        <label htmlFor={`${uid}-search`} className="sr-only">
          Search workflows
        </label>
        <input id={`${uid}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or code" className={fieldClass} autoComplete="off" />
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
      {list.phase === 'idle' && list.rows.length === 0 ? (
        <EmptyState title={query.trim() === '' ? 'No approval workflows yet' : `No workflow matches “${query.trim()}”`}>
          {query.trim() === '' ? 'Until you publish one, every document goes ahead without approval. Create a workflow to require approval for large discounts, big orders, credit notes and more.' : undefined}
        </EmptyState>
      ) : null}
      <ul className="space-y-2" aria-label="Workflows">
        {list.rows.map((w) => (
          <li key={w.id}>
            <Link href={`/admin/settings/approvals/workflows/${w.id}`} className={`${cardClass} flex flex-wrap items-center justify-between gap-3 hover:border-indigo-500`}>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-fg-strong">{w.name}</span>
                <span className="block text-xs text-fg-muted">
                  <span className="font-mono">{w.code}</span> · {MODULE_LABELS[w.module] ?? w.module} · {w.triggerLabel} · {w.branchLabel ?? 'All branches'} · {w.stepCount} step{w.stepCount === 1 ? '' : 's'}
                  {w.version === null || w.version === 0 ? '' : ` · version ${String(w.version)}`}
                </span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                {w.hasUnpublishedChanges ? <Chip tone="amber">Unpublished changes</Chip> : null}
                <StatusChip status={w.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more workflows'}
        </button>
      )}
    </div>
  );
}
