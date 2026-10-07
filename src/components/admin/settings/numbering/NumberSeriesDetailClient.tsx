'use client';

import Link from 'next/link';
import { useCallback, useId, useMemo, useState } from 'react';
import {
  addNumberSeriesLineAction,
  getNumberSeriesAction,
  previewNumberAction,
  setNumberSeriesLineOpenAction,
  updateNumberSeriesAction,
  updateNumberSeriesLineAction,
  type LineView,
  type SeriesDetailView,
} from '@/server/kernel/numbering/actions';
import type { NumberPreview } from '@/server/kernel/numbering/service';
import { formatNumber } from '@/server/kernel/numbering/domain/format';
import { TEMPLATE_TOKENS, validateTemplate } from '@/server/kernel/numbering/domain/template';
import { ModeChip } from './NumberSeriesListClient';
import { ReasonField, reasonReady, type ReasonValue } from './ReasonField';

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none disabled:opacity-60';
const buttonClass =
  'min-h-10 cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg hover:bg-hover disabled:opacity-50';
const primaryClass =
  'min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50';
const cardClass = 'space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-6';
const today = () => new Date().toISOString().slice(0, 10);
const noReason: ReasonValue = { code: '', text: '' };

const ACTION_LABEL: Record<string, string> = {
  'numbering.series_created': 'Series created',
  'numbering.series_updated': 'Series changed',
  'numbering.series_deleted': 'Series deleted',
  'numbering.line_added': 'Line added',
  'numbering.line_updated': 'Line changed',
  'numbering.line_closed': 'Line closed',
  'numbering.line_opened': 'Line reopened',
  'numbering.binding_set': 'Document linked',
  'numbering.binding_cleared': 'Document unlinked',
  'numbering.near_end': 'Near the end of its range',
};

type Message = { kind: 'ok' | 'error'; text: string } | null;

