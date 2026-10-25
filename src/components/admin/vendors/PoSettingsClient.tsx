'use client';

import { use, useId, useState } from 'react';
import { saveVendorSettingsAction, type vendorSettingsAction } from '@/server/domains/vendors/po-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
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
  const [tax, setTax] = useState<Choice | null>(initial.inputTaxAccountId === '' ? null : { id: initial.inputTaxAccountId, label: initial.inputTaxAccountLabel });
  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Ordering rules" intro="Company-wide rules for purchase orders." />
      <Message notice={notice} />
      <form className={`${cardClass} space-y-3`} aria-label="Ordering rules" onSubmit={(e) => { e.preventDefault(); setBusy(true); setNotice(null); void attempt(saveVendorSettingsAction({ ...f, inputTaxAccountId: tax?.id ?? '' })).then((r) => { setBusy(false); setNotice(r.ok ? { kind: 'ok', text: 'Saved.' } : { kind: 'error', text: r.error }); }); }}>
        <Field id={`${uid}-r`} label="An order above this value needs a request for quotation" hint="Someone allowed to skip it can still send a larger order, saying why. Leave empty to never require one."><input id={`${uid}-r`} inputMode="decimal" value={f.rfqRequiredAbove} onChange={(e) => setF((p) => ({ ...p, rfqRequiredAbove: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-t`} label="A change that raises an order by more than this (%) needs approval" hint="A change to any price always needs approval."><input id={`${uid}-t`} inputMode="decimal" value={f.amendmentTolerancePercent} onChange={(e) => setF((p) => ({ ...p, amendmentTolerancePercent: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-d`} label="A delivery may bring this much more than ordered (%)" hint="Beyond it, the extra must be refused or the order amended first. 0 means no more than ordered."><input id={`${uid}-d`} inputMode="decimal" value={f.receiptTolerancePercent} onChange={(e) => setF((p) => ({ ...p, receiptTolerancePercent: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <h2 className="pt-2 text-base font-semibold text-gray-900 dark:text-gray-100">Supplier invoices</h2>
        <div><ChoicePicker label="Account for the tax on supplier invoices (input tax)" source="invoice-tax-accounts" choice={tax} onChoice={setTax} placeholder="Search by number or name" /><p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Without it, an invoice that has tax cannot be booked.</p></div>
        <Field id={`${uid}-ip`} label="An invoice price above the order’s by more than this (%) …" hint="… and by more than the amount below on the line, is a difference to look at."><input id={`${uid}-ip`} inputMode="decimal" value={f.invoicePriceTolerancePercent} onChange={(e) => setF((p) => ({ ...p, invoicePriceTolerancePercent: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-ia`} label="… and by more than this amount on the line" hint="A line passes if it is within the percentage or within this amount."><input id={`${uid}-ia`} inputMode="decimal" value={f.invoicePriceToleranceAmount} onChange={(e) => setF((p) => ({ ...p, invoicePriceToleranceAmount: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <Field id={`${uid}-iq`} label="An invoice may charge for this much more than the linked goods (%)" hint="0 means no more than was received."><input id={`${uid}-iq`} inputMode="decimal" value={f.invoiceQuantityTolerancePercent} onChange={(e) => setF((p) => ({ ...p, invoiceQuantityTolerancePercent: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <h2 className="pt-2 text-base font-semibold text-gray-900 dark:text-gray-100">Payments to vendors</h2>
        <Field id={`${uid}-p3`} label="A payment of at least this value needs three different people" hint="One prepares it, another approves it and a third pays it. Below the value two people are enough: whoever prepared a payment cannot approve it. 0 means never."><input id={`${uid}-p3`} inputMode="decimal" value={f.paymentThreeEyesAbove} onChange={(e) => setF((p) => ({ ...p, paymentThreeEyesAbove: e.target.value }))} className={fieldClass} autoComplete="off" /></Field>
        <button type="submit" className={primaryClass} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </div>
  );
}
