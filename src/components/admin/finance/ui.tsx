'use client';

import type { ReactNode } from 'react';
import { businessDate } from '@/server/kernel/numbering/business-date';

export const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none disabled:opacity-60';
export const buttonClass =
  'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg border border-line-strong bg-surface-sunken px-4 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50';
export const primaryClass =
  'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
export const dangerClass =
  'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50';
export const cardClass = 'rounded-xl border border-line bg-surface-raised p-4 sm:p-5';

/** "12345.6700" -> "12,345.67"; keeps the extra places only when they are not zero. */
export function money(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const negative = value.startsWith('-');
  const [whole = '0', frac = ''] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = frac.slice(0, 2).padEnd(2, '0');
  const extra = frac.slice(2).replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped}.${cents}${extra}`;
}

export const isZeroAmount = (v: string) => /^-?0*\.?0*$/.test(v);

export function PageHeader({ title, intro, actions }: { title: string; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-bold text-fg-strong">{title}</h2>
        {intro !== undefined ? <p className="mt-1 max-w-2xl text-sm text-fg-muted">{intro}</p> : null}
      </div>
      {actions !== undefined ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export type Notice = { kind: 'ok' | 'error'; text: string } | null;

/** One live region for results, so screen readers hear every change. */
export function Message({ notice }: { notice: Notice }) {
  return (
    <div aria-live="polite" className="min-h-5">
      {notice ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`text-sm ${notice.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

/** What shows while a screen's data is on its way, so the page is never blank. */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
      <span className="sr-only">Loading {label}…</span>
      <div className="h-7 w-48 animate-pulse rounded bg-surface-sunken" />
      <div className="h-24 animate-pulse rounded-xl bg-surface-sunken" />
      <div className="h-24 animate-pulse rounded-xl bg-surface-sunken" />
    </div>
  );
}

export function LoadFailed({ error }: { error: string }) {
  return (
    <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
      {error}
    </p>
  );
}

export function Chip({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'sky' | 'gray'; children: ReactNode }) {
  const tones = {
    green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700',
    amber: 'border-amber-500/20 bg-amber-500/10 text-amber-700',
    red: 'border-red-500/20 bg-red-500/10 text-red-700',
    sky: 'border-sky-500/20 bg-sky-500/10 text-sky-700',
    gray: 'border-line bg-surface-sunken text-fg-muted',
  };
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tones[tone]}`}>{children}</span>;
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-fg">
        {label}
      </label>
      {children}
      {hint !== undefined && hint !== '' ? <p className="mt-1 text-[11px] text-fg-muted">{hint}</p> : null}
    </div>
  );
}

/** Today's date in the business's own timezone: the same day the server files documents under. */
export const today = () => businessDate();

/**
 * Runs a server action and turns a lost connection into a message instead of a frozen screen.
 * (A server action that throws on the way — a dropped mobile connection — rejects the promise;
 * without this the form would stay "busy" forever with nothing said.)
 */
export async function attempt<T extends { ok: boolean }>(call: Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call;
  } catch {
    return {
      ok: false,
      error: 'The server could not be reached. Check your connection and try again. If you were saving something, look for it in the list before entering it again.',
    };
  }
}
