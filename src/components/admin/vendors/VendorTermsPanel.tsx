'use client';

import { use, useId, useState } from 'react';
import { saveVendorTermsAction, type vendorTermsAction } from '@/server/domains/vendors/payment-terms-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import { Field, Message, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Terms = Extract<Awaited<ReturnType<typeof vendorTermsAction>>, { ok: true }>['data'];

/** What this vendor is paid under: tax withheld and an early-payment discount. Shown to anyone who sees the vendor; changed only by those allowed. */
export function VendorTermsPanel({ vendorId, termsPromise, canEdit }: { vendorId: string; termsPromise: ReturnType<typeof vendorTermsAction>; canEdit: boolean }) {
  const res = use(termsPromise);
  if (!res.ok) return null;
  return <Form vendorId={vendorId} terms={res.data} canEdit={canEdit} />;
}

function Form({ vendorId, terms, canEdit }: { vendorId: string; terms: Terms; canEdit: boolean }) {
  const uid = useId();
  const choices: Choice[] = terms.codes.map((c) => ({ id: c.id, label: c.label }));
  const [code, setCode] = useState<Choice | null>(choices.find((c) => c.id === terms.withholdingCodeId) ?? null);
  const [percent, setPercent] = useState(terms.earlyDiscountPercent === '0.00' ? '' : terms.earlyDiscountPercent);
  const [days, setDays] = useState(terms.earlyDiscountDays === '0' ? '' : terms.earlyDiscountDays);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveVendorTermsAction(vendorId, { withholdingCodeId: code?.id ?? '', earlyDiscountPercent: percent, earlyDiscountDays: days }));
    setBusy(false);
    setNotice(res.ok ? { kind: 'ok', text: 'Saved. It applies to payments approved from now on.' } : { kind: 'error', text: res.error });
  };
  return (
    <form className={`${cardClass} space-y-3`} aria-label="How this vendor is paid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3 className="text-sm font-bold text-fg-strong">How this vendor is paid</h3>
      <Message notice={notice} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3"><ChoicePicker label="Tax withheld from payments" source="withholding-codes" choice={code} onChoice={setCode} placeholder="None" disabled={!canEdit} /></div>
        <Field id={`${uid}-p`} label="Early-payment discount (%)" hint="Leave empty for none."><input id={`${uid}-p`} inputMode="decimal" value={percent} disabled={!canEdit} onChange={(e) => setPercent(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-d`} label="If paid within (days of the invoice date)"><input id={`${uid}-d`} inputMode="numeric" value={days} disabled={!canEdit} onChange={(e) => setDays(e.target.value)} className={fieldClass} autoComplete="off" /></Field>
      </div>
      {canEdit ? <button type="submit" className={primaryClass} disabled={busy}>Save</button> : <p className="text-xs text-fg-muted">Only someone allowed to set payment rules can change this.</p>}
    </form>
  );
}
