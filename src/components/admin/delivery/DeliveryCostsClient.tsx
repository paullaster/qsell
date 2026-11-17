'use client';

import { use, useEffect, useId, useState } from 'react';
import { costBooksAction, costsPageAction, payRiderAction, recordRunningCostAction, payoutsPageAction, postCostsNowAction, reverseCostAction, setCostAccountsAction, setPayRulesAction, type payRulesAction } from '@/server/domains/delivery/cost-actions';
import type { CostView } from '@/server/domains/delivery/costs';
import type { OwedView, PayoutView } from '@/server/domains/delivery/cost-books';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import type { Choice } from '@/lib/payment-options';

type Loaded = Awaited<ReturnType<typeof payRulesAction>>;
type Rules = Extract<Loaded, { ok: true }>['data'];

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });

export function DeliveryCostsClient({ rulesPromise }: { rulesPromise: ReturnType<typeof payRulesAction> }) {
  const res: Loaded = use(rulesPromise);
  return res.ok ? <Screen initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Screen({ initial }: { initial: Rules }) {
  const [rules, setRules] = useState(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [kind, setKind] = useState<Choice | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = usePagedList<CostView, { kind: string; from: string; to: string }>({
    load: async (filters, cursor) => {
      const result = await costsPageAction({ kind: filters.kind, from: filters.from, to: filters.to, cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: { kind: kind?.id ?? '', from, to },
  });
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery costs" intro="What riders earn, what couriers charge, and what delivery has cost. Every cost is kept: a mistake is taken back with a reason, never edited." />
      <Message notice={notice} />
      <PayRulesPanel
        rules={rules}
        onSaved={(r) => {
          setRules(r);
          setNotice({ kind: 'ok', text: 'Saved. Riders earn this from now on; pay already earned does not change.' });
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />
      <RunningCostPanel
        onSaved={(text) => {
          setNotice({ kind: 'ok', text });
          list.reload();
        }}
        onError={(text) => setNotice({ kind: 'error', text })}
      />
      <BooksPanel onNotice={setNotice} onChanged={() => list.reload()} />
      <section aria-label="Costs" className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ChoicePicker label="Kind of cost" source="delivery-cost-kinds" choice={kind} onChoice={setKind} placeholder="All kinds" clearable />
          <Field id="costs-from" label="From day">
            <input id="costs-from" type="date" className={fieldClass} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="costs-to" label="To day">
            <input id="costs-to" type="date" className={fieldClass} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {list.phase === 'error' ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {list.error}{' '}
            <button type="button" className={buttonClass} onClick={list.retry}>
              Try again
            </button>
          </p>
        ) : null}
        {list.phase === 'loading' ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        ) : null}
        {list.phase !== 'loading' && list.phase !== 'error' && list.rows.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-8 text-center text-sm text-fg-muted">
            No cost matches. Rider pay is counted as deliveries are made; a courier&apos;s charge is typed in on the delivery.
          </p>
        ) : null}
        <ul className="space-y-2" aria-label="Cost list">
          {list.rows.map((c) => (
            <CostRow key={c.id} cost={c} onDone={(text) => { setNotice({ kind: 'ok', text }); list.reload(); }} onError={(text) => setNotice({ kind: 'error', text })} />
          ))}
        </ul>
        {list.cursor !== null ? (
          <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
            {list.phase === 'more' ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function PayRulesPanel({ rules, onSaved, onError }: { rules: Rules; onSaved: (r: Rules) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [perDelivery, setPerDelivery] = useState(rules.perDelivery);
  const [perDay, setPerDay] = useState(rules.perDay);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await attempt(setPayRulesAction({ perDelivery: Number(perDelivery), perDay: Number(perDay), expectedVersion: rules.version }));
    setBusy(false);
    if (r.ok) onSaved(r.data);
    else onError(r.error);
  };
  return (
    <section aria-label="Rider pay" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">What riders are paid</h3>
      <p className="text-xs text-fg-muted">A rider earns the first amount for each delivery they make, and the second for each day they work a run on which something was delivered (once a day, however many runs). Either can be nothing. A delivery that could not be made earns nothing.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id={`${uid}-d`} label="For each delivery (KSh)">
          <input id={`${uid}-d`} className={fieldClass} inputMode="decimal" value={perDelivery} onChange={(e) => setPerDelivery(e.target.value)} autoComplete="off" />
        </Field>
        <Field id={`${uid}-y`} label="For each day on a run (KSh)">
          <input id={`${uid}-y`} className={fieldClass} inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <button type="button" className={primaryClass} disabled={busy || Number.isNaN(Number(perDelivery)) || Number.isNaN(Number(perDay)) || perDelivery.trim() === '' || perDay.trim() === ''} onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}

/** Fuel, a vehicle cost or another cost of running the fleet. The form is remounted after a save, so the next cost starts empty with a new key. */
function RunningCostPanel({ onSaved, onError }: { onSaved: (text: string) => void; onError: (text: string) => void }) {
  const [fresh, setFresh] = useState(0);
  return (
    <RunningCostForm
      key={fresh}
      onSaved={(text) => {
        setFresh((n) => n + 1);
        onSaved(text);
      }}
      onError={onError}
    />
  );
}

function RunningCostForm({ onSaved, onError }: { onSaved: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [clientKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<Choice | null>(null);
  const [run, setRun] = useState<Choice | null>(null);
  const [vehicle, setVehicle] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [litres, setLitres] = useState('');
  const [km, setKm] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const isFuel = kind?.id === 'fuel';
  const save = async () => {
    setBusy(true);
    const r = await attempt(recordRunningCostAction({ kind: kind?.id, runId: run?.id, vehicleId: vehicle?.id, amount: Number(amount), litres: isFuel && litres.trim() !== '' ? Number(litres) : undefined, km: isFuel && km.trim() !== '' ? Number(km) : undefined, note, clientKey }));
    setBusy(false);
    if (r.ok) onSaved(r.data.replayed ? 'That cost was already saved.' : 'Saved. It counts against delivery in the report.');
    else onError(r.error);
  };
  const ready = kind !== null && amount.trim() !== '' && !Number.isNaN(Number(amount)) && note.trim().length >= 3 && (!isFuel || (!Number.isNaN(Number(litres)) && !Number.isNaN(Number(km))));
  return (
    <form
      aria-label="Record a running cost"
      className={`${cardClass} space-y-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-bold text-fg-strong">Fuel and vehicle costs</h3>
      <p className="text-xs text-fg-muted">What it cost to keep the fleet on the road. It counts against delivery in the report and the margin. For fuel you can add the litres and the kilometres driven on them; the report then shows kilometres to the litre and the fuel cost of a kilometre for each vehicle. It is not booked here: record the receipt as an expense or a supplier invoice as usual, so it is not counted twice in the books.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoicePicker label="What kind of cost" source="delivery-running-cost-kinds" choice={kind} onChoice={setKind} placeholder="Fuel, a vehicle cost or another cost" />
        <Field id={`${uid}-a`} label="How much (KSh)">
          <input id={`${uid}-a`} className={fieldClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
        </Field>
        {isFuel ? (
          <>
            <Field id={`${uid}-l`} label="Litres bought (optional)">
              <input id={`${uid}-l`} className={fieldClass} inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} autoComplete="off" />
            </Field>
            <Field id={`${uid}-k`} label="Kilometres driven on them (optional)">
              <input id={`${uid}-k`} className={fieldClass} inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} autoComplete="off" />
            </Field>
          </>
        ) : null}
        <ChoicePicker label="Vehicle it was for (optional)" source="delivery-vehicles-all" choice={vehicle} onChoice={setVehicle} placeholder="Choose a vehicle, or leave empty" clearable />
        <ChoicePicker label="Run it was for (optional)" source="delivery-runs-any" choice={run} onChoice={setRun} placeholder="Choose a run, or leave empty" clearable />
        <Field id={`${uid}-n`} label="What it was for">
          <input id={`${uid}-n`} className={fieldClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoComplete="off" placeholder="For example: KDA 123X, Thika road run" />
        </Field>
      </div>
      <button type="submit" className={primaryClass} disabled={busy || !ready}>
        {busy ? 'Saving…' : 'Save the cost'}
      </button>
    </form>
  );
}

function CostRow({ cost, onDone, onError }: { cost: CostView; onDone: (text: string) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const negative = Number(cost.amount) < 0;
  return (
    <li className="space-y-2 rounded-xl border border-line bg-surface-raised p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-semibold text-fg-strong">
          {cost.kindWords}
          {cost.deliveryNumber === null ? '' : ` · ${cost.deliveryNumber}`}
          {cost.runNumber === null ? '' : ` · run ${cost.runNumber}`}
          {cost.riderName === null ? '' : ` · ${cost.riderName}`}
          {cost.vehicleName === null ? '' : ` · ${cost.vehicleName}`}
          {cost.courierName === null ? '' : ` · ${cost.courierName}`}
        </span>
        <span className={`font-mono font-semibold ${negative ? 'text-red-700 dark:text-red-300' : 'text-fg-strong'}`}>
          {cost.currency} {cost.amount}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        {when(cost.createdAt)}
        {cost.litres === null && cost.km === null ? null : <span>· {[cost.litres === null ? null : `${cost.litres} litres`, cost.km === null ? null : `${cost.km} km`].filter((p): p is string => p !== null).join(', ')}</span>}
        {cost.note === null ? null : <span>· {cost.note}</span>}
        {negative ? <Chip tone="gray">Taken back</Chip> : null}
        {cost.reversed ? <Chip tone="gray">Was taken back</Chip> : null}
      </p>
      {!negative && !cost.reversed ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${uid}-r`} label="Why it is being taken back">
            <input id={`${uid}-r`} className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
          </Field>
          <InlineConfirm
            label={`Take back the ${cost.kindWords.toLowerCase()} of ${cost.amount}`}
            action="Take it back"
            confirm="Yes, take it back"
            busy={busy}
            onConfirm={() => {
              void (async () => {
                setBusy(true);
                const r = await attempt(reverseCostAction({ costId: cost.id, reason }));
                setBusy(false);
                if (r.ok) onDone('The cost is taken back.');
                else onError(r.error);
              })();
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

type Books = Extract<Awaited<ReturnType<typeof costBooksAction>>, { ok: true }>['data'];

/** Where rider pay is booked, what each rider is owed, paying them, and what has been paid. */
function BooksPanel({ onNotice, onChanged }: { onNotice: (n: Notice) => void; onChanged: () => void }) {
  const [books, setBooks] = useState<Books | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = (): void => {
    void attempt(costBooksAction()).then((r) => {
      if (r.ok) setBooks(r.data);
      else setLoadError(r.error);
    });
  };
  useEffect(load, []);
  const payouts = usePagedList<PayoutView, Record<string, never>>({
    load: async (_f, cursor) => {
      const result = await payoutsPageAction({ cursor });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: { rows: result.data.rows, nextCursor: result.data.nextCursor } };
    },
    filters: {},
  });
  if (loadError !== null) return <p role="alert" className="text-sm text-red-700 dark:text-red-300">{loadError}</p>;
  if (books === null) {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading…
      </p>
    );
  }
  return (
    <>
      <AccountsPanel books={books} onSaved={(accounts) => { setBooks({ ...books, accounts }); onNotice({ kind: 'ok', text: 'Saved. Rider pay is booked to these accounts from now on.' }); }} onNotice={onNotice} onPosted={() => { load(); onChanged(); }} />
      <section aria-label="Owed to riders" className={`${cardClass} space-y-3`}>
        <h3 className="text-sm font-bold text-fg-strong">Owed to riders</h3>
        {books.owed.length === 0 ? (
          <p role="status" className="text-sm text-fg-muted">
            Nothing is owed to any rider.
          </p>
        ) : null}
        <ul className="space-y-3" aria-label="Riders and what they are owed">
          {books.owed.map((o) => (
            <PayRow
              key={o.riderId}
              owed={o}
              onPaid={(view) => {
                onNotice({ kind: 'ok', text: `${view.number}: KSh ${view.amount} paid to ${view.riderName}.` });
                load();
                payouts.reload();
              }}
              onError={(text) => onNotice({ kind: 'error', text })}
            />
          ))}
        </ul>
      </section>
      <section aria-label="Payouts" className="space-y-3">
        <h3 className="text-sm font-bold text-fg-strong">Paid to riders</h3>
        {payouts.phase !== 'loading' && payouts.phase !== 'error' && payouts.rows.length === 0 ? (
          <p role="status" className="rounded-xl border border-line bg-surface-raised p-6 text-center text-sm text-fg-muted">
            No rider has been paid yet.
          </p>
        ) : null}
        <ul className="space-y-2" aria-label="Payout list">
          {payouts.rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-line bg-surface-raised p-3 text-sm">
              <span className="min-w-0">
                <span className="font-semibold text-fg-strong">
                  {p.number} · {p.riderName}
                </span>{' '}
                · {p.method}
                {p.reference === null ? '' : ` · ${p.reference}`}
                <span className="block text-xs text-fg-muted">Paid on {p.paidOn}{p.note === null ? '' : ` · ${p.note}`}</span>
              </span>
              <span className="font-mono font-semibold text-fg-strong">
                {p.currency} {p.amount}
              </span>
            </li>
          ))}
        </ul>
        {payouts.cursor !== null ? (
          <button type="button" className={buttonClass} onClick={payouts.loadMore} disabled={payouts.phase === 'more'}>
            {payouts.phase === 'more' ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </section>
    </>
  );
}

function AccountsPanel({ books, onSaved, onNotice, onPosted }: { books: Books; onSaved: (a: Books['accounts']) => void; onNotice: (n: Notice) => void; onPosted: () => void }) {
  const [expense, setExpense] = useState<Choice | null>(books.accounts.expenseGlAccountId === null ? null : { id: books.accounts.expenseGlAccountId, label: books.accounts.expenseName ?? '' });
  const [payable, setPayable] = useState<Choice | null>(books.accounts.payableGlAccountId === null ? null : { id: books.accounts.payableGlAccountId, label: books.accounts.payableName ?? '' });
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="In the books" className={`${cardClass} space-y-3`}>
      <h3 className="text-sm font-bold text-fg-strong">In the books</h3>
      <p className="text-xs text-fg-muted">
        Rider pay is booked as a cost the moment it is earned, and as owed to the rider until you pay them. Choose the two accounts once. Nothing is booked before the books are live.
        {books.unposted > 0 ? ` ${String(books.unposted)} ${books.unposted === 1 ? 'entry is' : 'entries are'} waiting to be booked.` : ''}
      </p>
      <ChoicePicker label="Account rider pay is booked to" source="delivery-cost-accounts" choice={expense} onChoice={setExpense} placeholder="Choose the cost account (for example rider pay)" />
      <ChoicePicker label="Account that holds what is owed to riders" source="delivery-cost-accounts" choice={payable} onChoice={setPayable} placeholder="Choose the payable account" />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryClass}
          disabled={busy || expense === null || payable === null}
          onClick={() => {
            void (async () => {
              setBusy(true);
              const r = await attempt(setCostAccountsAction({ expenseGlAccountId: expense?.id ?? '', payableGlAccountId: payable?.id ?? '', expectedVersion: books.accounts.version }));
              setBusy(false);
              if (r.ok) onSaved(r.data);
              else onNotice({ kind: 'error', text: r.error });
            })();
          }}
        >
          Save
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              const r = await attempt(postCostsNowAction());
              setBusy(false);
              if (!r.ok) onNotice({ kind: 'error', text: r.error });
              else {
                onNotice({ kind: 'ok', text: r.data.posted === 0 && r.data.waiting === 0 && r.data.failed === 0 ? 'Everything is already booked.' : `${String(r.data.posted)} booked, ${String(r.data.waiting)} waiting for the accounts or the books to be ready, ${String(r.data.failed)} could not be booked.` });
                onPosted();
              }
            })();
          }}
        >
          Book what is waiting now
        </button>
      </div>
    </section>
  );
}

function PayRow({ owed, onPaid, onError }: { owed: OwedView; onPaid: (v: PayoutView) => void; onError: (text: string) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Choice | null>(null);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const pays = Number(owed.owed) > 0;
  return (
    <li className="space-y-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-fg-strong">{owed.name}</span>
        <span className="font-mono text-lg font-bold text-fg-strong">KSh {owed.owed}</span>
      </div>
      <p className="text-xs text-fg-muted">
        {owed.entries} {owed.entries === 1 ? 'entry' : 'entries'} not yet paid out{pays ? '' : '. Nothing can be paid until more is earned.'}
      </p>
      {pays && !open ? (
        <button type="button" className={primaryClass} onClick={() => setOpen(true)} aria-label={`Pay ${owed.name}`}>
          Pay {owed.name}
        </button>
      ) : null}
      {pays && open ? (
        <form
          aria-label={`Pay ${owed.name}`}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              setBusy(true);
              const r = await attempt(payRiderAction({ riderId: owed.riderId, paymentMethodId: method?.id ?? '', reference }));
              setBusy(false);
              if (!r.ok) {
                onError(r.error);
                return;
              }
              setOpen(false);
              onPaid(r.data);
            })();
          }}
        >
          <ChoicePicker label="Paid by" source="rider-payout-methods" choice={method} onChoice={setMethod} placeholder="Cash, M-Pesa or bank" />
          <Field id={`${uid}-ref`} label="Reference (M-Pesa code, cheque or slip number)">
            <input id={`${uid}-ref`} className={fieldClass} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} autoComplete="off" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy || method === null}>
              {busy ? 'Saving…' : `Pay KSh ${owed.owed}`}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
