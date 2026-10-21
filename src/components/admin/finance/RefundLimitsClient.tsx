'use client';

import { use, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveRefundLimitsAction, type refundLimitsAction } from '@/server/domains/finance/refund-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { LIMIT_MODES, checkLimitsForm, describeLimits, startingLimitsForm, type LimitsForm } from '@/lib/refund-limits-form';
import { choiceOf } from '@/lib/wallet-policy';
import { Chip, Field, LoadFailed, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof refundLimitsAction>>, { ok: true }>['data'];

export function RefundLimitsClient({ viewPromise }: { viewPromise: ReturnType<typeof refundLimitsAction> }) {
  const res = use(viewPromise);
  return res.ok ? <RefundLimitsView view={res.data} /> : <LoadFailed error={res.error} />;
}

function RefundLimitsView({ view }: { view: View }) {
  const uid = useId();
  const router = useRouter();
  const [form, setForm] = useState<LimitsForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const set = <K extends keyof LimitsForm>(k: K, v: LimitsForm[K]) => setForm((f) => (f === null ? f : { ...f, [k]: v }));

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (form === null) return;
    const checked = checkLimitsForm(form);
    if (!checked.ok) {
      setNotice({ kind: 'error', text: checked.error });
      return;
    }
    setBusy(true);
    const res = await attempt(saveRefundLimitsAction(checked.value, view.version));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: 'Saved. It applies to refunds asked for from now on.' });
    setForm(null);
    router.refresh();
  };

  const number = (id: string, label: string, key: 'maxPerCustomer' | 'maxAmountPerCustomer' | 'maxPerDestination' | 'maxPerRequester' | 'maxAmountPerRequester', hint: string) => (
    <Field id={`${uid}-${id}`} label={label} hint={hint}>
      <input id={`${uid}-${id}`} value={form?.[key] ?? ''} onChange={(e) => set(key, e.target.value)} className={fieldClass} inputMode="decimal" autoComplete="off" />
    </Field>
  );

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="Refund limits"
        intro="How fast refunds may be asked for. A customer, a phone number or account, and a person can each only ask for so many refunds, and for so much, in a window. Past a limit the refund is held for approval whatever its amount, or refused."
      />
      <Message notice={notice} />

      <section className={`${cardClass} space-y-2`} aria-label="Limits in force">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-fg-strong">In force now</h3>
          {view.values.enabled ? <Chip tone="green">On</Chip> : <Chip tone="gray">Off</Chip>}
        </div>
        <p className="text-sm text-fg">{describeLimits(view.values)}</p>
        {view.updatedAt === null ? null : <p className="text-xs text-fg-muted">Last changed {new Date(view.updatedAt).toLocaleString()}{view.updatedBy === null ? '' : ` by ${view.updatedBy}`}.</p>}
        {view.canManage && form === null ? (
          <button type="button" className={buttonClass} onClick={() => { setForm(startingLimitsForm(view.values)); setNotice(null); }}>Change</button>
        ) : null}
        {!view.canManage ? <p className="text-sm text-fg-muted">You may view the limits, but changing them needs another permission.</p> : null}
      </section>

      {form === null ? null : (
        <form onSubmit={(e) => void save(e)} className={`${cardClass} space-y-4`} aria-label="Change the refund limits">
          <label className="flex min-h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="h-4 w-4" /> Limit how fast refunds are asked for</label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id={`${uid}-window`} label="Window (hours)" hint="1 to 720. 24 is a day, 168 a week.">
              <input id={`${uid}-window`} value={form.windowHours} onChange={(e) => set('windowHours', e.target.value)} className={fieldClass} inputMode="numeric" autoComplete="off" disabled={!form.enabled} />
            </Field>
            <ChoicePicker label="Past a limit" source="refund-limit-modes" choice={choiceOf(LIMIT_MODES, form.mode)} onChoice={(c) => set('mode', c?.id ?? 'review')} clearable={false} required disabled={!form.enabled} />
            {number('cust', 'Refunds per customer', 'maxPerCustomer', 'Leave empty for no limit.')}
            {number('custamt', 'Money per customer', 'maxAmountPerCustomer', 'Leave empty for no limit.')}
            {number('dest', 'Refunds per phone number or account', 'maxPerDestination', 'The same phone or bank account paid again and again.')}
            {number('req', 'Refunds per person asking', 'maxPerRequester', 'One member of staff asking for many.')}
            {number('reqamt', 'Money per person asking', 'maxAmountPerRequester', 'Leave empty for no limit.')}
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>Save limits</button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
