'use client';

import React, { use, useState, useTransition } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import type { BranchRow } from '@/server/db/drizzle/schema';
import { createBranchAction, updateBranchAction } from '@/server/domains/payments/actions';

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

export function AdminBranchesClient({
  branchesPromise,
}: {
  branchesPromise: Promise<BranchRow[]>;
}) {
  const initial = use(branchesPromise);
  const [branches, setBranches] = useState(initial);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [actsIndependently, setActsIndependently] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refreshLocal = (next: BranchRow) => {
    setBranches((prev) => {
      const idx = prev.findIndex((b) => b.id === next.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      }
      return [...prev, next];
    });
  };

  const handleCreate = () => {
    startTransition(async () => {
      try {
        setError(null);
        const created = await createBranchAction({ code, name, actsIndependently });
        refreshLocal(created);
        setCode('');
        setName('');
        setActsIndependently(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create branch');
      }
    });
  };

  const handleSetDefault = (id: string) => {
    startTransition(async () => {
      try {
        const updated = await updateBranchAction(id, { isDefault: true });
        setBranches((prev) =>
          prev.map((b) => ({
            ...b,
            isDefault: b.id === updated.id,
          })),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to set default');
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
          <GitBranch className="h-5 w-5 text-indigo-400" />
          Branches
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Each branch can hold its own payment credentials, KRA PIN, and banking details when marked
          as independent.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line bg-surface text-[10px] tracking-wider text-fg-subtle uppercase">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3 text-center">Independent</th>
              <th className="px-4 py-3 text-center">Default</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/80">
            {branches.map((b) => (
              <tr key={b.id} className="hover:bg-hover">
                <td className="px-4 py-3 font-mono text-fg">{b.code}</td>
                <td className="px-4 py-3 font-semibold text-fg-strong">{b.name}</td>
                <td className="px-4 py-3 text-center text-fg-muted">
                  {b.actsIndependently ? 'Yes' : 'No'}
                </td>
                <td className="px-4 py-3 text-center">
                  {b.isDefault ? (
                    <span className="text-amber-700">Default</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSetDefault(b.id)}
                      className="text-[10px] text-fg-subtle hover:text-indigo-400"
                    >
                      Make default
                    </button>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-fg-subtle">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 rounded-xl border border-line bg-surface-sunken/50 p-4">
        <h3 className="text-sm font-semibold text-fg-strong">Add branch</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-fg-muted">Code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. NBO"
              className={fieldClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-fg-muted">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nairobi Branch"
              className={fieldClass}
            />
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={actsIndependently}
            onChange={(e) => setActsIndependently(e.target.checked)}
            className="rounded border-line-strong"
          />
          Acts as independent unit (own KRA / paybill / bank)
        </label>
        {error ? <p className="text-xs text-red-700">{error}</p> : null}
        <button
          type="button"
          onClick={handleCreate}
          disabled={pending || !code.trim() || !name.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {pending ? 'Creating…' : 'Create branch'}
        </button>
      </div>
    </div>
  );
}
