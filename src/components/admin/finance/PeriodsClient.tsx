'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createFiscalYearAction,
  setPeriodStatusAction,
  type FiscalYearView,
} from '@/server/domains/finance/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type Status = 'open' | 'soft_closed' | 'closed' | 'locked';

const STATUS: Record<Status, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  open: { label: 'Open', tone: 'green' },
  soft_closed: { label: 'Soft-closed', tone: 'amber' },
  closed: { label: 'Closed', tone: 'red' },
  locked: { label: 'Locked', tone: 'gray' },
};

const SHAPES = [
  ['monthly', '12 calendar months'],
  ['weeks_445', '12 periods, 4-4-5 weeks'],
  ['weeks_454', '12 periods, 4-5-4 weeks'],
  ['weeks_544', '12 periods, 5-4-4 weeks'],
  ['weeks_13x4', '13 periods of 4 weeks'],
] as const;

/** The moves offered from each status (the server decides who may make them). */
const MOVES: Record<Status, { to: Status; label: string; reason: boolean }[]> = {
  open: [{ to: 'soft_closed', label: 'Soft-close', reason: false }, { to: 'closed', label: 'Close', reason: false }],
  soft_closed: [{ to: 'closed', label: 'Close', reason: false }, { to: 'open', label: 'Reopen', reason: true }],
  closed: [{ to: 'open', label: 'Reopen', reason: true }, { to: 'locked', label: 'Lock for good', reason: true }],
  locked: [],
};

export function PeriodsClient({ years, canEdit }: { years: FiscalYearView[]; canEdit: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [start, setStart] = useState(() => {
    const last = years[years.length - 1];
    return last ? `${Number(last.endsOn.slice(0, 4)) + (last.endsOn.slice(5) === '12-31' ? 1 : 0)}-${last.endsOn.slice(5) === '12-31' ? '01-01' : last.endsOn.slice(5)}` : `${new Date().getUTCFullYear()}-01-01`;
  });
  const [shape, setShape] = useState<(typeof SHAPES)[number][0]>('monthly');
  const [pending, setPending] = useState<{ id: string; to: Status; label: string; name: string } | null>(null);
  const [reason, setReason] = useState('');

  const createYear = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(createFiscalYearAction(start, shape));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: 'Fiscal year created.' });
    setAdding(false);
    router.refresh();
  };

  const move = async (id: string, to: Status, why?: string) => {
    setBusy(true);
    const res = await attempt(setPeriodStatusAction(id, to, why));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: 'Period updated.' });
    setPending(null);
    setReason('');
    router.refresh();
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Fiscal years and periods"
        intro="Postings are accepted only into an open period. Soft-closing keeps a period open to people with special permission; closing stops everyone; locking is permanent and meant for year-end."
        actions={canEdit ? <button type="button" className={primaryClass} onClick={() => setAdding((v) => !v)} aria-expanded={adding}>New fiscal year</button> : null}
      />
      <Message notice={notice} />

      {adding ? (
        <form onSubmit={createYear} className={`${cardClass} grid grid-cols-1 gap-4 sm:grid-cols-3`} aria-label="New fiscal year">
          <Field id={`${uid}-start`} label="Starts on">
            <input id={`${uid}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} className={fieldClass} required />
          </Field>
          <Field id={`${uid}-shape`} label="Shape">
            <select id={`${uid}-shape`} value={shape} onChange={(e) => setShape(e.target.value as typeof shape)} className={fieldClass}>
              {SHAPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>Create</button>
            <button type="button" className={buttonClass} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {pending ? (
        <form
          onSubmit={(e) => { e.preventDefault(); void move(pending.id, pending.to, reason); }}
          className={`${cardClass} space-y-3`}
          aria-label={`${pending.label} ${pending.name}`}
        >
          <p className="text-sm font-semibold text-fg-strong">{pending.label}: {pending.name}</p>
          <Field id={`${uid}-why`} label="Reason" hint="Recorded with your name, the time and where you did this from.">
            <input id={`${uid}-why`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required autoFocus />
          </Field>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || reason.trim() === ''} className={primaryClass}>Confirm</button>
            <button type="button" className={buttonClass} onClick={() => { setPending(null); setReason(''); }}>Cancel</button>
          </div>
        </form>
      ) : null}

      {years.length === 0 ? <p className="text-sm text-fg-muted">No fiscal year yet.</p> : null}
      {years.map((y) => (
        <section key={y.id} className="space-y-2" aria-labelledby={`${uid}-${y.id}`}>
          <h3 id={`${uid}-${y.id}`} className="text-sm font-bold text-fg-strong">
            {y.code} <span className="font-normal text-fg-muted">{y.startsOn} to {y.endsOn}</span>
          </h3>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {y.periods.map((p) => (
              <li key={p.id} className="rounded-xl border border-line bg-surface-raised p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-fg-strong">{p.name}</p>
                    <p className="text-xs text-fg-muted">{p.startsOn} to {p.endsOn}</p>
                  </div>
                  <Chip tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Chip>
                </div>
                {canEdit && MOVES[p.status].length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {MOVES[p.status].map((m) => (
                      <button
                        key={m.to}
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        aria-label={`${m.label} ${p.name}`}
                        onClick={() => (m.reason ? setPending({ id: p.id, to: m.to, label: m.label, name: p.name }) : void move(p.id, m.to))}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
