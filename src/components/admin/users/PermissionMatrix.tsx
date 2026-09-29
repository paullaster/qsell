'use client';

import { Ban, Check, X } from 'lucide-react';
import {
  ALL_PERMISSION_KEYS,
  groupPermissionsByCategory,
  type PermissionKey,
} from '@/server/domains/access-control/permissions';

export type GrantValue = 'allow' | 'deny' | null;

export interface PermissionMatrixState {
  grants: Partial<Record<PermissionKey, GrantValue>>;
}

function GrantToggle({
  active,
  tone,
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  active: boolean;
  tone: 'emerald' | 'red';
  label: string;
  icon: typeof Check;
  onClick: () => void;
  disabled: boolean;
}) {
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-700 text-emerald-700 hover:bg-emerald-100'
      : 'border-red-800 text-red-700 hover:bg-red-50';
  const activeClass =
    tone === 'emerald'
      ? 'border-emerald-500 bg-emerald-100 text-emerald-800'
      : 'border-red-500 bg-red-50 text-red-800';
  const stateClass = active ? activeClass : `${toneClass} bg-transparent`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 py-1 text-xs disabled:opacity-40 ${stateClass}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Three-state grant editor grouped by category.
 * `onChange(key, value)` with value `allow` | `deny` | `null` (unset).
 */
export function PermissionMatrix({
  grants,
  onChange,
  disabledKeys,
}: {
  grants: PermissionMatrixState['grants'];
  onChange: (key: PermissionKey, value: GrantValue) => void;
  disabledKeys?: ReadonlySet<PermissionKey>;
}) {
  const groups = groupPermissionsByCategory(ALL_PERMISSION_KEYS);

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.category} className="rounded-xl border border-line p-3">
          <h4 className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
            {group.category}
          </h4>
          <div className="divide-y divide-line/70">
            {group.permissions.map(({ key, meta }) => {
              const value = grants[key];
              const disabled = disabledKeys?.has(key) ?? false;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0">
                    <p id={`perm-${key}`} className="text-sm text-fg-strong">
                      {meta.resource}
                    </p>
                    <p className="text-[11px] break-all text-fg-subtle">{key}</p>
                  </div>
                  <div
                    role="group"
                    aria-labelledby={`perm-${key}`}
                    className="flex shrink-0 flex-wrap gap-1"
                  >
                    <GrantToggle
                      active={value === 'allow'}
                      tone="emerald"
                      label="Allow"
                      icon={Check}
                      disabled={disabled}
                      onClick={() => onChange(key, value === 'allow' ? null : 'allow')}
                    />
                    <GrantToggle
                      active={value === 'deny'}
                      tone="red"
                      label="Deny"
                      icon={X}
                      disabled={disabled}
                      onClick={() => onChange(key, value === 'deny' ? null : 'deny')}
                    />
                    {value !== null && value !== undefined ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange(key, null)}
                        className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line-strong px-2.5 py-1 text-xs text-fg-muted hover:bg-hover disabled:opacity-40"
                      >
                        <Ban className="h-3 w-3" aria-hidden="true" />
                        Unset
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
