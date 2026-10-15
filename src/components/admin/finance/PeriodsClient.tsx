'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createFiscalYearAction, setPeriodStatusAction, type listFiscalAction } from '@/server/domains/finance/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { CALENDAR_SHAPES, pickOf } from '@/lib/gl-options';
import { PERIOD_MOVES, PERIOD_STATUS, nextYearStart, type PeriodStatus } from '@/lib/ledger-forms';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type Years = Extract<Awaited<ReturnType<typeof listFiscalAction>>, { ok: true }>['data'];

interface Props {
  yearsPromise: ReturnType<typeof listFiscalAction>;
  canEditPromise: Promise<boolean>;
  thisYear: number;
}

export function PeriodsClient({ yearsPromise, canEditPromise, thisYear }: Props) {
  const years = use(yearsPromise);
  const canEdit = use(canEditPromise);
  return years.ok ? <PeriodsView years={years.data} canEdit={canEdit} thisYear={thisYear} /> : <LoadFailed error={years.error} />;
}

function PeriodsView({ years, canEdit, thisYear }: { years: Years; canEdit: boolean; thisYear: number }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);
  const [start, setStart] = useState(nextYearStart(years.at(-1)?.endsOn ?? null, thisYear));
  const [shape, setShape] = useState<Choice | null>(pickOf(CALENDAR_SHAPES, 'monthly'));
  const [pending, setPending] = useState<{ id: string; to: PeriodStatus; label: string; name: string } | null>(null);
  const [reason, setReason] = useState('');

  const createYear = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(createFiscalYearAction(start, (shape?.id ?? 'monthly') as 'monthly'));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Fiscal year created.' });
    setAdding(false);
    router.refresh();
  };

  const move = async (id: string, to: PeriodStatus, why?: string) => {
    setBusy(true);
    const res = await attempt(setPeriodStatusAction(id, to, why));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
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
        <form onSubmit={(e) => void createYear(e)} className={`${cardClass} grid grid-cols-1 gap-4 sm:grid-cols-3`} aria-label="New fiscal year">
          <Field id={`${uid}-start`} label="Starts on">
            <input id={`${uid}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} className={fieldClass} required />
          </Field>
          <ChoicePicker label="Shape" source="fiscal-calendar-shapes" choice={shape} onChoice={setShape} clearable={false} required />
          <div className="flex items-end gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>Create</button>
            <button type="button" className={buttonClass} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {pending === null ? null : (
        <form onSubmit={(e) => { e.preventDefault(); void move(pending.id, pending.to, reason); }} className={`${cardClass} space-y-3`} aria-label={`${pending.label} ${pending.name}`}>
          <p className="text-sm font-semibold text-fg-strong">{pending.label}: {pending.name}</p>
          <Field id={`${uid}-why`} label="Reason" hint="Recorded with your name, the time and where you did this from.">
            <input id={`${uid}-why`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required autoFocus />
          </Field>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || reason.trim() === ''} className={primaryClass}>Confirm</button>
            <button type="button" className={buttonClass} onClick={() => { setPending(null); setReason(''); }}>Cancel</button>
          </div>
        </form>
      )}

      {years.length === 0 ? <p className="text-sm text-fg-muted">No fiscal year yet.</p> : null}
      {years.map((y) => (
        <section key={y.id} className="space-y-2" aria-labelledby={`${uid}-${y.id}`}>
          <h3 id={`${uid}-${y.id}`} className="text-sm font-bold text-fg-strong">{y.code} <span className="font-normal text-fg-muted">{y.startsOn} to {y.endsOn}</span></h3>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {y.periods.map((p) => (
              <li key={p.id} className="rounded-xl border border-line bg-surface-raised p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-fg-strong">{p.name}</p>
                    <p className="text-xs text-fg-muted">{p.startsOn} to {p.endsOn}</p>
                  </div>
                  <Chip tone={PERIOD_STATUS[p.status].tone}>{PERIOD_STATUS[p.status].label}</Chip>
                </div>
                {canEdit && PERIOD_MOVES[p.status].length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {PERIOD_MOVES[p.status].map((m) => (
                      <button key={m.to} type="button" className={buttonClass} disabled={busy} aria-label={`${m.label} ${p.name}`} onClick={() => (m.reason ? setPending({ id: p.id, to: m.to, label: m.label, name: p.name }) : void move(p.id, m.to))}>
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