export function NumberSeriesDetailClient({ initial }: { initial: SeriesDetailView }) {
  const [data, setData] = useState(initial);
  const [message, setMessage] = useState<Message>(null);

  const reload = useCallback(async () => {
    const res = await getNumberSeriesAction(initial.series.id);
    if (res.ok) setData(res.data);
  }, [initial.series.id]);

  const report = useCallback(
    async (res: { ok: boolean; error?: string }, success: string) => {
      if (res.ok) {
        setMessage({ kind: 'ok', text: success });
        await reload();
        return true;
      }
      setMessage({ kind: 'error', text: res.error ?? 'Something went wrong.' });
      return false;
    },
    [reload],
  );

  const { series } = data;
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <Link
          href="/admin/settings/number-series"
          className="text-xs font-semibold text-indigo-500 underline"
        >
          ← All number series
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-fg-strong">
            <span className="font-mono">{series.code}</span>{' '}
            <span className="font-normal text-fg-muted">{series.description}</span>
          </h2>
          <ModeChip mode={series.mode} />
          {!series.isActive ? (
            <span className="rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-fg-muted">
              Inactive
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          {data.boundTo.length
            ? `Numbers: ${data.boundTo.map((b) => `${b.label}${b.branchCode ? ` (${b.branchCode})` : ''}`).join(', ')}.`
            : 'Not used by any document yet. Link it under Document numbering.'}
        </p>
      </div>

      <div aria-live="polite">
        {message ? (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`rounded-lg p-3 text-sm ${message.kind === 'error' ? 'border border-red-500/20 bg-red-500/10 text-red-700' : 'text-emerald-700'}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>

      <SettingsCard data={data} report={report} />
      <LinesCard data={data} report={report} setMessage={setMessage} />
      <TryItCard data={data} />
      <RecentCard data={data} />
      <HistoryCard data={data} />
    </div>
  );
}

// ═══ Settings ═══════════════════════════════════════════════════════════

function SettingsCard({
  data,
  report,
}: {
  data: SeriesDetailView;
  report: (res: { ok: boolean; error?: string }, success: string) => Promise<boolean>;
}) {
  const uid = useId();
  const s = data.series;
  const [form, setForm] = useState({
    description: s.description,
    mode: s.mode,
    manualAllowed: s.manualAllowed,
    defaultNumbers: s.defaultNumbers,
    dateOrder: s.dateOrder,
    blockSize: String(s.blockSize),
    isActive: s.isActive,
  });
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);
  const fiscalLocked = data.fiscalKinds.length > 0;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await updateNumberSeriesAction(
      s.id,
      {
        description: form.description,
        mode: form.mode,
        manualAllowed: form.manualAllowed,
        defaultNumbers: form.defaultNumbers,
        dateOrder: form.mode === 'gap_free' ? form.dateOrder : false,
        blockSize: Number(form.blockSize) || 50,
        isActive: form.isActive,
      },
      reason,
    );
    if (await report(res, 'Series saved.')) setReason(noReason);
    setBusy(false);
  };

  return (
    <form onSubmit={save} className={cardClass} aria-label="Series settings">
      <h3 className="text-base font-bold text-fg-strong">Settings</h3>
      <div>
        <label htmlFor={`${uid}-d`} className="mb-1 block text-xs font-semibold text-fg">
          Description
        </label>
        <input
          id={`${uid}-d`}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className={fieldClass}
          required
        />
      </div>
      <fieldset>
        <legend className="mb-1 text-xs font-semibold text-fg">Numbering mode</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              ['gap_free', 'Gap-free', 'No missing numbers. Required for fiscal documents.'],
              ['allow_gaps', 'Allow gaps', 'Faster for high volume; a restart can skip numbers.'],
            ] as const
          ).map(([value, title, hint]) => {
            const blocked = value === 'allow_gaps' && fiscalLocked;
            return (
              <label
                key={value}
                className={`flex min-h-10 items-start gap-3 rounded-lg border p-3 ${blocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${form.mode === value ? 'border-indigo-500 bg-indigo-600/15' : 'border-line-strong bg-surface-sunken/60'}`}
              >
                <input
                  type="radio"
                  name={`${uid}-mode`}
                  disabled={blocked}
                  checked={form.mode === value}
                  onChange={() =>
                    setForm({
                      ...form,
                      mode: value,
                      dateOrder: value === 'gap_free' ? form.dateOrder : false,
                    })
                  }
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-semibold text-fg-strong">{title}</span>
                  <span className="block text-xs text-fg-muted">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {fiscalLocked ? (
          <p className="mt-1 text-xs text-fg-muted">
            Locked to gap-free because it numbers {data.fiscalKinds.join(', ')}.
          </p>
        ) : null}
      </fieldset>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {(
          [
            ['defaultNumbers', 'Number documents automatically'],
            ['manualAllowed', 'Allow typed-in numbers'],
            ['isActive', 'Series is active'],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg"
          >
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        {form.mode === 'gap_free' ? (
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={form.dateOrder}
              onChange={(e) => setForm({ ...form, dateOrder: e.target.checked })}
            />
            Numbers must follow document dates
          </label>
        ) : (
          <div className="sm:col-span-1">
            <label htmlFor={`${uid}-b`} className="mb-1 block text-xs font-semibold text-fg">
              Block size
            </label>
            <input
              id={`${uid}-b`}
              type="number"
              min={1}
              max={10000}
              value={form.blockSize}
              onChange={(e) => setForm({ ...form, blockSize: e.target.value })}
              className={fieldClass}
            />
            <p className="mt-1 text-[11px] text-fg-muted">
              Numbers taken per trip to the database. Larger is faster; a restart can skip up to
              this many.
            </p>
          </div>
        )}
      </div>
      <ReasonField value={reason} onChange={setReason} />
      <button type="submit" disabled={busy || !reasonReady(reason)} className={primaryClass}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}

// ═══ Lines ══════════════════════════════════════════════════════════════

function LinesCard({
  data,
  report,
  setMessage,
}: {
  data: SeriesDetailView;
  report: (res: { ok: boolean; error?: string }, success: string) => Promise<boolean>;
  setMessage: (m: Message) => void;
}) {
  const [editing, setEditing] = useState<LineView | 'new' | null>(null);
  const [closing, setClosing] = useState<LineView | null>(null);
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);

  const toggle = async (line: LineView) => {
    setBusy(true);
    const res = await setNumberSeriesLineOpenAction(line.id, !line.isOpen, reason);
    if (
      await report(
        res,
        line.isOpen ? `Line ${line.lineNo} closed.` : `Line ${line.lineNo} reopened.`,
      )
    ) {
      setClosing(null);
      setReason(noReason);
    }
    setBusy(false);
  };

  return (
    <section className={cardClass} aria-label="Numbering lines">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-fg-strong">Lines</h3>
          <p className="text-xs text-fg-muted">
            Each line is a range with a pattern. The most specific open line for the document’s date
            and branch is used.
          </p>
        </div>
        <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
          Add line
        </button>
      </div>

      {editing ? (
        <LineEditor
          key={editing === 'new' ? 'new' : editing.id}
          seriesId={data.series.id}
          mode={data.series.mode}
          branches={data.branches}
          line={editing === 'new' ? null : editing}
          onDone={async (ok) => {
            if (ok) setEditing(null);
          }}
          report={report}
          setMessage={setMessage}
        />
      ) : null}

      {data.lines.length === 0 ? (
        <p className="text-sm text-amber-700">
          This series has no lines, so it cannot number anything yet. Add one.
        </p>
      ) : (
        <ul className="divide-y divide-line/60">
          {data.lines.map((l) => (
            <li key={l.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-fg-strong">
                  Line {l.lineNo} · {l.branchCode ? `Branch ${l.branchCode}` : 'All branches'}
                  <span
                    className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${l.isOpen ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700' : 'border-line bg-surface-sunken text-fg-muted'}`}
                  >
                    {l.isOpen ? 'Open' : 'Closed'}
                  </span>
                  {l.used ? (
                    <span className="ml-1 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold text-fg-muted">
                      In use
                    </span>
                  ) : null}
                </p>
                <span className="flex gap-2">
                  <button type="button" className={buttonClass} onClick={() => setEditing(l)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      setClosing(closing?.id === l.id ? null : l);
                      setReason(noReason);
                    }}
                  >
                    {l.isOpen ? 'Close' : 'Reopen'}
                  </button>
                </span>
              </div>
              <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-fg-muted">Pattern</dt>
                  <dd className="font-mono text-fg-strong">
                    {example(l, l.startNo, l.startsOn, l.branchCode) ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Dates</dt>
                  <dd className="text-fg-strong">
                    {l.startsOn} → {l.endsOn ?? 'no end'}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Range</dt>
                  <dd className="text-fg-strong">
                    {l.startNo.toLocaleString()} –{' '}
                    {l.endNo === null ? 'open' : l.endNo.toLocaleString()} (step {l.increment})
                    {l.warnAt !== null ? ` · warns at ${l.warnAt.toLocaleString()}` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Restarts · last issued</dt>
                  <dd className="text-fg-strong">
                    {l.reset === 'never'
                      ? 'Never'
                      : l.reset === 'yearly'
                        ? 'Every year'
                        : 'Every month'}{' '}
                    ·{' '}
                    {l.lastNo === null
                      ? 'none yet'
                      : `${l.lastNo.toLocaleString()}${l.lastPeriod ? ` (${l.lastPeriod})` : ''}`}
                  </dd>
                </div>
              </dl>
              {closing?.id === l.id ? (
                <div className="space-y-3 rounded-lg bg-surface-sunken/60 p-3">
                  <ReasonField value={reason} onChange={setReason} />
                  <button
                    type="button"
                    className={primaryClass}
                    disabled={busy || !reasonReady(reason)}
                    onClick={() => toggle(l)}
                  >
                    {l.isOpen ? 'Close line' : 'Reopen line'}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function example(
  line: Pick<LineView, 'prefix' | 'suffix' | 'digits'>,
  seq: number,
  date: string,
  branchCode: string | null,
): string | null {
  try {
    return formatNumber(line, seq, { date: date || today(), branchCode: branchCode ?? 'NBO' });
  } catch {
    return null;
  }
}

function LineEditor({
  seriesId,
  mode,
  branches,
  line,
  onDone,
  report,
  setMessage,
}: {
  seriesId: string;
  mode: 'gap_free' | 'allow_gaps';
  branches: SeriesDetailView['branches'];
  line: LineView | null;
  onDone: (ok: boolean) => Promise<void>;
  report: (res: { ok: boolean; error?: string }, success: string) => Promise<boolean>;
  setMessage: (m: Message) => void;
}) {
  const uid = useId();
  const frozen = Boolean(line?.used);
  const [f, setF] = useState({
    branchId: line?.branchId ?? '',
    startsOn: line?.startsOn ?? `${today().slice(0, 4)}-01-01`,
    endsOn: line?.endsOn ?? '',
    prefix: line?.prefix ?? '',
    suffix: line?.suffix ?? '',
    digits: String(line?.digits ?? 6),
    startNo: String(line?.startNo ?? 1),
    endNo: line?.endNo === null || line?.endNo === undefined ? '' : String(line.endNo),
    increment: String(line?.increment ?? 1),
    warnAt: line?.warnAt === null || line?.warnAt === undefined ? '' : String(line.warnAt),
    reset: line?.reset ?? ('yearly' as LineView['reset']),
  });
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});

  const branchCode = branches.find((b) => b.id === f.branchId)?.code ?? null;
  const prefixProblem = validateTemplate(f.prefix);
  const suffixProblem = validateTemplate(f.suffix);
  const preview = useMemo(
    () =>
      example(
        { prefix: f.prefix, suffix: f.suffix, digits: Number(f.digits) || 0 },
        Number(f.startNo) || 0,
        f.startsOn,
        branchCode,
      ),
    [f.prefix, f.suffix, f.digits, f.startNo, f.startsOn, branchCode],
  );

  const addToken = (field: 'prefix' | 'suffix', token: string) =>
    setF((p) => ({ ...p, [field]: `${p[field]}{${token}}` }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssues({});
    const values = {
      branchId: f.branchId || null,
      startsOn: f.startsOn,
      endsOn: f.endsOn || null,
      prefix: f.prefix,
      suffix: f.suffix,
      digits: Number(f.digits),
      startNo: Number(f.startNo),
      endNo: f.endNo === '' ? null : Number(f.endNo),
      increment: Number(f.increment),
      warnAt: f.warnAt === '' ? null : Number(f.warnAt),
      reset: f.reset,
    };
    const res = line
      ? await updateNumberSeriesLineAction(line.id, values, reason)
      : await addNumberSeriesLineAction(seriesId, values);
    if (!res.ok && res.issues)
      setIssues(Object.fromEntries(res.issues.map((i) => [i.field, i.message])));
    if (!res.ok) setMessage({ kind: 'error', text: res.error });
    const ok = res.ok ? await report(res, line ? 'Line saved.' : 'Line added.') : false;
    setBusy(false);
    await onDone(ok);
  };

  const input = (
    key: keyof typeof f,
    label: string,
    opts: { type?: string; disabled?: boolean; hint?: string; mono?: boolean } = {},
  ) => (
    <div>
      <label htmlFor={`${uid}-${key}`} className="mb-1 block text-xs font-semibold text-fg">
        {label}
      </label>
      <input
        id={`${uid}-${key}`}
        type={opts.type ?? 'text'}
        value={f[key]}
        disabled={opts.disabled}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
        className={`${fieldClass} ${opts.mono ? 'font-mono' : ''}`}
        aria-invalid={issues[key] ? true : undefined}
      />
      {issues[key] ? (
        <p role="alert" className="mt-1 text-[11px] text-red-700">
          {issues[key]}
        </p>
      ) : opts.hint ? (
        <p className="mt-1 text-[11px] text-fg-muted">{opts.hint}</p>
      ) : null}
    </div>
  );

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-line bg-surface p-4"
      aria-label={line ? `Edit line ${line.lineNo}` : 'Add line'}
    >
      <h4 className="text-sm font-bold text-fg-strong">
        {line ? `Edit line ${line.lineNo}` : 'Add a line'}
      </h4>
      {frozen ? (
        <p className="text-xs text-amber-700">
          This line has issued numbers, so its pattern, start number, step and restart cannot
          change. To change them, close it and add a new line.
        </p>
      ) : null}

      <div className="rounded-lg bg-surface-sunken/60 p-3">
        <p className="text-xs text-fg-muted">The first number will look like</p>
        <p className="font-mono text-lg font-bold text-fg-strong" aria-live="polite">
          {preview ?? '—'}
        </p>
        {prefixProblem || suffixProblem ? (
          <p role="alert" className="text-xs text-red-700">
            {prefixProblem ?? suffixProblem}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-branch`} className="mb-1 block text-xs font-semibold text-fg">
            Applies to
          </label>
          <select
            id={`${uid}-branch`}
            value={f.branchId}
            disabled={frozen}
            onChange={(e) => setF({ ...f, branchId: e.target.value })}
            className={fieldClass}
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-reset`} className="mb-1 block text-xs font-semibold text-fg">
            Restart numbering
          </label>
          <select
            id={`${uid}-reset`}
            value={f.reset}
            disabled={frozen}
            onChange={(e) => setF({ ...f, reset: e.target.value as LineView['reset'] })}
            className={fieldClass}
          >
            <option value="never">Never</option>
            <option value="yearly">Every year</option>
            <option value="monthly">Every month</option>
          </select>
        </div>
        {input('prefix', 'Prefix', { disabled: frozen, mono: true, hint: 'e.g. INV-{YY}-' })}
        {input('suffix', 'Suffix', { disabled: frozen, mono: true })}
        <div
          className="flex flex-wrap items-center gap-2 sm:col-span-2"
          aria-label="Insert a token"
        >
          <span className="text-xs text-fg-muted">Insert into the prefix:</span>
          {TEMPLATE_TOKENS.map((t) => (
            <button
              key={t}
              type="button"
              disabled={frozen}
              className={`${buttonClass} font-mono`}
              onClick={() => addToken('prefix', t)}
            >{`{${t}}`}</button>
          ))}
        </div>
        {input('digits', 'Digits', {
          type: 'number',
          disabled: frozen,
          hint: 'Numbers are padded with zeros to this length (1–15).',
        })}
        {input('startNo', 'Starting number', { type: 'number', disabled: frozen })}
        {input('endNo', 'Ending number', {
          type: 'number',
          hint: 'Leave empty for no limit (up to the digits).',
        })}
        {input('increment', 'Step', { type: 'number', disabled: frozen })}
        {input('warnAt', 'Warn at number', {
          type: 'number',
          hint: 'A warning is raised when this number is reached.',
        })}
        {input('startsOn', 'Starts on', { type: 'date' })}
        {input('endsOn', 'Ends on', { type: 'date', hint: 'Leave empty for no end date.' })}
      </div>
      {mode === 'allow_gaps' ? (
        <p className="text-xs text-fg-muted">
          This series hands out numbers in blocks, so a restart can leave gaps.
        </p>
      ) : null}
      {line ? <ReasonField value={reason} onChange={setReason} /> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            busy ||
            (Boolean(line) && !reasonReady(reason)) ||
            Boolean(prefixProblem || suffixProblem)
          }
          className={primaryClass}
        >
          {busy ? 'Saving…' : line ? 'Save line' : 'Add line'}
        </button>
        <button type="button" className={buttonClass} onClick={() => void onDone(true)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ═══ Try it ═════════════════════════════════════════════════════════════

function TryItCard({ data }: { data: SeriesDetailView }) {
  const uid = useId();
  const [date, setDate] = useState(today());
  const [branchId, setBranchId] = useState('');
  const [result, setResult] = useState<NumberPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const res = await previewNumberAction({
      seriesCode: data.series.code,
      branchId: branchId || null,
      date,
    });
    setResult(
      res.ok
        ? res.data
        : {
            ok: false,
            number: null,
            seriesCode: null,
            lineNo: null,
            note: null,
            error: { code: 'INVALID_CONFIG', message: res.error },
            trace: [],
          },
    );
    setBusy(false);
  };

  return (
    <section className={cardClass} aria-label="Try it">
      <div>
        <h3 className="text-base font-bold text-fg-strong">Try it</h3>
        <p className="text-xs text-fg-muted">
          See which number a document would get, and why. Nothing is used up.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label htmlFor={`${uid}-d`} className="mb-1 block text-xs font-semibold text-fg">
            Document date
          </label>
          <input
            id={`${uid}-d`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-b`} className="mb-1 block text-xs font-semibold text-fg">
            Branch
          </label>
          <select
            id={`${uid}-b`}
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className={fieldClass}
          >
            <option value="">No branch</option>
            {data.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={primaryClass} disabled={busy} onClick={run}>
          Show next number
        </button>
      </div>
      <div aria-live="polite">
        {result ? (
          <div className="space-y-2">
            {result.ok ? (
              <p className="text-sm">
                Next number:{' '}
                <span className="font-mono text-lg font-bold text-fg-strong">{result.number}</span>{' '}
                <span className="text-fg-muted">(line {result.lineNo})</span>
              </p>
            ) : (
              <p role="alert" className="text-sm text-red-700">
                {result.error?.message}
              </p>
            )}
            {result.note ? <p className="text-xs text-fg-muted">{result.note}</p> : null}
            {result.trace.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {result.trace.map((t) => (
                  <li key={t.lineNo} className="flex gap-2">
                    <span
                      className={`w-16 shrink-0 font-semibold ${t.accepted ? 'text-emerald-700' : 'text-fg-muted'}`}
                    >
                      Line {t.lineNo}
                    </span>
                    <span className="text-fg">
                      {t.accepted ? 'usable' : 'skipped'} — {t.reason}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ═══ Recent numbers and history ═════════════════════════════════════════

function RecentCard({ data }: { data: SeriesDetailView }) {
  return (
    <section className={cardClass} aria-label="Recent numbers">
      <h3 className="text-base font-bold text-fg-strong">Recently issued</h3>
      {data.recent.length === 0 ? (
        <p className="text-sm text-fg-muted">No numbers issued yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-xs">
            <caption className="sr-only">Most recent numbers issued by this series</caption>
            <thead className="border-b border-line text-fg-muted uppercase">
              <tr>
                <th scope="col" className="px-2 py-2">
                  Number
                </th>
                <th scope="col" className="px-2 py-2">
                  Document
                </th>
                <th scope="col" className="px-2 py-2">
                  Document date
                </th>
                <th scope="col" className="px-2 py-2">
                  Issued
                </th>
                <th scope="col" className="px-2 py-2">
                  Source
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.recent.map((r) => (
                <tr key={r.number}>
                  <td className="px-2 py-2 font-mono font-semibold text-fg-strong">{r.number}</td>
                  <td className="px-2 py-2 text-fg">
                    {r.documentKind ? `${r.documentKind} ${r.documentId ?? ''}` : '—'}
                  </td>
                  <td className="px-2 py-2 text-fg">{r.documentDate}</td>
                  <td className="px-2 py-2 text-fg-muted">
                    {new Date(r.allocatedAt).toLocaleString()}
                  </td>
                  <td className="px-2 py-2 text-fg-muted">
                    {r.source === 'manual' ? 'Typed in' : 'Automatic'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HistoryCard({ data }: { data: SeriesDetailView }) {
  return (
    <section className={cardClass} aria-label="History">
      <h3 className="text-base font-bold text-fg-strong">History</h3>
      <p className="text-xs text-fg-muted">
        Every change to this series, who made it and why. This record cannot be edited.
      </p>
      {data.history.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {data.history.map((h, i) => (
            <li key={`${h.at}-${i}`} className="text-xs">
              <p className="font-semibold text-fg-strong">
                {ACTION_LABEL[h.action] ?? h.action}{' '}
                <span className="font-normal text-fg-muted">
                  · {new Date(h.at).toLocaleString()} · {h.actor ?? 'system'}
                </span>
              </p>
              {h.reasonCode ? (
                <p className="text-fg-muted">
                  Reason: {h.reasonCode}
                  {h.reasonText ? ` — ${h.reasonText}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
