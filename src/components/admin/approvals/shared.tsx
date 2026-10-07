'use client';

import { useEffect, useState } from 'react';

export const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none disabled:opacity-60';
export const buttonClass =
  'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-sunken px-4 py-2 text-xs font-semibold text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
export const primaryButtonClass =
  'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
export const dangerButtonClass =
  'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-not-allowed disabled:opacity-50';
export const labelClass = 'mb-1 block text-xs font-semibold text-fg';
export const cardClass = 'rounded-xl border border-line bg-surface-raised p-4 sm:p-5';

export type Message = { kind: 'ok' | 'error'; text: string } | null;

/** One place for results, announced to screen readers. */
export function Notice({ message }: { message: Message }) {
  return (
    <div aria-live="polite">
      {message ? (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

const chipTone = {
  green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
  red: 'border-red-500/20 bg-red-500/10 text-red-700',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  sky: 'border-sky-500/20 bg-sky-500/10 text-sky-700',
  grey: 'border-line bg-surface-sunken text-fg-muted',
} as const;

export function Chip({
  tone,
  children,
}: {
  tone: keyof typeof chipTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${chipTone[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS: Record<string, { tone: keyof typeof chipTone; label: string }> = {
  pending: { tone: 'amber', label: 'Waiting for approval' },
  approved: { tone: 'green', label: 'Approved' },
  rejected: { tone: 'red', label: 'Rejected' },
  canceled: { tone: 'grey', label: 'Withdrawn' },
  superseded: { tone: 'grey', label: 'Voided: document changed' },
  reopened: { tone: 'sky', label: 'Reopened' },
  open: { tone: 'amber', label: 'Waiting' },
  draft: { tone: 'grey', label: 'Draft' },
  enabled: { tone: 'green', label: 'On' },
  disabled: { tone: 'grey', label: 'Off' },
  retired: { tone: 'grey', label: 'Retired' },
};

export function StatusChip({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'grey' as const, label: status };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export const money = (n: number) =>
  `KES ${n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** "3 h ago" for people, with the exact time available as a tooltip. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function When({ iso }: { iso: string }) {
  // Rendered after mount so server and browser agree on the text.
  const [text, setText] = useState('');
  useEffect(() => setText(ago(iso)), [iso]);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString('en-KE')}>
      {text || ' '}
    </time>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong p-8 text-center">
      <p className="text-sm font-semibold text-fg-strong">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm text-fg-muted">{children}</p> : null}
    </div>
  );
}

export function PageHeader({
  title,
  children,
  actions,
}: {
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold text-fg-strong">{title}</h2>
        {children ? <p className="mt-1 max-w-2xl text-sm text-fg-muted">{children}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'approvals.requested': 'Approval required',
  'approvals.asked': 'Asked for approval',
  'approvals.entry_approved': 'Approved',
  'approvals.entry_rejected': 'Rejected',
  'approvals.approved': 'All steps approved',
  'approvals.released': 'Document released',
  'approvals.canceled': 'Withdrawn',
  'approvals.reopened': 'Reopened for changes',
  'approvals.superseded': 'Voided because the document changed',
  'approvals.step_skipped': 'Step skipped',
  'approvals.not_required': 'No approval needed',
};
export const actionLabel = (a: string) =>
  ACTION_LABELS[a] ?? a.replace(/^approvals\./, '').replace(/_/g, ' ');
