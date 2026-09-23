'use client';

import React, { use, useMemo, useState, useTransition } from 'react';
import {
  Fingerprint,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { type AccessSnapshot } from '@/server/domains/access-control/engine';
import type { PolicyMatch } from '@/server/domains/access-control/repository';
import { ALL_PERMISSION_KEYS } from '@/server/domains/access-control/permissions';
import {
  createPolicyAction,
  deletePolicyAction,
  listPoliciesAction,
  updatePolicyAction,
} from '@/server/domains/access-control/actions';

const fieldClass =
  'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';

export interface PoliciesSetup {
  policies: PolicyMatch[];
  access: AccessSnapshot;
}

interface PolicyFormState {
  id: string | null;
  key: string;
  name: string;
  description: string;
  permissionKey: string;
  effect: 'allow' | 'deny';
  priority: string;
  isEnabled: boolean;
  conditionText: string;
  conditionError: string | null;
}

function conditionToText(condition: Record<string, unknown>): string {
  if (Object.keys(condition).length === 0) return '{}';
  return JSON.stringify(condition, null, 2);
}

function emptyForm(): PolicyFormState {
  return {
    id: null,
    key: '',
    name: '',
    description: '',
    permissionKey: ALL_PERMISSION_KEYS[0],
    effect: 'allow',
    priority: '100',
    isEnabled: true,
    conditionText: '{}',
    conditionError: null,
  };
}

function formFromPolicy(policy: PolicyMatch): PolicyFormState {
  return {
    id: policy.id,
    key: policy.key,
    name: policy.name,
    description: policy.description,
    permissionKey: policy.permissionKey,
    effect: policy.effect,
    priority: String(policy.priority),
    isEnabled: policy.isEnabled,
    conditionText: conditionToText(policy.condition),
    conditionError: null,
  };
}

function parseCondition(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'Condition must be a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

export function AdminPoliciesClient({ setupPromise }: { setupPromise: Promise<PoliciesSetup> }) {
  const setup = use(setupPromise);
  const [policies, setPolicies] = useState(setup.policies);
  const [form, setForm] = useState<PolicyFormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const canManage = useMemo(
    () => setup.access.permissions.includes('policies:manage'),
    [setup.access],
  );

  const refresh = () => {
    startTransition(async () => {
      try {
        setError(null);
        setPolicies(await listPoliciesAction());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load policies');
      }
    });
  };

  const openNew = () => {
    setForm(emptyForm());
    setShowForm(true);
    setError(null);
  };

  const openPolicy = (policy: PolicyMatch) => {
    setForm(formFromPolicy(policy));
    setShowForm(true);
    setError(null);
  };

  const save = () => {
    const parsed = parseCondition(form.conditionText);
    if (!parsed.ok) {
      setForm((f) => ({ ...f, conditionError: parsed.error }));
      return;
    }
    startTransition(async () => {
      try {
        setError(null);
        const priority = Number(form.priority);
        if (!Number.isFinite(priority) || priority < 0) {
          throw new Error('Priority must be a non-negative number');
        }
        if (form.id !== null) {
          await updatePolicyAction(form.id, {
            name: form.name.trim(),
            description: form.description,
            permissionKey: form.permissionKey,
            effect: form.effect,
            priority,
            isEnabled: form.isEnabled,
            condition: parsed.value,
          });
        } else {
          if (form.key.trim() === '') throw new Error('Policy key is required');
          await createPolicyAction({
            key: form.key,
            name: form.name.trim(),
            description: form.description,
            permissionKey: form.permissionKey,
            effect: form.effect,
            priority,
            condition: parsed.value,
          });
        }
        setShowForm(false);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save policy');
      }
    });
  };

  const togglePolicy = (policy: PolicyMatch) => {
    startTransition(async () => {
      try {
        setError(null);
        await updatePolicyAction(policy.id, { isEnabled: !policy.isEnabled });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to toggle policy');
      }
    });
  };

  const removePolicy = (policy: PolicyMatch) => {
    // eslint-disable-next-line no-alert -- native confirm matches existing admin UI pattern
    if (!window.confirm(`Delete policy '${policy.name}'? Users may lose context-granted access.`)) return;
    startTransition(async () => {
      try {
        setError(null);
        await deletePolicyAction(policy.id);
        if (form.id === policy.id) setShowForm(false);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete policy');
      }
    });
  };

  if (!canManage) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="flex items-center gap-2 text-white">
          <Fingerprint className="h-5 w-5 text-indigo-400" />
          <h1 className="text-xl font-semibold">Access Policies</h1>
        </div>
        <p className="rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          You do not have the <code>policies:manage</code> permission.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-white">
            <Fingerprint className="h-5 w-5 text-indigo-400" />
            <h1 className="text-xl font-semibold">Access Policies (ABAC)</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Policies evaluate a condition against the user (attributes), the request
            <code className="text-zinc-300"> ctx </code>, and the subject resource. The first
            enabled policy whose condition matches wins. Lower priority numbers run first.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          New policy
        </button>
      </div>

      {error !== null ? (
        <p className="rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</p>
      ) : null}

      {showForm ? (
        <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">{form.id !== null ? 'Edit policy' : 'New policy'}</h2>
            <button type="button" onClick={() => setShowForm(false)} className="text-zinc-500 hover:text-zinc-200">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {form.id === null ? (
              <label className="block text-xs text-zinc-400">
                Key (unique, kebab-case)
                <input
                  className={`${fieldClass} mt-1 font-mono`}
                  value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="e.g. no-credit-over-limit"
                />
              </label>
            ) : (
              <label className="block text-xs text-zinc-400">
                Key
                <input className={`${fieldClass} mt-1 font-mono`} value={form.key} disabled />
              </label>
            )}
            <label className="block text-xs text-zinc-400">
              Name
              <input className={`${fieldClass} mt-1`} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="block text-xs text-zinc-400">
              Permission dimension
              <select
                className={`${fieldClass} mt-1`}
                value={form.permissionKey}
                onChange={(e) => setForm((f) => ({ ...f, permissionKey: e.target.value }))}
              >
                {ALL_PERMISSION_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-zinc-400">
                Effect
                <select
                  className={`${fieldClass} mt-1`}
                  value={form.effect}
                  onChange={(e) => setForm((f) => ({ ...f, effect: e.target.value as 'allow' | 'deny' }))}
                >
                  <option value="allow">Allow</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
              <label className="block text-xs text-zinc-400">
                Priority
                <input
                  className={`${fieldClass} mt-1`}
                  type="number"
                  min={0}
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                />
              </label>
            </div>
            <label className="block text-xs text-zinc-400 sm:col-span-2">
              Description
              <input className={`${fieldClass} mt-1`} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300 sm:col-span-2">
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={(e) => setForm((f) => ({ ...f, isEnabled: e.target.checked }))}
              />
              Enabled
            </label>
          </div>

          <div>
            <p className="mb-1 text-xs text-zinc-400">
              Condition (JSON). Use <code>user.*</code>, <code>ctx.*</code>, <code>res.*</code> fields with
              operators <code>eq neq gt gte lt lte in not_in contains matches exists is_null</code> and{' '}
              <code>and or not</code>. <code>{'{'}{'}'}</code> matches everything.
            </p>
            <textarea
              className={`${fieldClass} mt-1 h-36 font-mono text-xs`}
              value={form.conditionText}
              spellCheck={false}
              onChange={(e) =>
                setForm((f) => ({ ...f, conditionText: e.target.value, conditionError: null }))
              }
            />
            {form.conditionError !== null ? (
              <p className="mt-1 text-xs text-red-300">{form.conditionError}</p>
            ) : null}
            <p className="mt-1 text-[11px] text-zinc-500">
              Example:{' '}
              <code>
                {'{"ctx":{"amount":10000},"and":[{"user.role":"admin"},{"ctx.branchId":{"in":["br_1","br_2"]}}]}'}
              </code>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {pending ? <RotateCw className="h-4 w-4 animate-spin" /> : null}
              {form.id !== null ? 'Save changes' : 'Create policy'}
            </button>
            {form.id !== null ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const policy = policies.find((p) => p.id === form.id);
                  if (policy) removePolicy(policy);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-800 px-3 py-2 text-sm text-red-300 hover:bg-red-950/30 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300"
            >
              Close
            </button>
          </div>
        </section>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm text-zinc-300">
          <thead className="bg-zinc-900 text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2">Policy</th>
              <th>Permission</th>
              <th>Effect</th>
              <th>Priority</th>
              <th>Status</th>
              <th className="px-3 py-2 text-right"> </th>
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-zinc-500">
                  No access policies yet. Roles handle most access; create a policy for context-aware rules.
                </td>
              </tr>
            ) : (
              policies.map((policy) => (
                <tr key={policy.id} className="border-t border-zinc-800 hover:bg-zinc-900">
                  <td className="px-3 py-2">
                    <p className="text-zinc-100">{policy.name}</p>
                    <p className="font-mono text-xs text-zinc-500">{policy.key}</p>
                  </td>
                  <td className="py-2 font-mono text-xs text-zinc-400">{policy.permissionKey}</td>
                  <td className="py-2">
                    {policy.effect === 'allow' ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-900/40 px-2 py-0.5 text-[11px] text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" /> allow
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-950/40 px-2 py-0.5 text-[11px] text-red-300">
                        <XCircle className="h-3 w-3" /> deny
                      </span>
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs text-zinc-400">{policy.priority}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => togglePolicy(policy)}
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        policy.isEnabled
                          ? 'bg-emerald-900/40 text-emerald-300'
                          : 'bg-zinc-800 text-zinc-500'
                      }`}
                    >
                      {policy.isEnabled ? 'enabled' : 'disabled'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => openPolicy(policy)}
                      className="mr-2 inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removePolicy(policy)}
                      className="text-xs text-red-300 hover:text-red-200"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}