'use client';

import { use, useState } from 'react';
import { setPartialBillingAction, type partialBillingScreenAction, type PartialBillingScreen } from '@/server/domains/selling/partial-billing-actions';
import { Chip, LoadFailed, Message, PageHeader, attempt, cardClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { ReasonField, type ReasonValue } from '../numbering/ReasonField';

type Loaded = Awaited<ReturnType<typeof partialBillingScreenAction>>;

export function PartialBillingClient({ firstPromise }: { firstPromise: ReturnType<typeof partialBillingScreenAction> }) {
  const res: Loaded = use(firstPromise);
  return res.ok ? <Body initial={res.data} /> : <LoadFailed error={res.error} />;
}

function Body({ initial }: { initial: PartialBillingScreen }) {
  const [data, setData] = useState(initial);
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const next = !data.enabled;
  let confirmWords = next ? 'Yes, switch it on' : 'Yes, switch it off';
  if (busy) confirmWords = 'Saving…';
  const change = async () => {
    setBusy(true);
    setNotice(null);
    const r = await attempt(setPartialBillingAction(next, reason));
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setReason({ code: '', text: '' });
      setConfirming(false);
      setNotice({ kind: 'ok', text: next ? 'Invoicing in parts is switched on.' : 'Invoicing in parts is switched off.' });
    } else setNotice({ kind: 'error', text: r.error });
  };
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Partial billing" intro="Whether a sales order can be invoiced in parts: a tax invoice for some of its lines or quantities now and the rest later, each with its own number and signing. Switched off, an order has one invoice for the whole order. Only people given this permission can change it." />
      <Message notice={notice} />
      <section className={`${cardClass} space-y-3`} aria-label="Invoicing in parts">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-fg-strong">Invoicing in parts</h2>
            <p className="text-sm text-fg-muted">{data.updatedBy === null ? 'Never changed: off by default.' : `Last changed by ${data.updatedBy}${data.updatedAt === null ? '' : ` on ${new Date(data.updatedAt).toLocaleString()}`}.`}</p>
          </div>
          <Chip tone={data.enabled ? 'green' : 'gray'}>{data.enabled ? 'On' : 'Off'}</Chip>
        </div>
        <p className="text-sm text-fg-muted">When it is on, staff see <strong>Invoice these quantities</strong> and <strong>Invoice what is left</strong> on a sales order that has no tax invoice yet. Each part is a full tax invoice numbered from the same series, signed with KRA on its own, and corrected by a credit note against that part. The invoices of an order always add up to the order to the cent. Switching it off later stops new part invoices; an order already started can still be finished with <em>Invoice what is left</em>.</p>
        {confirming ? (
          <form className="space-y-3 border-t border-line pt-3" aria-label={next ? 'Switch on' : 'Switch off'} onSubmit={(e) => { e.preventDefault(); void change(); }}>
            <ReasonField value={reason} onChange={setReason} source="billing-reasons" />
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primaryClass} disabled={busy || reason.code === ''}>{confirmWords}</button>
              <button type="button" className="min-h-10 rounded-lg border border-line px-3 text-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" className={primaryClass} onClick={() => { setNotice(null); setConfirming(true); }}>{next ? 'Switch on' : 'Switch off'}</button>
        )}
      </section>
    </div>
  );
}
