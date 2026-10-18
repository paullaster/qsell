'use client';

import { use, useId, useState } from 'react';
import { has } from '@/lib/values';
import { useRouter } from 'next/navigation';
import { listExchangeRatesAction, removeExchangeRateAction, revalueForeignBalancesAction, setExchangeRateAction, type exchangeRatesOverviewAction } from '@/server/domains/finance/fx-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { netWords, rateFormProblem, rateWords } from '@/lib/exchange-rate-form';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, today, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof exchangeRatesOverviewAction>>, { ok: true }>['data'];
type RatePage = Extract<Awaited<ReturnType<typeof listExchangeRatesAction>>, { ok: true }>['data'];

export function ExchangeRatesClient({ viewPromise }: { viewPromise: ReturnType<typeof exchangeRatesOverviewAction> }) {
  const res = use(viewPromise);
  return res.ok ? <ExchangeRatesView view={res.data} /> : <LoadFailed error={res.error} />;
}

function ExchangeRatesView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const day = today();
  const [currency, setCurrency] = useState<Choice | null>(null);
  const [effectiveOn, setEffectiveOn] = useState(day);
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [filter, setFilter] = useState<Choice | null>(null);
  const [page, setPage] = useState<RatePage | null>(null);
  const [rows, setRows] = useState<RatePage['rows']>([]);
  const [confirmRevalue, setConfirmRevalue] = useState(false);

  const load = async (more: boolean) => {
    setBusy(true);
    const res = await attempt(listExchangeRatesAction({ currency: filter?.id, before: more ? (page?.nextBefore ?? undefined) : undefined }));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setPage(res.data);
    setRows(more ? [...rows, ...res.data.rows] : res.data.rows);
  };
  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const problem = rateFormProblem({ currency: currency?.id ?? '', effectiveOn, rate }, day);
    if (problem !== null) { setNotice({ kind: 'error', text: problem }); return; }
    setBusy(true);
    setNotice(null);
    const res = await attempt(setExchangeRateAction({ currency: currency?.id ?? '', effectiveOn, rate: rate.trim(), note }));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: `Rate saved: ${rateWords(currency?.id ?? '', Number(rate).toFixed(8), view.baseCurrency)} from ${effectiveOn}.` });
    setRate('');
    setNote('');
    router.refresh();
    if (page !== null) void load(false);
  };
  const remove = async (id: string) => {
    setBusy(true);
    const res = await attempt(removeExchangeRateAction(id));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: 'Rate removed.' });
    setRows(rows.filter((r) => r.id !== id));
    router.refresh();
  };
  const revalue = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(revalueForeignBalancesAction());
    setBusy(false);
    setConfirmRevalue(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: `Balances revalued (${netWords(res.data.net).toLowerCase()}). It will be undone tomorrow, so only real differences stay.` });
    router.refresh();
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Exchange rates"
        intro={`Sales, payments and credit notes in a foreign currency are booked in ${view.baseCurrency} at the rate of the day they happen. Set the rate each morning (or ahead of time); a day that has passed cannot be changed, because documents of that day have been valued by it. When a customer pays at a different rate from the invoice, the difference is booked as an exchange gain or loss.`}
      />
      <Message notice={notice} />

      <section className={`${cardClass} space-y-2`} aria-labelledby={`${uid}-now`}>
        <h3 id={`${uid}-now`} className="text-sm font-bold text-fg-strong">In force today</h3>
        {view.latest.length === 0 ? <p className="text-sm text-fg-muted">No rate has been set yet. Foreign-currency sales cannot be posted until there is one.</p> : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {view.latest.map((r) => (
              <li key={r.currency} className="rounded-xl border border-line p-3 text-sm">
                <p className="font-bold tabular-nums text-fg-strong">{rateWords(r.currency, r.rate, view.baseCurrency)}</p>
                <p className="text-xs text-fg-muted">since {r.effectiveOn}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.can.manage ? (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-3`} aria-label="Set a rate">
          <h3 className="text-sm font-bold text-fg-strong">Set a rate</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <ChoicePicker label="Currency" source="fx-currencies" choice={currency} onChoice={setCurrency} clearable={false} required />
            <Field id={`${uid}-d`} label="Starts on"><input id={`${uid}-d`} type="date" min={day} value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} className={fieldClass} required /></Field>
            <Field id={`${uid}-r`} label={`${view.baseCurrency} for one unit`}><input id={`${uid}-r`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className={`${fieldClass} tabular-nums`} placeholder="129.50" autoComplete="off" required /></Field>
          </div>
          <Field id={`${uid}-n`} label="Note (where the rate came from)"><input id={`${uid}-n`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={fieldClass} autoComplete="off" /></Field>
          <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save rate'}</button>
        </form>
      ) : null}

      {view.live && view.can.revalue ? (
        <section className={`${cardClass} space-y-2`} aria-label="Revalue balances">
          <h3 className="text-sm font-bold text-fg-strong">Revalue what customers owe in foreign currency</h3>
          <p className="text-sm text-fg-muted">Brings the receivables in the books to today&apos;s rate, with the difference as an exchange gain or loss. The next day it is undone, so month-end reports show the revalued figure and only real differences, when customers pay, stay. Once a day.</p>
          {confirmRevalue ? (
            <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label="Confirm revaluation">
              <button type="button" className={primaryClass} disabled={busy} onClick={() => void revalue()}>{busy ? 'Working…' : 'Revalue now'}</button>
              <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmRevalue(false)}>Not now</button>
            </span>
          ) : <button type="button" className={buttonClass} onClick={() => setConfirmRevalue(true)}>Revalue balances…</button>}
        </section>
      ) : null}

      {view.revaluations.length > 0 ? (
        <section className={`${cardClass} space-y-2`} aria-label="Revaluations">
          <h3 className="text-sm font-bold text-fg-strong">Recent revaluations</h3>
          <ul className="divide-y divide-line text-sm">
            {view.revaluations.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="break-words">{r.asOf} · {Object.entries(r.rates).map(([c, v]) => `${c} ${v}`).join(', ')}</span>
                <span className="flex items-center gap-2"><span className="tabular-nums">{netWords(r.net)}</span><Chip tone={r.undone ? 'gray' : 'amber'}>{r.undone ? 'Undone' : 'Standing'}</Chip></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={`${cardClass} space-y-3`} aria-label="Rate history">
        <h3 className="text-sm font-bold text-fg-strong">Rate history</h3>
        <form className="flex flex-wrap items-end gap-2" role="search" onSubmit={(e) => { e.preventDefault(); void load(false); }}>
          <div className="min-w-48"><ChoicePicker label="Currency" source="fx-currencies" choice={filter} onChoice={setFilter} placeholder="All" /></div>
          <button type="submit" className={buttonClass} disabled={busy}>Show</button>
        </form>
        {page === null ? <p className="text-sm text-fg-muted">Choose Show to list the rates.</p> : null}
        {page !== null && rows.length === 0 ? <p className="text-sm text-fg-muted">No rates yet.</p> : null}
        {page !== null && rows.length > 0 ? (
          <ul className="divide-y divide-line text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-words"><span className="font-semibold tabular-nums text-fg-strong">{r.effectiveOn}</span> · {rateWords(r.currency, r.rate, view.baseCurrency)}{r.note === null ? '' : <span className="text-fg-muted"> · {r.note}</span>}</span>
                {view.can.manage && r.effectiveOn >= day ? <InlineConfirm label={`Remove the ${r.currency} rate of ${r.effectiveOn}`} action="Remove" confirm="Remove it" busy={busy} onConfirm={() => void remove(r.id)} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {has(page?.nextBefore) ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(true)}>Show more</button> : null}
      </section>
    </div>
  );
}
