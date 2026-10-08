'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listPricingReasonsAction } from '@/server/domains/pricing/actions';
import { removeLimitAction, setLimitAction } from '@/server/domains/pricing/guard-actions';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  EmptyState,
  Notice,
  PageHeader,
  buttonClass,
  cardClass,
  dangerButtonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';

interface Limit {
  id: string;
  roleKey: string;
  roleName: string;
  maxPercent: number;
}

export function LimitsClient({
  limits,
  roles,
  canManage,
}: {
  limits: Limit[];
  roles: Array<{ key: string; name: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [form, setForm] = useState<{ roleKey: string; percent: string; editing: boolean } | null>(
    null,
  );
  const [removing, setRemoving] = useState<Limit | null>(null);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const done = (text: string) => {
    setForm(null);
    setRemoving(null);
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text });
    router.refresh();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    const r = await setLimitAction(
      { roleKey: form.roleKey, maxPercent: Number(form.percent) },
      reason,
    );
    setBusy(false);
    if (r.ok) done('Limit saved.');
    else setMessage({ kind: 'error', text: r.error });
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const r = await removeLimitAction(removing.id, reason);
    setBusy(false);
    if (r.ok) done('Limit removed.');
    else setMessage({ kind: 'error', text: r.error });
  };

  const taken = new Set(limits.map((l) => l.roleKey));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Override limits"
        actions={
          canManage && !form ? (
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => setForm({ roleKey: '', percent: '5', editing: false })}
            >
              New limit
            </button>
          ) : null
        }
      >
        How far below the list price a person may take a price, by typing a lower price or giving a
        discount, before the quote needs approval. Set one per role; "Everyone else" covers roles
        without their own. Someone with several roles gets the most generous of theirs. With no
        limits set, nothing is checked.
      </PageHeader>
      <Notice message={message} />

      {form ? (
        <form onSubmit={save} className={`${cardClass} space-y-3`} aria-label="Limit">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-role`} className={labelClass}>
                Role
              </label>
              <select
                id={`${uid}-role`}
                className={fieldClass}
                value={form.roleKey}
                disabled={form.editing}
                required
                onChange={(e) => setForm({ ...form, roleKey: e.target.value })}
              >
                <option value="">Choose a role…</option>
                {!taken.has('*') || form.roleKey === '*' ? (
                  <option value="*">Everyone else</option>
                ) : null}
                {roles
                  .filter((r) => !taken.has(r.key) || r.key === form.roleKey)
                  .map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-pct`} className={labelClass}>
                Most they may reduce a price by (%)
              </label>
              <input
                id={`${uid}-pct`}
                type="number"
                min={0}
                max={100}
                step="0.1"
                inputMode="decimal"
                className={fieldClass}
                value={form.percent}
                onChange={(e) => setForm({ ...form, percent: e.target.value })}
                required
              />
              <p className="mt-1 text-xs text-fg-muted">
                0 means they may not reduce a price at all.
              </p>
            </div>
          </div>
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || !reason.code || !form.roleKey}
            >
              {busy ? 'Saving…' : 'Save limit'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {removing ? (
        <section aria-label="Remove limit" className={`${cardClass} space-y-3`}>
          <p className="text-sm text-fg-strong">
            Remove the limit for <strong>{removing.roleName}</strong>? They fall back to the
            "Everyone else" limit, or to no limit.
          </p>
          <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={dangerButtonClass}
              disabled={busy || !reason.code}
              onClick={() => void remove()}
            >
              {busy ? 'Removing…' : 'Remove limit'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {limits.length === 0 ? (
        <EmptyState title="No override limits yet">
          Anyone who can write a quote can currently type any price or give any discount. Add a
          limit per role to require approval beyond it.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                <tr>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3 text-right">May reduce a price by up to</th>
                  {canManage ? <th className="px-4 py-3 text-right">Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg">
                {limits.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-3 font-semibold text-fg-strong">{l.roleName}</td>
                    <td className="px-4 py-3 text-right font-mono">{l.maxPercent}%</td>
                    {canManage ? (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className={buttonClass}
                            onClick={() => {
                              setRemoving(null);
                              setForm({
                                roleKey: l.roleKey,
                                percent: String(l.maxPercent),
                                editing: true,
                              });
                            }}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className={`${buttonClass} text-red-700`}
                            onClick={() => {
                              setForm(null);
                              setRemoving(l);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
