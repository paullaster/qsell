'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createWorkflowAction,
  type Lookups,
  type WorkflowSummary,
} from '@/server/kernel/approvals/actions';
import { MODULE_LABELS } from '@/server/kernel/approvals/domain/triggers';
import {
  Chip,
  EmptyState,
  Notice,
  PageHeader,
  StatusChip,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from './shared';

export function WorkflowListClient({
  workflows,
  lookups,
}: {
  workflows: WorkflowSummary[];
  lookups: Lookups;
}) {
  const uid = useId();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [form, setForm] = useState({
    code: '',
    name: '',
    trigger: lookups.triggers[0]!.code,
    branchId: '',
  });
  const branchName = (id: string | null) =>
    lookups.branches.find((b) => b.id === id)?.name ?? 'All branches';

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await createWorkflowAction({ ...form, branchId: form.branchId || null });
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    router.push(`/admin/settings/approvals/workflows/${res.data.id}`);
  };

  const byModule = [...new Set(workflows.map((w) => w.module))];

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
            <button
              type="button"
              className={primaryButtonClass}
              aria-expanded={creating}
              onClick={() => setCreating((v) => !v)}
            >
              New workflow
            </button>
          </>
        }
      >
        A workflow says when a document needs approval and who approves it, step by step. When
        several workflows match one document, all of them apply.
      </PageHeader>

      <Notice message={message} />

      {creating ? (
        <form onSubmit={create} aria-label="New workflow" className={`${cardClass} space-y-4`}>
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
                placeholder="Large discounts"
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
                placeholder="SO-DISCOUNT"
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}"
                title="Letters, numbers, - and _"
              />
            </div>
            <div>
              <label htmlFor={`${uid}-t`} className={labelClass}>
                When is approval asked for?
              </label>
              <select
                id={`${uid}-t`}
                value={form.trigger}
                onChange={(e) => setForm({ ...form, trigger: e.target.value })}
                className={fieldClass}
              >
                {lookups.triggers.map((t) => (
                  <option key={t.code} value={t.code}>
                    {MODULE_LABELS[t.module] ?? t.module} · {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-b`} className={labelClass}>
                Branch
              </label>
              <select
                id={`${uid}-b`}
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                className={fieldClass}
              >
                <option value="">All branches</option>
                {lookups.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
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

      {workflows.length === 0 ? (
        <EmptyState title="No approval workflows yet">
          Until you publish one, every document goes ahead without approval. Create a workflow to
          require approval for large discounts, big orders, credit notes and more.
        </EmptyState>
      ) : (
        byModule.map((m) => (
          <section key={m} aria-labelledby={`${uid}-${m}`} className="space-y-2">
            <h3
              id={`${uid}-${m}`}
              className="text-xs font-bold tracking-wide text-fg-muted uppercase"
            >
              {MODULE_LABELS[m] ?? m}
            </h3>
            <ul className="space-y-2">
              {workflows
                .filter((w) => w.module === m)
                .map((w) => (
                  <li key={w.id}>
                    <Link
                      href={`/admin/settings/approvals/workflows/${w.id}`}
                      className={`${cardClass} flex flex-wrap items-center justify-between gap-3 hover:border-indigo-500`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-fg-strong">{w.name}</span>
                        <span className="block text-xs text-fg-muted">
                          <span className="font-mono">{w.code}</span> · {w.triggerLabel} ·{' '}
                          {branchName(w.branchId)} · {w.stepCount} step
                          {w.stepCount === 1 ? '' : 's'}
                          {w.version ? ` · version ${w.version}` : ''}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {w.hasUnpublishedChanges ? (
                          <Chip tone="amber">Unpublished changes</Chip>
                        ) : null}
                        <StatusChip status={w.status} />
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
