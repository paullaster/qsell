'use client';

import React, { use, useMemo, useState, useTransition } from 'react';
import { KeyRound, Pencil, Plus, RotateCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { type AccessSnapshot } from '@/server/domains/access-control/engine';
import type { GrantEffect } from '@/server/domains/access-control/repository';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import {
  createRoleAction,
  deleteRoleAction,
  listRolesAction,
  setRolePermissionsAction,
  updateRoleAction,
} from '@/server/domains/access-control/actions';
import { PermissionMatrix, type GrantValue } from './PermissionMatrix';

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

export interface RolesSetup {
  roles: {
    id: string;
    key: string;
    name: string;
    description: string;
    priority: number;
    isSystem: boolean;
    isStaff: boolean;
    isActive: boolean;
    grants: { permissionKey: string; effect: GrantEffect }[];
  }[];
  access: AccessSnapshot;
}

interface RoleFormState {
  id: string | null;
  key: string;
  name: string;
  description: string;
  priority: string;
  isActive: boolean;
  isSystem: boolean;
  isStaff: boolean;
  grants: Partial<Record<PermissionKey, GrantValue>>;
}

function emptyForm(): RoleFormState {
  return {
    id: null,
    key: '',
    name: '',
    description: '',
    priority: '100',
    isActive: true,
    isSystem: false,
    isStaff: false,
    grants: {},
  };
}

function grantsToState(
  grants: { permissionKey: string; effect: GrantEffect }[],
): Partial<Record<PermissionKey, GrantValue>> {
  const state: Partial<Record<PermissionKey, GrantValue>> = {};
  for (const grant of grants) {
    state[grant.permissionKey as PermissionKey] = grant.effect;
  }
  return state;
}

function stateToGrants(
  state: Partial<Record<PermissionKey, GrantValue>>,
): { permissionKey: string; effect: GrantEffect }[] {
  const grants: { permissionKey: string; effect: GrantEffect }[] = [];
  for (const [key, effect] of Object.entries(state)) {
    if (effect === null) continue;
    grants.push({ permissionKey: key, effect });
  }
  return grants;
}

export function AdminRolesClient({ setupPromise }: { setupPromise: Promise<RolesSetup> }) {
  const setup = use(setupPromise);
  const [roles, setRoles] = useState(setup.roles);
  const [form, setForm] = useState<RoleFormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const canManage = useMemo(
    () => setup.access.permissions.includes('roles:manage'),
    [setup.access],
  );

  const refresh = () => {
    startTransition(async () => {
      try {
        setError(null);
        setRoles(await listRolesAction());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load roles');
      }
    });
  };

  const openNew = () => {
    setForm(emptyForm());
    setShowForm(true);
    setError(null);
  };

  const openRole = (role: RolesSetup['roles'][number]) => {
    setForm({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      priority: String(role.priority),
      isActive: role.isActive,
      isSystem: role.isSystem,
      isStaff: role.isStaff,
      grants: grantsToState(role.grants),
    });
    setShowForm(true);
    setError(null);
  };

  // super_admin is always staff and customer never; every other role's flag is editable.
  const staffLocked = form.key === 'super_admin' || form.key === 'customer';

  const save = () => {
    startTransition(async () => {
      try {
        setError(null);
        if (form.name.trim() === '') throw new Error('Role name is required');
        const grants = stateToGrants(form.grants);
        const priority = Number(form.priority);
        if (!Number.isFinite(priority) || priority < 0) {
          throw new Error('Priority must be a non-negative number');
        }
        if (form.id !== null) {
          await updateRoleAction(form.id, {
            name: form.name.trim(),
            description: form.description.trim(),
            priority,
            isActive: form.isActive,
            ...(staffLocked ? {} : { isStaff: form.isStaff }),
          });
          await setRolePermissionsAction(form.id, grants);
        } else {
          if (form.key.trim() === '') throw new Error('Role key is required');
          const created = await createRoleAction({
            key: form.key,
            name: form.name.trim(),
            description: form.description,
            priority,
            isStaff: form.isStaff,
          });
          await setRolePermissionsAction(created.id, grants);
        }
        setShowForm(false);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save role');
      }
    });
  };

  const removeRole = (role: RolesSetup['roles'][number]) => {
    // eslint-disable-next-line no-alert -- native confirm matches existing admin UI pattern
    if (
      !window.confirm(
        `Delete role '${role.name}' (${role.key})? Users holding it lose its permissions.`,
      )
    )
      return;
    startTransition(async () => {
      try {
        setError(null);
        await deleteRoleAction(role.id);
        if (form.id === role.id) setShowForm(false);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete role');
      }
    });
  };

  if (!canManage) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-fg-strong">
          <KeyRound className="h-5 w-5 text-indigo-500" aria-hidden="true" />
          <h2 className="text-xl font-semibold">Roles &amp; Permissions</h2>
        </div>
        <p className="rounded-lg border border-amber-700/40 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You do not have the <code>roles:manage</code> permission.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-fg-strong">
            <KeyRound className="h-5 w-5 text-indigo-500" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Roles &amp; Permissions</h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Roles bind permissions (RBAC). Lower priority numbers take precedence.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 sm:w-auto"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New role
        </button>
      </header>

      {error !== null ? (
        <p
          className="rounded-lg border border-red-500/40 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {showForm ? (
        <section
          aria-label="Editor"
          className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:p-5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-strong">
              {form.id !== null ? 'Edit role' : 'New role'}
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              aria-label="Close editor"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-fg-subtle hover:bg-hover hover:text-fg-strong"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {form.id === null ? (
              <label className="block text-xs text-fg-muted">
                Key (unique, kebab-case)
                <input
                  className={`${fieldClass} mt-1 font-mono`}
                  value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                  placeholder="e.g. warehouse-officer"
                />
              </label>
            ) : (
              <label className="block text-xs text-fg-muted">
                Key
                <input className={`${fieldClass} mt-1 font-mono`} value={form.key} disabled />
              </label>
            )}
            <label className="block text-xs text-fg-muted">
              Name
              <input
                className={`${fieldClass} mt-1`}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="block text-xs text-fg-muted sm:col-span-2">
              Description
              <input
                className={`${fieldClass} mt-1`}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </label>
            <label className="block text-xs text-fg-muted">
              Priority (lower = stronger)
              <input
                className={`${fieldClass} mt-1`}
                type="number"
                min={0}
                value={form.priority}
                disabled={form.isSystem}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              Active (assignable to users)
            </label>
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={form.isStaff}
                  disabled={staffLocked}
                  aria-describedby="role-staff-help"
                  onChange={(e) => setForm((f) => ({ ...f, isStaff: e.target.checked }))}
                />
                Staff role (can sign in to the admin console)
              </label>
              <p id="role-staff-help" className="mt-1 text-xs text-fg-subtle">
                {staffLocked
                  ? form.key === 'super_admin'
                    ? 'The super admin role is always a staff role.'
                    : 'The customer role is the shopper role and is never a staff role.'
                  : 'Off by default. Users whose primary role is not a staff role are shoppers and cannot open the admin console, whatever permissions the role holds.'}
              </p>
            </div>
          </div>

          {form.isSystem ? (
            <p className="flex items-center gap-2 rounded-lg border border-indigo-800 bg-indigo-50 px-3 py-2 text-xs text-indigo-600 dark:text-indigo-400">
              <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
              System role. Its key, priority, and deletion are locked; permission bindings below
              still apply.
            </p>
          ) : null}

          <div>
            <p className="mb-2 text-xs text-fg-muted">Permission bindings (Allow / Deny / Unset)</p>
            <PermissionMatrix
              grants={form.grants}
              onChange={(key, value: GrantValue) =>
                setForm((f) => ({ ...f, grants: { ...f.grants, [key]: value } }))
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50 min-h-10"
            >
              {pending ? <RotateCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {form.id !== null ? 'Save changes' : 'Create role'}
            </button>
            {form.id !== null && !form.isSystem ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const role = roles.find((r) => r.id === form.id);
                  if (role) removeRole(role);
                }}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-red-800 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-10 rounded-lg border border-line-strong px-3 py-2 text-sm text-fg hover:bg-hover"
            >
              Close
            </button>
          </div>
        </section>
      ) : null}

      {roles.length === 0 ? (
        <p className="rounded-xl border border-line px-4 py-6 text-sm text-fg-subtle md:hidden">
          No roles yet. Create one to start binding permissions.
        </p>
      ) : (
        <ul className="space-y-3 md:hidden">
          {roles.map((role) => (
            <li key={role.id} className="space-y-2 rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-fg-strong">
                    {role.name}{' '}
                    {role.isSystem ? (
                      <span className="text-[11px] text-indigo-700 dark:text-indigo-300">
                        system
                      </span>
                    ) : null}
                  </p>
                  <p className="font-mono text-xs break-all text-fg-subtle">{role.key}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                    role.isActive
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-surface-sunken text-fg-subtle'
                  }`}
                >
                  {role.isActive ? 'active' : 'inactive'}
                </span>
              </div>
              <p className="text-xs text-fg-muted">
                Priority {role.priority} · {role.isStaff ? 'Staff' : 'Not staff'} ·{' '}
                {role.key === 'super_admin'
                  ? 'Full access (bypasses checks)'
                  : `${role.grants.filter((g) => g.effect === 'allow').length} allowed · ${role.grants.filter((g) => g.effect === 'deny').length} denied`}
              </p>
              <button
                type="button"
                onClick={() => openRole(role)}
                aria-label={`Edit role ${role.name}`}
                className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm text-fg hover:bg-hover"
              >
                <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
        <table className="w-full min-w-[36rem] text-left text-sm text-fg">
          <caption className="sr-only">Roles</caption>
          <thead className="bg-surface-raised text-xs text-fg-subtle">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Role</th>
              <th scope="col" className="px-4 py-2 font-medium">Priority</th>
              <th scope="col" className="px-4 py-2 font-medium">Staff</th>
              <th scope="col" className="px-4 py-2 font-medium">Permissions</th>
              <th scope="col" className="px-4 py-2 font-medium">Status</th>
              <th scope="col" className="px-4 py-2 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-fg-subtle">
                  No roles yet. Create one to start binding permissions.
                </td>
              </tr>
            ) : (
              roles.map((role) => (
                <tr key={role.id} className="border-t border-line hover:bg-hover">
                  <td className="px-4 py-3">
                    <p className="text-fg-strong">
                      {role.name}{' '}
                      {role.isSystem ? (
                        <span className="text-[11px] text-indigo-700 dark:text-indigo-300">system</span>
                      ) : null}
                    </p>
                    <p className="font-mono text-xs text-fg-subtle">{role.key}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">{role.priority}</td>
                  <td className="px-4 py-3 text-xs text-fg-muted">{role.isStaff ? 'Yes' : 'No'}</td>
                  <td className="px-4 py-3 text-xs text-fg-muted">
                    {role.key === 'super_admin'
                      ? 'Full access (bypasses checks)'
                      : `${role.grants.filter((g) => g.effect === 'allow').length} allowed · ${role.grants.filter((g) => g.effect === 'deny').length} denied`}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        role.isActive
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-surface-sunken text-fg-subtle'
                      }`}
                    >
                      {role.isActive ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => openRole(role)}
                      aria-label={`Edit role ${role.name}`}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-indigo-700 hover:bg-hover dark:text-indigo-300"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
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
