'use client';

import React, { use, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Info,
  KeyRound,
  Pencil,
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
import { PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { grantListToState, stateToGrants } from './shared';
import { PermissionMatrix, type GrantValue, type PermissionMatrixState } from './PermissionMatrix';

const fieldClass =
  'w-full min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';
const labelClass = 'block text-xs font-medium text-fg-muted';
const secondaryButtonClass =
  'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm text-fg hover:bg-hover disabled:opacity-50';

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
    mustChangePassword: true,
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

/** Empty filter inputs mean "no filter". */
function optional(value: string): string | undefined {
  return value === '' ? undefined : value;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const formHeadingId = useId();
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  // Where keyboard focus returns when the editor closes.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (showForm) {
      formHeadingRef.current?.focus();
    }
  }, [showForm, editingId]);

  const access = setup.access;
  const can = useMemo(() => {
    const has = (key: PermissionKey) => access.permissions.includes(key);
    return {
      read: has('users:read'),
      create: has('users:create'),
      update: has('users:update'),
      del: has('users:delete'),
      manageRoles: has('users:manage_roles'),
      resetPassword: has('users:reset_password'),
    };
  }, [access]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const rememberTrigger = () => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const closeForm = () => {
    setShowForm(false);
    returnFocusRef.current?.focus();
  };

  const reload = (
    next: Partial<{ search: string; role: string; status: string; page: number }>,
  ) => {
    startTransition(async () => {
      try {
        setError(null);
        const result = await listUsersAction({
          search: optional(next.search ?? search),
          role: optional(next.role ?? roleFilter),
          status: optional(next.status ?? statusFilter),
          page: next.page ?? page,
          pageSize,
        });
        setRows(result.rows);
        setTotal(result.total);
        setPage(result.page);
      } catch (err) {
        setError(errorMessage(err, 'Failed to load users'));
      }
    });
  };

  const openNew = () => {
    rememberTrigger();
    setEditingId(null);
    setForm(makeEmptyForm(assignableRoles[0]?.key ?? ''));
    setShowForm(true);
    setError(null);
    setNotice(null);
  };

  const openEdit = (row: UserListEntry) => {
    rememberTrigger();
    setEditingId(row.id);
    setShowForm(true);
    setError(null);
    setNotice(null);
    setForm(makeEmptyForm(row.role));
    startTransition(async () => {
      try {
        const detail = await getUserDetailAction(row.id);
        if (!detail) {
          return;
        }
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
        setError(errorMessage(err, 'Failed to load user'));
      }
    });
  };

  const addExtraRole = () => {
    const next = assignableRoles.find(
      (r) => r.key !== form.role && !form.extraRoles.some((extra) => extra.roleKey === r.key),
    );
    if (next === undefined) {
      return;
    }
    setForm((f) => ({
      ...f,
      extraRoles: [...f.extraRoles, { roleKey: next.key, branchId: '' }],
    }));
  };

  const removeExtraRole = (index: number) => {
    setForm((f) => ({ ...f, extraRoles: f.extraRoles.filter((_, i) => i !== index) }));
  };

  const save = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        setError(null);
        setNotice(null);
        if (form.name.trim() === '') {
          throw new Error('Display name is required');
        }
        const directGrants: DirectGrantInput[] = stateToGrants(form.grants);
        const extraRoles: RoleAssignment[] = form.extraRoles
          .filter((r) => r.roleKey !== '')
          .map((r) => ({ roleKey: r.roleKey, branchId: r.branchId === '' ? null : r.branchId }));
        let successMessage = 'User changes saved.';

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
            successMessage =
              'User changes saved. They will be asked to choose a new password at their next sign-in.';
          }
          if (can.manageRoles) {
            await assignRolesAction(editingId, extraRoles);
            await setDirectGrantsAction(editingId, directGrants);
          }
        } else {
          const { user, welcomeEmailSent } = await createUserAction({
            email: form.email.trim(),
            password: form.password,
            name: form.name,
            title: form.title === '' ? null : form.title,
            phone: form.phone === '' ? null : form.phone,
            role: form.role,
            status: form.status,
            branchId: form.branchId === '' ? null : form.branchId,
            extraRoles,
            directGrants,
          });
          successMessage = welcomeEmailSent
            ? `${user.name} was created. Their sign-in details were emailed to ${user.email}.`
            : `${user.name} was created, but the welcome email could not be sent. Share the temporary password with them securely — they must change it at first sign-in.`;
        }
        closeForm();
        setNotice(successMessage);
        if (editingId === null) {
          setPage(1);
          reload({ page: 1 });
        } else {
          reload({});
        }
      } catch (err) {
        setError(errorMessage(err, 'Failed to save user'));
      }
    });
  };

  const removeUser = (row: UserListEntry) => {
    // eslint-disable-next-line no-alert -- native confirm is keyboard and screen-reader accessible
    if (!window.confirm(`Delete ${row.name} (${row.email})? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      try {
        setError(null);
        await deleteUserAction(row.id);
        setRows((prev) => prev.filter((item) => item.id !== row.id));
        setTotal((prev) => Math.max(0, prev - 1));
        setNotice(`${row.name} was deleted.`);
        if (editingId === row.id) {
          setEditingId(null);
          setShowForm(false);
        }
      } catch (err) {
        setError(errorMessage(err, 'Failed to delete user'));
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
        setForm((f) => ({ ...f, status: nextStatus }));
        setNotice(`${row.name} is now ${nextStatus}.`);
      } catch (err) {
        setError(errorMessage(err, 'Failed to update status'));
      }
    });
  };

  const applyFilters = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    reload({ page: 1 });
  };

  const editingRow = editingId === null ? undefined : rows.find((item) => item.id === editingId);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-fg-strong">
            <UserCog className="h-5 w-5 shrink-0 text-indigo-500" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Users &amp; Access</h2>
            {access.superAdmin ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-3 py-1 text-xs text-white">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Super admin
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Manage who can sign in and what they can do. Roles are coarse-grained RBAC grants;
            direct grants override roles per user; ABAC access policies add context-aware rules on
            top. Every sensitive change is written to the audit trail.
          </p>
        </div>
        {can.create ? (
          <button
            type="button"
            onClick={openNew}
            className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 sm:w-auto"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New user
          </button>
        ) : null}
      </header>

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
        <p
          className="rounded-lg border border-red-500/40 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div aria-live="polite">
        {notice !== null ? (
          <p className="rounded-lg border border-emerald-500/40 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        ) : null}
      </div>

      {showForm ? (
        <form
          onSubmit={save}
          aria-labelledby={formHeadingId}
          aria-busy={pending}
          className="space-y-5 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:p-5"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              closeForm();
            }
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h3
              id={formHeadingId}
              ref={formHeadingRef}
              tabIndex={-1}
              className="text-base font-semibold text-fg-strong focus:outline-none"
            >
              {editingId !== null ? `Edit ${form.name === '' ? 'user' : form.name}` : 'New user'}
            </h3>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Close user editor"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-fg-subtle hover:bg-hover hover:text-fg-strong"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Full name
              <input
                className={`${fieldClass} mt-1`}
                required
                autoComplete="off"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className={labelClass}>
              Email
              <input
                className={`${fieldClass} mt-1 disabled:opacity-60`}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                required={editingId === null}
                value={form.email}
                disabled={editingId !== null}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="user@company.com"
                aria-describedby={editingId !== null ? `${formHeadingId}-email-hint` : undefined}
              />
              {editingId !== null ? (
                <span id={`${formHeadingId}-email-hint`} className="mt-1 block text-fg-subtle">
                  Email can’t be changed after the account is created.
                </span>
              ) : null}
            </label>
            <label className={labelClass}>
              Title / job role
              <input
                className={`${fieldClass} mt-1`}
                autoComplete="off"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Sales Manager"
              />
            </label>
            <label className={labelClass}>
              Phone
              <input
                className={`${fieldClass} mt-1`}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="0712 000 000"
              />
            </label>
            <label className={labelClass}>
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
            <label className={labelClass}>
              Status
              <select
                className={`${fieldClass} mt-1`}
                value={form.status}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    status: e.target.value === 'suspended' ? 'suspended' : 'active',
                  }))
                }
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            </label>
            <label className={labelClass}>
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
              <div className="space-y-1">
                <label htmlFor={`${formHeadingId}-password`} className={labelClass}>
                  Temporary password
                </label>
                <PasswordInput
                  id={`${formHeadingId}-password`}
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
                  aria-describedby={`${formHeadingId}-password-hint`}
                />
              </div>
            ) : null}
            {editingId !== null && can.resetPassword ? (
              <div className="space-y-1">
                <label htmlFor={`${formHeadingId}-new-password`} className={labelClass}>
                  Set a new temporary password
                </label>
                <PasswordInput
                  id={`${formHeadingId}-new-password`}
                  minLength={PASSWORD_MIN_LENGTH}
                  autoComplete="new-password"
                  value={form.newPassword}
                  onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
                  placeholder="Leave blank to keep the current password"
                  aria-describedby={`${formHeadingId}-password-hint`}
                />
              </div>
            ) : null}

            <p
              id={`${formHeadingId}-password-hint`}
              className="flex items-start gap-2 rounded-lg border border-indigo-500/30 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 sm:col-span-2 dark:bg-indigo-950/40 dark:text-indigo-200"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {editingId === null ? (
                <span>
                  We’ll email the user their sign-in email and this temporary password. They must
                  choose their own password the first time they sign in.
                </span>
              ) : (
                <span>
                  {form.mustChangePassword
                    ? 'This user has not yet replaced their temporary password. '
                    : ''}
                  Setting a new password here makes it temporary: the user must change it at their
                  next sign-in.
                </span>
              )}
            </p>
          </div>

          {can.manageRoles ? (
            <>
              <fieldset className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <legend className="text-xs font-medium text-fg-muted">
                    Additional roles (RBAC — branch-scoped assignments supported)
                  </legend>
                  <button type="button" onClick={addExtraRole} className={secondaryButtonClass}>
                    <Plus className="h-4 w-4" aria-hidden="true" /> Add role
                  </button>
                </div>
                {form.extraRoles.length === 0 ? (
                  <p className="text-xs text-fg-subtle">
                    No additional roles. Roles here stack on top of the primary role.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {form.extraRoles.map((extra, index) => {
                      const name = roleLabel(setup.roles, extra.roleKey);
                      return (
                        <li
                          key={extra.roleKey}
                          className="grid gap-2 rounded-lg border border-line p-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center sm:border-0 sm:p-0"
                        >
                          <select
                            className={fieldClass}
                            aria-label={`Additional role ${index + 1}`}
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
                            className={fieldClass}
                            aria-label={`Branch scope for ${name}`}
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
                            aria-label={`Remove role ${name}`}
                            className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg px-3 text-sm text-red-700 hover:bg-red-50 dark:text-red-400"
                          >
                            <X className="h-4 w-4" aria-hidden="true" />
                            Remove
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>

              <fieldset>
                <legend className="mb-2 flex items-center gap-2 text-xs font-medium text-fg-muted">
                  <KeyRound className="h-3 w-3" aria-hidden="true" />
                  Direct permission overrides (highest precedence, RBAC + enforcement)
                </legend>
                <PermissionMatrix
                  grants={form.grants}
                  onChange={(key, value: GrantValue) =>
                    setForm((f) => ({ ...f, grants: { ...f.grants, [key]: value } }))
                  }
                />
              </fieldset>
            </>
          ) : null}

          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:flex-wrap sm:items-center">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 sm:order-first"
            >
              {pending ? <RotateCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {editingId !== null ? 'Save changes' : 'Create user'}
            </button>
            {editingRow !== undefined && can.update ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => toggleStatus(editingRow)}
                className={secondaryButtonClass}
              >
                {form.status === 'suspended' ? 'Reactivate' : 'Suspend'}
              </button>
            ) : null}
            {editingRow !== undefined && can.del && access.userId !== editingRow.id ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => removeUser(editingRow)}
                className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-red-700 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-400"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </button>
            ) : null}
            <button type="button" onClick={closeForm} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <form
        role="search"
        aria-label="Filter users"
        onSubmit={applyFilters}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_12rem_10rem_auto] lg:items-end"
      >
        <label className={labelClass}>
          Search
          <span className="relative mt-1 block">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-faint"
              aria-hidden="true"
            />
            <input
              type="search"
              className={`${fieldClass} pl-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or email"
            />
          </span>
        </label>
        <label className={labelClass}>
          Primary role
          <select
            className={`${fieldClass} mt-1`}
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
        <label className={labelClass}>
          Status
          <select
            className={`${fieldClass} mt-1`}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          Apply filters
        </button>
      </form>

      <p className="text-xs text-fg-subtle" aria-live="polite">
        {total} user{total === 1 ? '' : 's'}
      </p>

      <div aria-busy={pending}>
        {rows.length === 0 ? (
          <p className="rounded-xl border border-line px-4 py-6 text-sm text-fg-subtle">
            No users found. Adjust the filters or create your first user.
          </p>
        ) : (
          <>
            {/* Phones and small tablets: one card per user. */}
            <ul className="space-y-3 md:hidden">
              {rows.map((row) => (
                <li key={row.id} className="rounded-xl border border-line bg-surface p-4">
                  <UserSummary row={row} roles={setup.roles} isSelf={access.userId === row.id} />
                  <div className="mt-3 flex gap-2 border-t border-line pt-3">
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      aria-label={`Edit ${row.name}`}
                      className={`${secondaryButtonClass} flex-1`}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
                    </button>
                    {access.userId !== row.id && can.del ? (
                      <button
                        type="button"
                        onClick={() => removeUser(row)}
                        aria-label={`Delete ${row.name}`}
                        className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-700 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            {/* Tablets and up: a table. Scrolls sideways rather than clipping if space runs out. */}
            <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
              <table className="w-full min-w-[40rem] text-left text-sm text-fg">
                <caption className="sr-only">
                  Users, page {page} of {pageCount}
                </caption>
                <thead className="bg-surface-raised text-xs text-fg-subtle">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      User
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Roles
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Last sign-in
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isSelf = access.userId === row.id;
                    return (
                      <tr key={row.id} className="border-t border-line hover:bg-hover">
                        <td className="px-4 py-3">
                          <p className="text-fg-strong">
                            {row.name}{' '}
                            {isSelf ? (
                              <span className="text-xs text-indigo-700 dark:text-indigo-300">
                                (you)
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs break-all text-fg-subtle">{row.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <RoleChips row={row} roles={setup.roles} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusChips row={row} />
                        </td>
                        <td className="px-4 py-3 text-xs whitespace-nowrap text-fg-subtle">
                          {row.lastLoginAt ? timeAgo(row.lastLoginAt) : 'Never'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => openEdit(row)}
                              aria-label={`Edit ${row.name}`}
                              className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-indigo-700 hover:bg-hover dark:text-indigo-300"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
                            </button>
                            {!isSelf && can.del ? (
                              <button
                                type="button"
                                onClick={() => removeUser(row)}
                                aria-label={`Delete ${row.name}`}
                                className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs text-red-700 hover:bg-red-50 dark:text-red-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {pageCount > 1 ? (
        <nav aria-label="Users pagination" className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={page <= 1 || pending}
            onClick={() => reload({ page: page - 1 })}
            className={secondaryButtonClass}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
          </button>
          <span className="text-xs text-fg-subtle" aria-live="polite">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount || pending}
            onClick={() => reload({ page: page + 1 })}
            className={secondaryButtonClass}
          >
            Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </nav>
      ) : null}

      {!can.read ? (
        <p className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <Users className="h-4 w-4" aria-hidden="true" /> You do not have the{' '}
          <code>users:read</code> permission.
        </p>
      ) : null}
    </div>
  );
}

function UserSummary({
  row,
  roles,
  isSelf,
}: {
  row: UserListEntry;
  roles: UsersSetup['roles'];
  isSelf: boolean;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="font-medium text-fg-strong">
          {row.name}{' '}
          {isSelf ? (
            <span className="text-xs text-indigo-700 dark:text-indigo-300">(you)</span>
          ) : null}
        </p>
        <p className="text-xs break-all text-fg-subtle">{row.email}</p>
      </div>
      <RoleChips row={row} roles={roles} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusChips row={row} />
        <span className="text-xs text-fg-subtle">
          Last sign-in: {row.lastLoginAt ? timeAgo(row.lastLoginAt) : 'never'}
        </span>
      </div>
    </div>
  );
}

function RoleChips({ row, roles }: { row: UserListEntry; roles: UsersSetup['roles'] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Roles">
      <li className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-fg">
        {roleLabel(roles, row.role)}
      </li>
      {row.extraRoles.map((key) => (
        <li
          key={key}
          className="rounded-full border border-indigo-700/60 px-2 py-0.5 text-[11px] text-indigo-700 dark:text-indigo-300"
        >
          {roleLabel(roles, key)}
        </li>
      ))}
    </ul>
  );
}

function StatusChips({ row }: { row: UserListEntry }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] capitalize ${
          row.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-50 text-red-800'
        }`}
      >
        {row.status}
      </span>
      {row.mustChangePassword ? (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
          Password change pending
        </span>
      ) : null}
    </span>
  );
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return date.toLocaleDateString();
}
