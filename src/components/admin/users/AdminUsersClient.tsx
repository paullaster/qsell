'use client';

import React, { use, useMemo, useState, useTransition } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import type { AccessSnapshot } from '@/server/domains/access-control/engine';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import type {
  DirectGrantInput,
  RoleAssignment,
  UserListEntry,
  UserListResult,
} from '@/server/domains/users/repository';
import {
  assignRolesAction,
  createUserAction,
  deleteUserAction,
  getUserDetailAction,
  listUsersAction,
  resetUserPasswordAction,
  setDirectGrantsAction,
  updateUserAction,
} from '@/server/domains/users/actions';
import { grantListToState, stateToGrants } from './shared';
import { PermissionMatrix, type GrantValue, type PermissionMatrixState } from './PermissionMatrix';

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

export interface UsersSetup {
  initial: UserListResult;
  access: AccessSnapshot;
  roles: {
    id: string;
    key: string;
    name: string;
    priority: number;
    isSystem: boolean;
    isActive: boolean;
  }[];
  branches: { id: string; name: string; code: string; isDefault: boolean }[];
}

type Status = 'active' | 'suspended';

interface ExtraRoleRow {
  roleKey: string;
  branchId: string;
}

interface UserFormState {
  name: string;
  email: string;
  title: string;
  phone: string;
  role: string;
  status: Status;
  branchId: string;
  mustChangePassword: boolean;
  password: string;
  newPassword: string;
  extraRoles: ExtraRoleRow[];
  grants: PermissionMatrixState['grants'];
}

function makeEmptyForm(primaryRoleKey: string): UserFormState {
  return {
    name: '',
    email: '',
    title: '',
    phone: '',
    role: primaryRoleKey,
    status: 'active',
    branchId: '',
    mustChangePassword: false,
    password: '',
    newPassword: '',
    extraRoles: [],
    grants: {},
  };
}

function roleLabel(roles: UsersSetup['roles'], key: string): string {
  const role = roles.find((r) => r.key === key);
  return role ? role.name : key;
}

