'use client';

import { use, useId, useState } from 'react';
import {
  confirmPaymentAction,
  failPaymentAction,
  paymentActivityAction,
  paymentEventsAction,
  paymentOperationsAction,
  paymentTransactionsAction,
  placePaymentAction,
  recheckPaymentAction,
  searchCustomersForPlacementAction,
  setAsidePaymentAction,
} from '@/server/domains/payments/activity-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { countTone, rowDetail, rowState, rowTitle, type ActivityRow, when, words } from '@/lib/payment-activity-format';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, dangerClass, fieldClass, money, primaryClass, type Notice, attempt } from '../finance/ui';

type Data = Extract<Awaited<ReturnType<typeof paymentActivityAction>>, { ok: true }>['data'];
type Tab = 'attention' | 'operations' | 'events' | 'money';
const TONE: Record<string, 'green' | 'amber' | 'red' | 'sky' | 'gray'> = { succeeded: 'green', consumed: 'green', verified: 'green', accepted: 'sky', awaiting_verification: 'sky', submitted: 'sky', queued: 'amber', claimed: 'amber', review: 'amber', unverified: 'amber', timed_out: 'amber', failed: 'red', in_doubt: 'red', mismatch: 'red', rejected: 'red', unmatched: 'red', ignored: 'gray', received: 'gray' };

type Row = ActivityRow;

