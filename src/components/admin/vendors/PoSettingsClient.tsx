'use client';

import { use, useId, useState } from 'react';
import { saveVendorSettingsAction, type vendorSettingsAction } from '@/server/domains/vendors/po-actions';
import { Field, LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type S = Extract<Awaited<ReturnType<typeof vendorSettingsAction>>, { ok: true }>['data'];

export function PoSettingsClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorSettingsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <View initial={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ initial }: { initial: S }) {
  const uid = useId();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Ordering rules" intro="Company-wide rules for purchase orders." />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-3`} aria-label="Ordering rules" onSubmit={(e) => { e.preventDefault(); setBusy(true); setNotice(null); void attempt(saveVendorSettingsAction(f)).then((r) => { setBusy(false); setNotice(r.ok ? { kind: 'ok', text: 'Saved.' } : { kind: 'error', text: r.error }); }); }}>
        <Field id={`${uid}-r`} label="An order above this value needs a request for quotation" hint="Someone allowed to skip it can still send a larger order, saying why. Leave empty to never require one."><input id={`${uid}-r`} inputMode="decimal" value={f.rfqRequiredAbove} onChange={(e) => setF((p) => ({ ...p, rfqRequiredAbove: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-t`} label="A change that raises an order by more than this (%) needs approval" hint="A change to any price always needs approval."><input id={`${uid}-t`} inputMode="decimal" value={f.amendmentTolerancePercent} onChange={(e) => setF((p) => ({ ...p, amendmentTolerancePercent: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  );
}