export function AdminUsersClient({ setupPromise }: { setupPromise: Promise<UsersSetup> }) {
  const setup = use(setupPromise);
  const [initial] = useState(setup.initial);
  const [rows, setRows] = useState<UserListEntry[]>(initial.rows);
  const [total, setTotal] = useState(initial.total);
  const [page, setPage] = useState(initial.page);
  const pageSize = initial.pageSize;

  const assignableRoles = useMemo(
    () => setup.roles.filter((r) => r.key !== 'super_admin'),
    [setup.roles],
  );

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<UserFormState>(() =>
    makeEmptyForm(assignableRoles[0]?.key ?? ''),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const access = setup.access;
  const has = useMemo(() => (key: PermissionKey) => access.permissions.includes(key), [access]);
  const can = {
    read: has('users:read'),
    create: has('users:create'),
    update: has('users:update'),
    del: has('users:delete'),
    manageRoles: has('users:manage_roles'),
    resetPassword: has('users:reset_password'),
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const reload = (
    next: Partial<{ search: string; role: string; status: string; page: number }>,
  ) => {
    startTransition(async () => {
      try {
        setError(null);
        const result = await listUsersAction({
          search: next.search ?? search,
          role: next.role ?? roleFilter,
          status: next.status ?? statusFilter,
          page: next.page ?? page,
          pageSize,
        });
        setRows(result.rows);
        setTotal(result.total);
        setPage(result.page);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load users');
      }
    });
  };

  const openNew = () => {
    setEditingId(null);
    setForm(makeEmptyForm(assignableRoles[0]?.key ?? ''));
    setShowForm(true);
    setError(null);
  };

  const openEdit = (row: UserListEntry) => {
    setEditingId(row.id);
    setShowForm(true);
    setError(null);
    setForm(makeEmptyForm(row.role));
    startTransition(async () => {
      try {
        const detail = await getUserDetailAction(row.id);
        if (!detail) return;
        setForm({
          name: detail.name,
          email: detail.email,
          title: detail.title ?? '',
          phone: detail.phone ?? '',
          role: detail.role,
          status: detail.status === 'suspended' ? 'suspended' : 'active',
          branchId: detail.branchId ?? '',
          mustChangePassword: detail.mustChangePassword,
          password: '',
          newPassword: '',
          extraRoles: detail.extraRoles.map((r) => ({
            roleKey: r.key,
            branchId: '',
          })),
          grants: grantListToState(detail.directGrants),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load user');
      }
    });
  };

  const addExtraRole = () => {
    const remaining = assignableRoles.filter(
      (r) => r.key !== form.role && !form.extraRoles.some((extra) => extra.roleKey === r.key),
    );
    if (remaining.length === 0) return;
    setForm((f) => ({
      ...f,
      extraRoles: [...f.extraRoles, { roleKey: remaining[0].key, branchId: '' }],
    }));
  };

  const removeExtraRole = (index: number) => {
    setForm((f) => ({ ...f, extraRoles: f.extraRoles.filter((_, i) => i !== index) }));
  };

  const save = () => {
    startTransition(async () => {
      try {
        setError(null);
        if (form.name.trim() === '') throw new Error('Display name is required');
        const directGrants: DirectGrantInput[] = stateToGrants(form.grants);
        const extraRoles: RoleAssignment[] = form.extraRoles
          .filter((r) => r.roleKey !== '')
          .map((r) => ({ roleKey: r.roleKey, branchId: r.branchId === '' ? null : r.branchId }));

        if (editingId !== null) {
          await updateUserAction(editingId, {
            name: form.name,
            title: form.title === '' ? null : form.title,
            phone: form.phone === '' ? null : form.phone,
            role: form.role,
            status: form.status,
            branchId: form.branchId === '' ? null : form.branchId,
          });
          if (form.newPassword.trim() !== '') {
            await resetUserPasswordAction(editingId, form.newPassword);
          }
          if (can.manageRoles) {
            await assignRolesAction(editingId, extraRoles);
            await setDirectGrantsAction(editingId, directGrants);
          }
        } else {
          await createUserAction({
            email: form.email,
            password: form.password,
            name: form.name,
            title: form.title === '' ? null : form.title,
            phone: form.phone === '' ? null : form.phone,
            role: form.role,
            status: form.status,
            branchId: form.branchId === '' ? null : form.branchId,
            mustChangePassword: form.mustChangePassword,
            extraRoles,
            directGrants,
          });
        }
        setShowForm(false);
        reload({});
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save user');
      }
    });
  };

  const removeUser = (row: UserListEntry) => {
    // eslint-disable-next-line no-alert -- native confirm matches the existing admin UI pattern
    if (!window.confirm(`Delete ${row.name} (${row.email})? This cannot be undone.`)) return;
    startTransition(async () => {
      try {
        setError(null);
        await deleteUserAction(row.id);
        setRows((prev) => prev.filter((item) => item.id !== row.id));
        if (editingId === row.id) {
          setEditingId(null);
          setShowForm(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete user');
      }
    });
  };

  const toggleStatus = (row: UserListEntry) => {
    startTransition(async () => {
      try {
        setError(null);
        const nextStatus: Status = row.status === 'active' ? 'suspended' : 'active';
        await updateUserAction(row.id, { status: nextStatus });
        setRows((prev) =>
          prev.map((item) => (item.id === row.id ? { ...item, status: nextStatus } : item)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update status');
      }
    });
  };

  const applyFilters = () => reload({ page: 1 });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-fg-strong">
            <UserCog className="h-5 w-5 text-indigo-400" />
            <h1 className="text-xl font-semibold">Users &amp; Access</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Manage who can sign in and what they can do. Roles are coarse-grained RBAC grants;
            direct grants override roles per user; ABAC access policies add context-aware rules on
            top. Every sensitive change is written to the audit trail.
          </p>
        </div>
        {access.superAdmin ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 text-white px-3 py-1 text-xs">
            <ShieldCheck className="h-3 w-3" /> Super admin
          </span>
        ) : null}
        {can.create ? (
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" />
            New user
          </button>
        ) : null}
      </div>

      {!access.superAdmin ? (
        <p className="rounded-lg border border-line bg-surface-sunken/40 px-3 py-2 text-xs text-fg-subtle">
          Your grants:{' '}
          {access.roleKeys.length > 0
            ? access.roleKeys.map((k) => roleLabel(setup.roles, k)).join(', ')
            : 'none'}
          . You hold {access.permissions.length} allowed permission
          {access.permissions.length === 1 ? '' : 's'}.
        </p>
      ) : null}

      {error !== null ? (
        <p className="rounded-lg border border-red-500/40 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {showForm ? (
        <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-strong">
              {editingId !== null ? 'Edit user' : 'New user'}
            </h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-fg-subtle hover:text-fg-strong"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-fg-muted">
              Full name
              <input
                className={`${fieldClass} mt-1`}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="block text-xs text-fg-muted">
              Email
              <input
                className={`${fieldClass} mt-1`}
                value={form.email}
                disabled={editingId !== null}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder={
                  editingId !== null ? 'Unchangeable after creation' : 'user@company.com'
                }
              />
            </label>
            <label className="block text-xs text-fg-muted">
              Title / job role
              <input
                className={`${fieldClass} mt-1`}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Sales Manager"
              />
            </label>
            <label className="block text-xs text-fg-muted">
              Phone
              <input
                className={`${fieldClass} mt-1`}
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="0712 000 000"
              />
            </label>
            <label className="block text-xs text-fg-muted">
              Primary role
              <select
                className={`${fieldClass} mt-1`}
                value={form.role}
                onChange={(e) => {
                  const roleKey = e.target.value;
                  setForm((f) => ({
                    ...f,
                    role: roleKey,
                    extraRoles: f.extraRoles.filter((extra) => extra.roleKey !== roleKey),
                  }));
                }}
              >
                {assignableRoles.map((role) => (
                  <option key={role.id} value={role.key} disabled={!role.isActive}>
                    {role.name} {role.isSystem ? '· system' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-fg-muted">
              Status
              <select
                className={`${fieldClass} mt-1`}
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as Status }))}
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            </label>
            <label className="block text-xs text-fg-muted">
              Home branch
              <select
                className={`${fieldClass} mt-1`}
                value={form.branchId}
                onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
              >
                <option value="">No branch</option>
                {setup.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </select>
            </label>
            {editingId === null ? (
              <>
                <label className="block text-xs text-fg-muted">
                  Initial password
                  <input
                    className={`${fieldClass} mt-1`}
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder="At least 8 characters"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={form.mustChangePassword}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, mustChangePassword: e.target.checked }))
                    }
                  />
                  Force password change at first sign-in
                </label>
              </>
            ) : (
              <label className="block text-xs text-fg-muted">
                Reset password (leave blank to keep current)
                <input
                  className={`${fieldClass} mt-1`}
                  type="password"
                  value={form.newPassword}
                  onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
                  placeholder="At least 8 characters"
                />
              </label>
            )}
          </div>

          {can.manageRoles ? (
            <>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-fg-muted">
                  <span>Additional roles (RBAC — branch-scoped assignments supported)</span>
                  <button
                    type="button"
                    onClick={addExtraRole}
                    className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-xs text-fg hover:bg-hover"
                  >
                    <Plus className="h-3 w-3" /> Add role
                  </button>
                </div>
                {form.extraRoles.length === 0 ? (
                  <p className="text-xs text-fg-faint">
                    No additional roles. Roles here stack on top of the primary role.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {form.extraRoles.map((extra, index) => (
                      <div key={extra.roleKey} className="flex flex-wrap items-center gap-2">
                        <select
                          className={`${fieldClass} w-48`}
                          value={extra.roleKey}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              extraRoles: f.extraRoles.map((item, i) =>
                                i === index ? { ...item, roleKey: e.target.value } : item,
                              ),
                            }))
                          }
                        >
                          {assignableRoles
                            .filter((r) => r.key !== form.role)
                            .map((role) => (
                              <option key={role.id} value={role.key} disabled={!role.isActive}>
                                {role.name}
                              </option>
                            ))}
                        </select>
                        <select
                          className={`${fieldClass} w-52`}
                          value={extra.branchId}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              extraRoles: f.extraRoles.map((item, i) =>
                                i === index ? { ...item, branchId: e.target.value } : item,
                              ),
                            }))
                          }
                        >
                          <option value="">Apply everywhere</option>
                          {setup.branches.map((branch) => (
                            <option key={branch.id} value={branch.id}>
                              Only {branch.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => removeExtraRole(index)}
                          className="text-xs text-red-700 hover:text-red-800"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-xs text-fg-muted">
                  <KeyRound className="h-3 w-3" />
                  <span>Direct permission overrides (highest precedence, RBAC + enforcement)</span>
                </div>
                <PermissionMatrix
                  grants={form.grants}
                  onChange={(key, value: GrantValue) =>
                    setForm((f) => ({ ...f, grants: { ...f.grants, [key]: value } }))
                  }
                />
              </div>
            </>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {pending ? <RotateCw className="h-4 w-4 animate-spin" /> : null}
              {editingId !== null ? 'Save changes' : 'Create user'}
            </button>
            {editingId !== null && can.del ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const row = rows.find((item) => item.id === editingId);
                  if (row) removeUser(row);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-800 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            ) : null}
            {editingId !== null && can.update ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  const row = rows.find((item) => item.id === editingId);
                  if (row) toggleStatus(row);
                }}
                className="rounded-lg border border-line-strong px-3 py-2 text-sm text-fg"
              >
                {form.status === 'suspended' ? 'Reactivate' : 'Suspend'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-line-strong px-3 py-2 text-sm text-fg"
            >
              Close
            </button>
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-fg-muted">
          Search
          <div className="mt-1 flex items-center gap-1">
            <Search className="h-4 w-4 text-fg-faint" />
            <input
              className={`${fieldClass} w-52`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
              placeholder="Name or email"
            />
          </div>
        </label>
        <label className="text-xs text-fg-muted">
          Primary role
          <select
            className={`${fieldClass} mt-1 w-44`}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="">All roles</option>
            {setup.roles.map((role) => (
              <option key={role.id} value={role.key}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-fg-muted">
          Status
          <select
            className={`${fieldClass} mt-1 w-36`}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </label>
        <button
          type="button"
          disabled={pending}
          onClick={applyFilters}
          className="rounded-lg border border-line-strong px-3 py-2 text-sm text-fg hover:bg-hover disabled:opacity-50"
        >
          Apply
        </button>
        <span className="ml-auto self-center text-xs text-fg-subtle">
          {total} user{total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-left text-sm text-fg">
          <thead className="bg-surface-raised text-xs text-fg-subtle">
            <tr>
              <th className="px-3 py-2">User</th>
              <th>Roles</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th className="px-3 py-2 text-right"> </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-fg-subtle">
                  No users found. Adjust the filters or create your first user.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelf = access.userId === row.id;
                return (
                  <tr key={row.id} className="border-t border-line hover:bg-hover">
                    <td className="px-3 py-2">
                      <button type="button" className="text-left" onClick={() => openEdit(row)}>
                        <p className="text-fg-strong">
                          {row.name}{' '}
                          {isSelf ? <span className="text-xs text-indigo-300">(you)</span> : null}
                        </p>
                        <p className="text-xs text-fg-subtle">{row.email}</p>
                      </button>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-fg">
                          {roleLabel(setup.roles, row.role)}
                        </span>
                        {row.extraRoles.map((key) => (
                          <span
                            key={key}
                            className="rounded-full border border-indigo-700/60 px-2 py-0.5 text-[11px] text-indigo-300"
                          >
                            {roleLabel(setup.roles, key)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                          row.status === 'active'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-red-50 text-red-700'
                        }`}
                      >
                        {row.status}
                      </span>
                      {row.mustChangePassword ? (
                        <span className="ml-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                          reset
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-xs text-fg-subtle">
                      {row.lastLoginAt ? timeAgo(row.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!isSelf && can.del ? (
                        <button
                          type="button"
                          onClick={() => removeUser(row)}
                          className="text-xs text-red-700 hover:text-red-800"
                        >
                          Delete
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={page <= 1 || pending}
            onClick={() => reload({ page: page - 1 })}
            className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-3 py-2 text-sm text-fg disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-xs text-fg-subtle">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount || pending}
            onClick={() => reload({ page: page + 1 })}
            className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-3 py-2 text-sm text-fg disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {!can.read ? (
        <p className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <Users className="h-4 w-4" /> You do not have the <code>users:read</code> permission.
        </p>
      ) : null}
    </div>
  );
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return date.toLocaleDateString();
}