export function PaymentActivityClient({ initialPromise }: { initialPromise: ReturnType<typeof paymentActivityAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ActivityView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ActivityView({ initial }: { initial: Data }) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<Tab>('attention');
  const [rows, setRows] = useState<Row[]>([]);
  const [filterChoice, setFilterChoice] = useState<Choice | null>(null);
  const filter = filterChoice?.id ?? '';
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [panel, setPanel] = useState<{ kind: 'confirm' | 'fail' | 'place' | 'aside'; id: string } | null>(null);
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; number: string }[]>([]);

  const reload = async () => {
    const r = await attempt(paymentActivityAction());
    if (r.ok) setData(r.data);
  };
  const show = async (t: Tab, state = filter) => {
    setTab(t);
    setBusy(true);
    const only = state === '' ? undefined : state;
    const loaders: Record<Tab, (() => Promise<{ ok: true; data: Row[] } | { ok: false; error: string }>) | null> = {
      attention: null,
      operations: () => attempt(paymentOperationsAction()),
      events: () => attempt(paymentEventsAction(only)),
      money: () => attempt(paymentTransactionsAction(only)),
    };
    const loader = loaders[t];
    const r = loader === null ? null : await loader();
    setBusy(false);
    if (r !== null && !r.ok) { setNotice({ kind: 'error', text: r.error }); return; }
    if (r?.ok === true) setRows(r.data);
    if (t === 'attention') await reload();
  };
  const done = async (text: string, call: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(call());
    setBusy(false);
    if (!r.ok) { setNotice({ kind: 'error', text: r.error }); return; }
    setNotice({ kind: 'ok', text });
    setPanel(null);
    setRef('');
    setReason('');
    await show(tab);
  };
  const search = async () => {
    const r = await attempt(searchCustomersForPlacementAction(q));
    if (r.ok) setFound(r.data);
  };
  const c = data.counts;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Payment activity" intro="Everything the payment platforms sent and everything we asked them, with whether it could be trusted and what was decided. A payment counts only after the platform itself confirms it." />
      <Message notice={notice} />
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Summary">
        {([['Waiting to be placed', c.tx_review, 'amber'], ['Received, not yet confirmed', c.tx_claimed, 'amber'], ['Callbacks needing a look', c.events_bad, 'red'], ['Requests failed or in doubt', c.ops_failed, 'red'], ['Counted', c.tx_consumed, 'green']] as const).map(([label, n, tone]) => (
          <div key={label} className={cardClass}><dt className="text-xs text-fg-muted">{label}</dt><dd className={`text-2xl font-bold tabular-nums ${countTone(n, tone)}`}>{n}</dd></div>
        ))}
      </dl>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {([['attention', 'Needs attention'], ['operations', 'Requests to platforms'], ['events', 'Callbacks received'], ['money', 'Money received']] as [Tab, string][]).map(([t, l]) => <button key={t} type="button" className={buttonClass} aria-pressed={tab === t} onClick={() => { setFilterChoice(null); void show(t, ''); }}>{l}</button>)}
      </div>

      {tab === 'attention' ? (
        <div className="space-y-6">
          <section aria-label="Payments waiting for a decision" className="space-y-2">
            <h2 className="text-sm font-bold text-fg-strong">Payments not yet confirmed ({data.doubtful.length})</h2>
            <p className="text-xs text-fg-muted">Started more than half an hour ago and still not confirmed or failed by the platform.</p>
            {data.doubtful.length === 0 ? <p className="text-sm text-fg-muted">None.</p> : (
              <ul className="space-y-2">
                {data.doubtful.map((a) => (
                  <li key={a.id} className={`${cardClass} space-y-2`}>
                    <p className="text-sm font-semibold text-fg-strong">Order {a.orderNumber} · {a.currency} {money(a.amount)} · {a.provider} <span className="font-normal text-fg-muted">· started {when(a.createdAt)}</span></p>
                    {a.error !== null && a.error !== '' ? <p className="text-xs text-red-700">{a.error}</p> : null}
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={buttonClass} disabled={busy} onClick={() => void done('Checking with the platform now.', () => recheckPaymentAction(a.id))}>Check again now</button>
                      {data.can.confirm ? <button type="button" className={buttonClass} aria-expanded={panel?.id === a.id && panel.kind === 'confirm'} onClick={() => setPanel({ kind: 'confirm', id: a.id })}>Confirm by hand…</button> : null}
                      {data.can.confirm ? <button type="button" className={dangerClass} aria-expanded={panel?.id === a.id && panel.kind === 'fail'} onClick={() => setPanel({ kind: 'fail', id: a.id })}>Close as not paid…</button> : null}
                    </div>
                    {panel?.id === a.id && panel.kind === 'confirm' ? (
                      <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void done('Confirmed and counted.', () => confirmPaymentAction(a.id, ref, reason)); }}>
                        <p className="text-xs text-fg-muted">Only if you have seen the payment on the platform yourself. This is kept with your name.</p>
                        <Field id={`${uid}-r${a.id}`} label="The platform's transaction number (M-Pesa receipt)"><input id={`${uid}-r${a.id}`} value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} className={fieldClass} required maxLength={40} autoComplete="off" /></Field>
                        <Field id={`${uid}-w${a.id}`} label="Why you are confirming it"><input id={`${uid}-w${a.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required minLength={10} maxLength={300} autoComplete="off" /></Field>
                        <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Confirm payment</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
                      </form>
                    ) : null}
                    {panel?.id === a.id && panel.kind === 'fail' ? (
                      <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void done('Closed as not paid.', () => failPaymentAction(a.id, reason)); }}>
                        <Field id={`${uid}-f${a.id}`} label="Why it is being closed"><input id={`${uid}-f${a.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required minLength={10} maxLength={300} autoComplete="off" /></Field>
                        <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy}>Close payment</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Confirmed payments to place" className="space-y-2">
            <h2 className="text-sm font-bold text-fg-strong">Confirmed payments waiting to be placed ({data.transactions.filter((t) => t.state === 'review').length})</h2>
            <p className="text-xs text-fg-muted">Safaricom confirmed these (paid straight to a paybill or till). Put each on the customer it belongs to.</p>
            <ul className="space-y-2">
              {data.transactions.filter((t) => t.state === 'review').map((t) => (
                <li key={t.id} className={`${cardClass} space-y-2`}>
                  <p className="text-sm font-semibold text-fg-strong">{t.reference} · KES {money(t.amount)} <span className="font-normal text-fg-muted">· to {t.shortcode} · account “{t.accountReference ?? ''}” · {t.payer ?? ''} · {when(t.at)}</span></p>
                  {data.can.resolve ? <div className="flex flex-wrap gap-2"><button type="button" className={primaryClass} aria-expanded={panel?.id === t.id && panel.kind === 'place'} onClick={() => { setPanel({ kind: 'place', id: t.id }); setFound([]); setQ(t.accountReference ?? ''); }}>Place on a customer…</button><button type="button" className={buttonClass} aria-expanded={panel?.id === t.id && panel.kind === 'aside'} onClick={() => setPanel({ kind: 'aside', id: t.id })}>Set aside…</button></div> : null}
                  {panel?.id === t.id && panel.kind === 'place' ? (
                    <div className="space-y-2 rounded-lg border border-line p-3">
                      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }} role="search">
                        <div className="min-w-48 flex-1"><Field id={`${uid}-c${t.id}`} label="Find the customer"><input id={`${uid}-c${t.id}`} value={q} onChange={(e) => setQ(e.target.value)} className={fieldClass} placeholder="Name, number or phone" autoComplete="off" /></Field></div>
                        <button type="submit" className={buttonClass}>Search</button>
                      </form>
                      <ul className="space-y-1">{found.map((cu) => <li key={cu.id}><button type="button" className={`${buttonClass} w-full justify-start text-left`} disabled={busy} onClick={() => void done(`Placed on ${cu.name}.`, () => placePaymentAction(t.id, cu.id))}>{cu.name} · {cu.number}</button></li>)}</ul>
                    </div>
                  ) : null}
                  {panel?.id === t.id && panel.kind === 'aside' ? (
                    <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void done('Set aside.', () => setAsidePaymentAction(t.id, reason)); }}>
                      <Field id={`${uid}-a${t.id}`} label="Why it is set aside"><input id={`${uid}-a${t.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} required minLength={10} maxLength={300} autoComplete="off" /></Field>
                      <div className="flex gap-2"><button type="submit" className={dangerClass} disabled={busy}>Set aside</button><button type="button" className={buttonClass} onClick={() => setPanel(null)}>Cancel</button></div>
                    </form>
                  ) : null}
                </li>
              ))}
              {data.transactions.filter((t) => t.state === 'review').length === 0 ? <li className="text-sm text-fg-muted">None.</li> : null}
            </ul>
          </section>

          <section aria-label="Received but not confirmed" className="space-y-2">
            <h2 className="text-sm font-bold text-fg-strong">Announced but not confirmed ({data.transactions.filter((t) => t.state === 'claimed' || t.state === 'rejected').length})</h2>
            <ul className="space-y-1 text-sm">
              {data.transactions.filter((t) => t.state === 'claimed' || t.state === 'rejected').map((t) => <li key={t.id} className={`${cardClass} flex flex-wrap justify-between gap-2`}><span><b>{t.reference}</b> · KES {money(t.amount)} · {when(t.at)}</span><span className="flex items-center gap-2"><Chip tone={TONE[t.state] ?? 'gray'}>{words(t.state)}</Chip><span className="max-w-md text-xs text-red-700">{t.failureReason}</span></span></li>)}
              {data.transactions.filter((t) => t.state === 'claimed' || t.state === 'rejected').length === 0 ? <li className="text-fg-muted">None.</li> : null}
            </ul>
          </section>

          <section aria-label="Callbacks that were refused or contradicted" className="space-y-2">
            <h2 className="text-sm font-bold text-fg-strong">Callbacks refused, contradicted or unmatched ({data.events.length})</h2>
            <ul className="space-y-1 text-sm">
              {data.events.map((e) => <li key={e.id} className={`${cardClass} flex flex-wrap justify-between gap-2`}><span><b>{words(e.kind)}</b> · {when(e.at)}{rowDetail({ ip: e.ip, reference: e.reference }, String)}</span><span className="flex items-center gap-2"><Chip tone={TONE[e.state] ?? 'gray'}>{words(e.state)}</Chip><span className="max-w-md text-xs text-red-700">{e.failureReason}</span></span></li>)}
              {data.events.length === 0 ? <li className="text-fg-muted">None.</li> : null}
            </ul>
          </section>

          <section aria-label="Requests that failed" className="space-y-2">
            <h2 className="text-sm font-bold text-fg-strong">Requests that failed or are in doubt ({data.operations.length})</h2>
            <ul className="space-y-1 text-sm">
              {data.operations.map((o) => <li key={o.id} className={`${cardClass} flex flex-wrap justify-between gap-2`}><span><b>{words(o.operation)}</b> · {when(o.at)}{rowDetail({ amount: o.amount }, money)}</span><span className="flex items-center gap-2"><Chip tone={TONE[o.status] ?? 'gray'}>{words(o.status)}</Chip><span className="max-w-md text-xs text-red-700">{o.failureReason}</span></span></li>)}
              {data.operations.length === 0 ? <li className="text-fg-muted">None.</li> : null}
            </ul>
          </section>
        </div>
      ) : (
        <section aria-label={tab} className="space-y-2">
          {tab !== 'operations' ? (
            <div className="max-w-xs">
              <ChoicePicker key={tab} label="Show only" source={tab === 'events' ? 'payment-event-states' : 'payment-transaction-states'} choice={filterChoice} onChoice={(c) => { setFilterChoice(c); void show(tab, c?.id ?? ''); }} placeholder="Everything" />
            </div>
          ) : null}
          {busy ? <p className="text-sm text-fg-muted">Loading…</p> : null}
          {!busy && rows.length === 0 ? <p className="text-sm text-fg-muted">Nothing to show.</p> : null}
          {!busy && rows.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {rows.map((r) => (
                <li key={String(r.id)} className={`${cardClass} flex flex-wrap items-start justify-between gap-2`}>
                  <span className="min-w-0">
                    <b>{rowTitle(r)}</b> · {when(typeof r.at === 'string' ? r.at : null)}
                    {rowDetail(r, money)}
                  </span>
                  <span className="flex flex-wrap items-center gap-2"><Chip tone={TONE[rowState(r)] ?? 'gray'}>{words(rowState(r))}</Chip>{typeof r.failureReason === 'string' && r.failureReason !== '' ? <span className="max-w-md text-xs text-red-700">{r.failureReason}</span> : null}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </div>
  );
}
