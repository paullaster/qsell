'use client';

import { use, useId, useState } from 'react';
import { saveOfflineSellingAction, type offlineSellingScreenAction, type OfflineSellingScreen } from '@/server/domains/selling/offline/offline-actions';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof offlineSellingScreenAction>>;

export function OfflineSellingClient({ firstPromise }: { firstPromise: ReturnType<typeof offlineSellingScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: OfflineSellingScreen }) {
  const uid = useId();
  const [data, setData] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maxPerShift, setMaxPerShift] = useState(String(initial.limits.maxPerShift));
  const [maxHours, setMaxHours] = useState(String(initial.limits.maxHours));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const changed = enabled !== data.enabled || Number(maxPerShift) !== data.limits.maxPerShift || Number(maxHours) !== data.limits.maxHours;
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(saveOfflineSellingAction({ enabled, limits: { maxPerShift: Number(maxPerShift), maxHours: Number(maxHours) } }, reason));
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setReason({ code: '', text: '' });
      setNotice({ kind: 'ok', text: 'Saved. Tills pick it up the next time they are ready (every few minutes while online).' });
    } else setNotice({ kind: 'error', text: r.error });
  };
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Offline selling" intro="Whether a till can keep ringing up cash sales when the connection drops, and bring them in safely when it returns. Only people given this permission can change it." />
      <Message notice={notice} />
      <form aria-label="Offline selling" className={`${cardClass} space-y-4`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-fg-strong">Selling with no connection</h2>
            <p className="text-sm text-fg-muted">{data.updatedBy === null ? 'Never changed: off by default.' : `Last changed by ${data.updatedBy}${data.updatedAt === null ? '' : ` on ${new Date(data.updatedAt).toLocaleString()}`}.`}</p>
          </div>
          <Chip tone={data.enabled ? 'green' : 'gray'}>{data.enabled ? 'On' : 'Off'}</Chip>
        </div>
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm" data-testid="offline-acceptance">
          <p className="font-semibold text-fg-strong">What switching it on means for the company</p>
          <ul className="list-disc space-y-1 pl-5 text-fg-muted">
            <li>A sale rung up with no connection cannot take a number from the gap-free receipt series or be signed with KRA until it is sent. The customer leaves with a <strong>provisional slip</strong> (the till&apos;s own reference, &quot;tax receipt to follow&quot;); the real receipt is numbered and signed when the sale is sent, and can be printed again for a customer who returns.</li>
            <li>The customer is charged the <strong>list price the till kept</strong>; discounts, price lists and customers need the connection. Any difference from the price now is flagged for a supervisor to look at; the customer is never charged more.</li>
            <li>Only <strong>cash sales</strong> can be sold offline, in a shift opened while online. A sale whose stock is not there is <strong>kept, not lost</strong>, and stops the shift being closed until a supervisor puts the stock right or gives it up with a reason.</li>
          </ul>
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Allow tills to sell with no connection
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${uid}-max`} label="Most to sell offline in one shift (KES)"><input id={`${uid}-max`} type="number" min={1} step="1" className={fieldClass} value={maxPerShift} onChange={(e) => setMaxPerShift(e.target.value)} /></Field>
          <Field id={`${uid}-hours`} label="Longest an offline sale may wait to be sent (hours)"><input id={`${uid}-hours`} type="number" min={1} max={168} step="1" className={fieldClass} value={maxHours} onChange={(e) => setMaxHours(e.target.value)} /></Field>
        </div>
        <ReasonField value={reason} onChange={setReason} source="offline-reasons" />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryClass} disabled={busy || !changed || reason.code === ''}>{busy ? 'Saving…' : 'Save'}</button>
          {changed ? <button type="button" className={buttonClass} onClick={() => { setEnabled(data.enabled); setMaxPerShift(String(data.limits.maxPerShift)); setMaxHours(String(data.limits.maxHours)); }} disabled={busy}>Undo</button> : null}
        </div>
      </form>
    </div>
  );
}
