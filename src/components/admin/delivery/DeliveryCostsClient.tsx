'use client';

import { use, useId, useState } from 'react';
import { costsPageAction, reverseCostAction, setPayRulesAction, type payRulesAction } from '@/server/domains/delivery/cost-actions';
import type { CostView } from '@/server/domains/delivery/costs';
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
          {cost.riderName === null ? '' : ` · ${cost.riderName}`}
          {cost.courierName === null ? '' : ` · ${cost.courierName}`}
        </span>
        <span className={`font-mono font-semibold ${negative ? 'text-red-700 dark:text-red-300' : 'text-fg-strong'}`}>
          {cost.currency} {cost.amount}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        {when(cost.createdAt)}
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
