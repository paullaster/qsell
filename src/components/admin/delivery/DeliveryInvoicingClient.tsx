'use client';

import { use, useCallback, useId, useState } from 'react';
import { ProductEditLink } from '@/components/admin/ProductEditLink';
import { useProductUpdated } from '@/components/admin/product-updated';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { DELIVERY_BILLING_MODES, DELIVERY_BILLING_WORDS, type DeliveryBillingMode } from '@/lib/delivery-invoicing';
import type { Choice } from '@/lib/payment-options';
import { deliveryBillingPageAction as readBilling, saveDeliveryBillingAction, type deliveryBillingPageAction } from '@/server/domains/delivery/billing-actions';
import { InvoicePreview } from './InvoicePreview';

type Page = Awaited<ReturnType<typeof deliveryBillingPageAction>>;
type View = Extract<Page, { ok: true }>['data'];

export function DeliveryInvoicingClient({ data, canManage, canEditProducts }: { data: ReturnType<typeof deliveryBillingPageAction>; canManage: Promise<boolean>; canEditProducts: Promise<boolean> }) {
  const page = use(data);
  const may = use(canManage);
  const mayEditProducts = use(canEditProducts);
  return page.ok ? <InvoicingView first={page.data} may={may} mayEditProducts={mayEditProducts} /> : <LoadFailed error={page.error} />;
}

function InvoicingView({ first, may, mayEditProducts }: { first: View; may: boolean; mayEditProducts: boolean }) {
  const uid = useId();
  const [saved, setSaved] = useState<View>(first);
  const [mode, setMode] = useState<DeliveryBillingMode>(first.mode);
  const [item, setItem] = useState<Choice | null>(first.serviceItem === null ? null : { id: first.serviceItem.id, label: `${first.serviceItem.name} (${first.serviceItem.sku})` });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const changed = mode !== saved.mode || (item?.id ?? null) !== (saved.serviceItem?.id ?? null);
  const shown = saved.serviceItem !== null && item?.id === saved.serviceItem.id ? saved.serviceItem : null;

  // The item was changed in its edit window (opened from here): read what this screen says about it again (registered with KRA, its tax).
  // Only that is taken; the choice being made and the version the save is checked against stay as they are.
  const serviceItemId = saved.serviceItem?.id ?? null;
  const itemSaved = useCallback(
    (productId: string) => {
      if (productId !== serviceItemId) return;
      void readBilling()
        .then((fresh) => {
          if (fresh.ok) setSaved((s) => ({ ...s, serviceItem: fresh.data.serviceItem, taxMismatches: fresh.data.taxMismatches }));
        })
        .catch(() => undefined);
    },
    [serviceItemId],
  );
  useProductUpdated(itemSaved);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveDeliveryBillingAction({ mode, serviceProductId: item?.id ?? null, expectedVersion: saved.version, reason }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSaved(res.data);
    setReason('');
    setNotice({ kind: 'ok', text: 'Saved. New invoices follow this choice; invoices already issued are not changed.' });
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Delivery invoicing" intro="When an order is delivered and you charge for it, KRA needs to know about the delivery too. Choose whether it goes on the same invoice as the products, signed once, or on an invoice of its own, signed separately." />
      <Message notice={notice} />

      <fieldset className={`${cardClass} space-y-4`} disabled={!may || busy}>
        <legend className="px-1 text-sm font-semibold text-fg-strong">How delivery is invoiced</legend>
        <div role="radiogroup" aria-label="How delivery is invoiced" className="grid gap-3 sm:grid-cols-2">
          {DELIVERY_BILLING_MODES.map((m) => (
            <label key={m} className={`flex min-h-10 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${mode === m ? 'border-indigo-500 bg-indigo-500/5' : 'border-line'}`}>
              <input type="radio" name={`${uid}-mode`} className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                <span className="block font-semibold text-fg-strong">{DELIVERY_BILLING_WORDS[m].name}</span>
                <span className="block text-xs text-fg-muted">{DELIVERY_BILLING_WORDS[m].means}</span>
              </span>
            </label>
          ))}
        </div>
        <InvoicePreview mode={mode} />
      </fieldset>

      <fieldset className={`${cardClass} space-y-3`} disabled={!may || busy}>
        <legend className="px-1 text-sm font-semibold text-fg-strong">The item that stands for delivery</legend>
        <p className="text-xs text-fg-muted">KRA is sent an item, not a description. Create a service item for delivery under Products, register it with KRA under KRA, eTIMS items, and choose it here. Its tax rate must be the tax your delivery charges carry.</p>
        <div className="max-w-md">
          <ChoicePicker label="Delivery service item" source="delivery-service-products" choice={item} onChoice={setItem} placeholder="Search services by name or code" clearable />
        </div>
        {item === null ? null : <ProductEditLink productId={item.id} name={item.label} canEdit={mayEditProducts} className="w-fit border border-line" />}
        {item === null ? (
          <p role="status" className="text-sm text-amber-700">No item chosen. Orders with a delivery charge cannot be signed for KRA until one is.</p>
        ) : null}
        {shown === null ? null : (
          <div className="flex flex-wrap gap-2 text-xs" aria-label="About this item">
            <Chip tone={shown.registered ? 'green' : 'amber'}>{shown.registered ? 'Registered with KRA' : 'Not registered with KRA yet'}</Chip>
            <Chip tone={shown.taxRate === null ? 'amber' : 'gray'}>{shown.taxRate === null ? 'No tax rate set' : `Tax ${String(shown.taxRate)}%`}</Chip>
          </div>
        )}
        {item !== null && shown === null ? <p className="text-xs text-fg-muted">Save to check this item: whether it is registered with KRA and what tax it carries.</p> : null}
        {shown !== null && !shown.registered ? <p className="text-sm text-amber-700">Register this item with KRA before delivery can be signed.</p> : null}
        {shown !== null && !shown.isService ? <p className="text-sm text-amber-700">This item is not a service. It still works for invoices already set up, but choose a service item (a classification that behaves as a service) when you next change this.</p> : null}
        {saved.taxMismatches.length > 0 ? (
          <div role="alert" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">These delivery charges carry a different tax from the item, so their invoices would be refused:</p>
            <ul className="mt-1 list-disc pl-5">
              {saved.taxMismatches.map((m) => (
                <li key={m.code}>
                  {m.name} ({m.code}): {String(m.taxRate)}%
                </li>
              ))}
            </ul>
            <p className="mt-1">Change the item’s tax, or the tax on those charge policies (a new version).</p>
          </div>
        ) : null}
      </fieldset>

      {may ? (
        <form
          aria-label="Save delivery invoicing"
          className={`${cardClass} flex flex-wrap items-end gap-3`}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="min-w-0 flex-1 basis-64">
            <Field id={`${uid}-reason`} label="Why? (kept with the change)">
              <input id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} className={fieldClass} maxLength={300} autoComplete="off" />
            </Field>
          </div>
          <button type="submit" className={primaryClass} disabled={busy || !changed || reason.trim().length < 5}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {changed ? null : <p className="w-full text-xs text-fg-muted">Change the choice or the item to save.</p>}
        </form>
      ) : (
        <p className="text-sm text-fg-muted">You can see this setting but not change it.</p>
      )}
    </div>
  );
}
