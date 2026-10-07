'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createNumberSeriesAction,
  seedStandardNumberSeriesAction,
  type SeriesSummary,
} from '@/server/kernel/numbering/actions';

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none';
const buttonClass =
  'min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-4 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:opacity-50';

export function ModeChip({ mode }: { mode: 'gap_free' | 'allow_gaps' }) {
  return mode === 'gap_free' ? (
    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
      Gap-free
    </span>
  ) : (
    <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
      Allows gaps · fast
    </span>
  );
}

export function NumberSeriesListClient({ series }: { series: SeriesSummary[] }) {
  const uid = useId();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState({
    code: '',
    description: '',
    mode: 'gap_free' as 'gap_free' | 'allow_gaps',
  });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await createNumberSeriesAction({ ...form });
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    router.push(`/admin/settings/number-series/${res.data.id}`);
  };

  const seed = async () => {
    setBusy(true);
    setMessage(null);
    const res = await seedStandardNumberSeriesAction();
    setBusy(false);
    if (!res.ok) return setMessage({ kind: 'error', text: res.error });
    setMessage({
      kind: 'ok',
      text: res.data.created.length
        ? `Set up numbering for ${res.data.created.length} document types.`
        : 'Every document type already has a series.',
    });
    router.refresh();
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-fg-strong">Number series</h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            A series decides how documents are numbered: the pattern, the range, when it restarts,
            and whether gaps are allowed. Tax invoices, credit notes and receipts must be gap-free.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/settings/number-series/bindings"
            className={`${buttonClass} inline-flex items-center`}
          >
            Document numbering
          </Link>
          <button type="button" className={buttonClass} disabled={busy} onClick={seed}>
            Set up standard series
          </button>
          <button
            type="button"
            className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500"
            onClick={() => setCreating((v) => !v)}
            aria-expanded={creating}
          >
            New series
          </button>
        </div>
      </div>

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

      {creating ? (
        <form
          onSubmit={create}
          className="space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-6"
          aria-label="New number series"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-code`} className="mb-1 block text-xs font-semibold text-fg">
                Code
              </label>
              <input
                id={`${uid}-code`}
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                className={`${fieldClass} font-mono`}
                placeholder="INV"
                maxLength={20}
                required
              />
            </div>
            <div>
              <label htmlFor={`${uid}-desc`} className="mb-1 block text-xs font-semibold text-fg">
                Description
              </label>
              <input
                id={`${uid}-desc`}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className={fieldClass}
                required
              />
            </div>
          </div>
          <fieldset>
            <legend className="mb-1 text-xs font-semibold text-fg">Numbering mode</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  [
                    'gap_free',
                    'Gap-free',
                    'Every number is used in order. A failed save gives its number back. For fiscal documents.',
                  ],
                  [
                    'allow_gaps',
                    'Allow gaps',
                    'Numbers are handed out in blocks. Fastest for high volume; a restart can skip numbers.',
                  ],
                ] as const
              ).map(([value, title, hint]) => (
                <label
                  key={value}
                  className={`flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                    form.mode === value
                      ? 'border-indigo-500 bg-indigo-600/15'
                      : 'border-line-strong bg-surface-sunken/60'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${uid}-mode`}
                    checked={form.mode === value}
                    onChange={() => setForm({ ...form, mode: value })}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-fg-strong">{title}</span>
                    <span className="block text-xs text-fg-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-fg-muted">
            You add the numbering lines (pattern and range) on the next screen.
          </p>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Create series
            </button>
            <button type="button" className={buttonClass} onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {series.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-center">
          <p className="text-sm text-fg-muted">
            No number series yet. “Set up standard series” creates one for every document type, with
            sensible patterns, in one step.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3">
          {series.map((s) => (
            <li key={s.id}>
              <Link
                href={`/admin/settings/number-series/${s.id}`}
                className="block rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500/40 hover:bg-hover"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-fg-strong">
                    <span className="font-mono">{s.code}</span>{' '}
                    <span className="font-normal text-fg-muted">{s.description}</span>
                  </p>
                  <span className="flex items-center gap-2">
                    <ModeChip mode={s.mode} />
                    {!s.isActive ? (
                      <span className="rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-fg-muted">
                        Inactive
                      </span>
                    ) : null}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-fg-muted">Next number</dt>
                    <dd className="font-mono text-fg-strong">
                      {s.nextExample ?? (
                        <span className="font-sans text-amber-700">{s.nextProblem}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Lines</dt>
                    <dd className="text-fg-strong">{s.lineCount}</dd>
                  </div>
                  <div>
                    <dt className="text-fg-muted">Numbers</dt>
                    <dd className="text-fg-strong">
                      {s.boundTo.length
                        ? s.boundTo
                            .map((b) => `${b.label}${b.branchCode ? ` (${b.branchCode})` : ''}`)
                            .join(', ')
                        : 'Not used by any document yet'}
                    </dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
