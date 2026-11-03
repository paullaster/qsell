'use client';

import { useId, useState } from 'react';
import { quoteDeliveryAction } from '@/server/domains/delivery/policy-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Field, Message, attempt, cardClass, Chip, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import type { Choice } from '@/lib/payment-options';

type Answer = Extract<Awaited<ReturnType<typeof quoteDeliveryAction>>, { ok: true }>['data'];
type Charge = Extract<Answer, { ok: true }>;
type Refusal = Extract<Answer, { ok: false }>;

const money = (currency: string, n: number): string => `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Asks the server what a delivery would cost, with the same rules an order uses, and shows how it was worked out. Nothing is saved. */
export function ChargeSimulator() {
  const uid = useId();
  const [branch, setBranch] = useState<Choice | null>(null);
  const [channel, setChannel] = useState<Choice | null>(null);
  const [group, setGroup] = useState<Choice | null>(null);
  const [f, setF] = useState({ county: '', town: '', area: '', latitude: '', longitude: '', weightKg: '1', orderValue: '1000', at: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const set = (key: keyof typeof f, value: string) => setF((s) => ({ ...s, [key]: value }));

  const ask = async () => {
    if (branch === null) {
      setNotice({ kind: 'error', text: 'Choose the branch the order would leave from.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    setAnswer(null);
    const res = await attempt(quoteDeliveryAction({ branchId: branch.id, county: f.county, town: f.town, area: f.area, latitude: f.latitude, longitude: f.longitude, weightKg: f.weightKg, orderValue: f.orderValue, at: f.at, channel: channel?.id ?? '', customerGroupId: group?.id ?? '' }));
    setBusy(false);
    if (res.ok) setAnswer(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };

  return (
    <section className={`${cardClass} space-y-4`} aria-label="Try a delivery charge">
      <div>
        <h3 className="text-sm font-bold text-fg-strong">Try a delivery charge</h3>
        <p className="text-xs text-fg-muted">See what an order would be charged for delivery, and why, using the policies that are in force now. Nothing is saved.</p>
      </div>
      <Message notice={notice} />
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ChoicePicker label="Leaves from branch" source="delivery-branches" choice={branch} onChoice={setBranch} placeholder="Choose a branch" required />
          <Field id={`${uid}-county`} label="County">
            <input id={`${uid}-county`} value={f.county} onChange={(e) => set('county', e.target.value)} className={fieldClass} placeholder="Nairobi" autoComplete="off" />
          </Field>
          <Field id={`${uid}-town`} label="Town">
            <input id={`${uid}-town`} value={f.town} onChange={(e) => set('town', e.target.value)} className={fieldClass} placeholder="Westlands" autoComplete="off" />
          </Field>
          <Field id={`${uid}-area`} label="Estate or area">
            <input id={`${uid}-area`} value={f.area} onChange={(e) => set('area', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-lat`} label="Pin latitude (optional)">
            <input id={`${uid}-lat`} inputMode="decimal" value={f.latitude} onChange={(e) => set('latitude', e.target.value)} className={`${fieldClass} font-mono`} placeholder="-1.286389" autoComplete="off" />
          </Field>
          <Field id={`${uid}-lng`} label="Pin longitude (optional)">
            <input id={`${uid}-lng`} inputMode="decimal" value={f.longitude} onChange={(e) => set('longitude', e.target.value)} className={`${fieldClass} font-mono`} placeholder="36.817223" autoComplete="off" />
          </Field>
          <Field id={`${uid}-weight`} label="Weight (kg)">
            <input id={`${uid}-weight`} inputMode="decimal" value={f.weightKg} onChange={(e) => set('weightKg', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-value`} label="Order value">
            <input id={`${uid}-value`} inputMode="decimal" value={f.orderValue} onChange={(e) => set('orderValue', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-at`} label="Date and time" hint="In the business’s time zone. Empty: now.">
            <input id={`${uid}-at`} type="datetime-local" value={f.at} onChange={(e) => set('at', e.target.value)} className={fieldClass} />
          </Field>
          <ChoicePicker label="Where the order comes from" source="delivery-channels" choice={channel} onChoice={setChannel} placeholder="Any" clearable />
          <ChoicePicker label="Customer group" source="delivery-customer-groups" choice={group} onChoice={setGroup} placeholder="None" clearable />
        </div>
        <button type="submit" className={primaryClass} disabled={busy}>
          {busy ? 'Working it out…' : 'Work out the charge'}
        </button>
      </form>

      {answer?.ok === true ? <Charged answer={answer} /> : null}
      {answer !== null && !answer.ok ? <Refused answer={answer} /> : null}
    </section>
  );
}

function outcomeWords(r: Answer['considered'][number]): string {
  if (r.outcome === 'won') return 'chosen';
  return `${r.outcome === 'lost' ? 'not chosen' : 'does not apply'}. ${r.why ?? ''}`;
}

function Considered({ rows }: { rows: Answer['considered'] }) {
  if (rows.length === 0) return null;
  return (
    <details className="text-xs text-fg">
      <summary className="min-h-10 cursor-pointer py-2 font-semibold">Which policies were looked at ({rows.length})</summary>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.id} className="break-words">
            <span className="font-mono">{r.code}</span>: {outcomeWords(r)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Charged({ answer }: { answer: Charge }) {
  return (
    <div className="space-y-3" role="status" aria-label="The charge">
      <p className="text-2xl font-bold text-fg-strong">{money(answer.currency, answer.amount)}</p>
      <p className="flex flex-wrap gap-1.5 text-xs">
        {answer.policy === null ? null : (
          <Chip tone="sky">
            {answer.policy.name} ({answer.policy.code} v{answer.policy.version})
          </Chip>
        )}
        {answer.zone === null ? <Chip tone="gray">No zone</Chip> : <Chip tone="green">Zone {answer.zone.name} ({answer.zone.by === 'pin' ? 'from the pin' : 'from the written address'})</Chip>}
        {answer.route === null ? null : (
          <Chip tone={answer.route.degraded || answer.route.approximate ? 'amber' : 'gray'}>
            {String(answer.route.km)} km{answer.route.minutes === null ? '' : `, about ${String(Math.round(answer.route.minutes))} min`} · {answer.route.provider}
            {answer.route.approximate ? ' · from the written address, approximate' : ''}
            {answer.route.degraded ? ' · the map service was unavailable, estimate used' : ''}
          </Chip>
        )}
      </p>
      <ol className="space-y-1.5" aria-label="How it was worked out">
        {answer.steps.map((s) => (
          <li key={`${s.kind}-${s.label}-${String(s.running)}`} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg">
            <span className="min-w-0 break-words">{s.label}</span>
            <span className="font-mono text-xs">
              {s.amount < 0 ? '−' : '+'}
              {money(answer.currency, Math.abs(s.amount))} → {money(answer.currency, s.running)}
            </span>
          </li>
        ))}
      </ol>
      <Considered rows={answer.considered} />
    </div>
  );
}

function Refused({ answer }: { answer: Refusal }) {
  return (
    <div className="space-y-3" role="alert">
      <p className="text-sm text-red-700">{answer.message}</p>
      <p className="text-[11px] text-fg-muted">Reason: {answer.reason.replaceAll('_', ' ')}</p>
      <Considered rows={answer.considered} />
    </div>
  );
}
