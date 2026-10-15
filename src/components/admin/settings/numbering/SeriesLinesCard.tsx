'use client';

import { useId, useMemo, useState } from 'react';
import { addNumberSeriesLineAction, setNumberSeriesLineOpenAction, updateNumberSeriesLineAction, type LineView, type SeriesDetailView } from '@/server/kernel/numbering/actions';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { TEMPLATE_TOKENS, validateTemplate } from '@/server/kernel/numbering/domain/template';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, buttonClass, cardClass, Chip, primaryClass } from '@/components/ui/screen-kit';
import { exampleNumber, lineFormFrom, lineValues, RESET_CHOICES, resetLabel, withToken, type LineFormState } from '@/lib/number-series-forms';
import type { Choice } from '@/lib/payment-options';
import { has } from '@/lib/values';
import { submitWords } from '@/lib/form-words';
import type { Report } from './NumberSeriesDetailClient';
import { ReasonField, reasonReady, type ReasonValue } from './ReasonField';

const noReason: ReasonValue = { code: '', text: '' };
const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none disabled:opacity-60';

export function SeriesLinesCard({ data, report }: { data: SeriesDetailView; report: Report }) {
  const [editing, setEditing] = useState<LineView | 'new' | null>(null);
  const [closing, setClosing] = useState<LineView | null>(null);
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);
  const today = businessDate();

  const toggle = async (line: LineView) => {
    setBusy(true);
    const res = await attempt(setNumberSeriesLineOpenAction(line.id, !line.isOpen, reason));
    if (await report(res, line.isOpen ? `Line ${String(line.lineNo)} closed.` : `Line ${String(line.lineNo)} reopened.`)) {
      setClosing(null);
      setReason(noReason);
    }
    setBusy(false);
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Numbering lines">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-fg-strong">Lines</h3>
          <p className="text-xs text-fg-muted">Each line is a range with a pattern. The most specific open line for the document’s date and branch is used.</p>
        </div>
        <button type="button" className={buttonClass} onClick={() => setEditing('new')}>
          Add line
        </button>
      </div>

      {editing === null ? null : (
        <LineEditor
          key={editing === 'new' ? 'new' : editing.id}
          seriesId={data.series.id}
          mode={data.series.mode}
          line={editing === 'new' ? null : editing}
          onDone={(ok) => {
            if (ok) setEditing(null);
          }}
          report={report}
        />
      )}

      {data.lines.length === 0 ? (
        <p className="text-sm text-amber-700">This series has no lines, so it cannot number anything yet. Add one.</p>
      ) : (
        <ul className="divide-y divide-line/60" aria-label="Lines">
          {data.lines.map((l) => (
            <li key={l.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-strong">
                  Line {l.lineNo} · {has(l.branchCode) ? `Branch ${l.branchCode}` : 'All branches'}
                  <Chip tone={l.isOpen ? 'green' : 'gray'}>{l.isOpen ? 'Open' : 'Closed'}</Chip>
                  {l.used ? <Chip tone="gray">In use</Chip> : null}
                </p>
                <span className="flex gap-2">
                  <button type="button" className={buttonClass} onClick={() => setEditing(l)} aria-label={`Edit line ${String(l.lineNo)}`}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`${l.isOpen ? 'Close' : 'Reopen'} line ${String(l.lineNo)}`}
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
                  <dd className="font-mono text-fg-strong">{exampleNumber(l, l.startNo, l.startsOn, l.branchCode, today) ?? '—'}</dd>
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
                    {l.startNo.toLocaleString()} – {l.endNo === null ? 'open' : l.endNo.toLocaleString()} (step {l.increment}){l.warnAt === null ? '' : ` · warns at ${l.warnAt.toLocaleString()}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Restarts · last issued</dt>
                  <dd className="text-fg-strong">
                    {resetLabel(l.reset)} · {l.lastNo === null ? 'none yet' : `${l.lastNo.toLocaleString()}${has(l.lastPeriod) ? ` (${l.lastPeriod})` : ''}`}
                  </dd>
                </div>
              </dl>
              {closing?.id === l.id ? (
                <div className="space-y-3 rounded-lg bg-surface-sunken/60 p-3">
                  <ReasonField value={reason} onChange={setReason} />
                  <button type="button" className={primaryClass} disabled={busy || !reasonReady(reason)} onClick={() => void toggle(l)}>
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

interface EditorProps {
  seriesId: string;
  mode: 'gap_free' | 'allow_gaps';
  line: LineView | null;
  onDone: (ok: boolean) => void;
  report: Report;
}

function LineEditor({ seriesId, mode, line, onDone, report }: EditorProps) {
  const uid = useId();
  const today = businessDate();
  const frozen = line?.used === true;
  const [f, setF] = useState<LineFormState>(() => lineFormFrom(line, today));
  const [branch, setBranch] = useState<Choice | null>(line?.branchId == null ? null : { id: line.branchId, label: line.branchLabel ?? line.branchCode ?? line.branchId });
  const [reset, setReset] = useState<Choice | null>({ id: f.reset, label: resetLabel(f.reset) });
  const [reason, setReason] = useState(noReason);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});

  const branchCode = branch?.meta?.code ?? line?.branchCode ?? null;
  const prefixProblem = validateTemplate(f.prefix);
  const suffixProblem = validateTemplate(f.suffix);
  const preview = useMemo(
    () => exampleNumber({ prefix: f.prefix, suffix: f.suffix, digits: Number(f.digits) }, Number(f.startNo), f.startsOn, branchCode, today),
    [f.prefix, f.suffix, f.digits, f.startNo, f.startsOn, branchCode, today],
  );

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssues({});
    const chosenReset = RESET_CHOICES.find((c) => c.id === reset?.id)?.id ?? f.reset;
    const values = lineValues({ ...f, branchId: branch?.id ?? '', reset: chosenReset });
    const res = line === null ? await attempt(addNumberSeriesLineAction(seriesId, values)) : await attempt(updateNumberSeriesLineAction(line.id, values, reason));
    if (!res.ok && 'issues' in res && Array.isArray(res.issues)) setIssues(Object.fromEntries((res.issues as { field: string; message: string }[]).map((i) => [i.field, i.message])));
    const ok = await report(res, line === null ? 'Line added.' : 'Line saved.');
    setBusy(false);
    onDone(ok);
  };

  const input = (key: keyof LineFormState, label: string, opts: { type?: string; disabled?: boolean; hint?: string; mono?: boolean } = {}) => {
    const problem = issues[key];
    return (
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
          className={`${fieldClass} ${opts.mono === true ? 'font-mono' : ''}`}
          aria-invalid={has(problem) ? true : undefined}
        />
        {has(problem) ? (
          <p role="alert" className="mt-1 text-[11px] text-red-700">
            {problem}
          </p>
        ) : null}
        {!has(problem) && has(opts.hint) ? <p className="mt-1 text-[11px] text-fg-muted">{opts.hint}</p> : null}
      </div>
    );
  };

  const templateProblem = prefixProblem ?? suffixProblem;
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4 rounded-lg border border-line bg-surface p-4" aria-label={line === null ? 'Add line' : `Edit line ${String(line.lineNo)}`}>
      <h4 className="text-sm font-bold text-fg-strong">{line === null ? 'Add a line' : `Edit line ${String(line.lineNo)}`}</h4>
      {frozen ? <p className="text-xs text-amber-700">This line has issued numbers, so its pattern, start number, step and restart cannot change. To change them, close it and add a new line.</p> : null}

      <div className="rounded-lg bg-surface-sunken/60 p-3">
        <p className="text-xs text-fg-muted">The first number will look like</p>
        <p className="font-mono text-lg font-bold text-fg-strong" aria-live="polite">
          {preview ?? '—'}
        </p>
        {has(templateProblem) ? (
          <p role="alert" className="text-xs text-red-700">
            {templateProblem}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ChoicePicker label="Applies to" source="numbering-branches" choice={branch} onChoice={setBranch} placeholder="All branches" disabled={frozen} />
        <ChoicePicker label="Restart numbering" source="number-reset-modes" choice={reset} onChoice={(c) => setReset(c ?? reset)} clearable={false} disabled={frozen} />
        {input('prefix', 'Prefix', { disabled: frozen, mono: true, hint: 'e.g. INV-{YY}-' })}
        {input('suffix', 'Suffix', { disabled: frozen, mono: true })}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2" role="group" aria-label="Insert a token">
          <span className="text-xs text-fg-muted">Insert into the prefix:</span>
          {TEMPLATE_TOKENS.map((t) => (
            <button key={t} type="button" disabled={frozen} className={`${buttonClass} font-mono`} onClick={() => setF((p) => ({ ...p, prefix: withToken(p.prefix, t) }))}>{`{${t}}`}</button>
          ))}
        </div>
        {input('digits', 'Digits', { type: 'number', disabled: frozen, hint: 'Numbers are padded with zeros to this length (1–15).' })}
        {input('startNo', 'Starting number', { type: 'number', disabled: frozen })}
        {input('endNo', 'Ending number', { type: 'number', hint: 'Leave empty for no limit (up to the digits).' })}
        {input('increment', 'Step', { type: 'number', disabled: frozen })}
        {input('warnAt', 'Warn at number', { type: 'number', hint: 'A warning is raised when this number is reached.' })}
        {input('startsOn', 'Starts on', { type: 'date' })}
        {input('endsOn', 'Ends on', { type: 'date', hint: 'Leave empty for no end date.' })}
      </div>
      {mode === 'allow_gaps' ? <p className="text-xs text-fg-muted">This series hands out numbers in blocks, so a restart can leave gaps.</p> : null}
      {line === null ? null : <ReasonField value={reason} onChange={setReason} />}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || (line !== null && !reasonReady(reason)) || has(templateProblem)} className={primaryClass}>
          {submitWords(busy, line === null ? null : line.id, 'Add line', 'Save line')}
        </button>
        <button type="button" className={buttonClass} onClick={() => onDone(true)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
