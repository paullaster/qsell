'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateCompanyPublicBaseUrlAction } from '@/server/domains/payments/actions';
import { linkOrdersToMethodsAction, seedPaymentSetupAction } from '@/server/domains/finance/receivables/actions';
import { createProviderAction, type paymentSetupAction } from '@/server/domains/finance/payment-setup-actions';
import { Field, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from '../finance/ui';
import { PaymentProviderCard } from './PaymentProviderCard';

type Setup = Extract<Awaited<ReturnType<typeof paymentSetupAction>>, { ok: true }>['data'];

/**
 * Settings → Payments: the one place payment is set up. A provider is a connection to a payment
 * service with the credentials every payment method under it shares; each method is one way of
 * being paid (a paybill, a till, cash...) with its branch, bank account and G/L account.
 */
export function PaymentSetupClient({ setup }: { setup: Setup }) {
  const uid = useId();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(setup.providers.find((p) => !p.isSystem)?.id ?? setup.providers[0]?.id ?? null);
  const [notice, setNotice] = useState<Notice>(null);
  const [baseUrl, setBaseUrl] = useState(setup.publicBaseUrl ?? '');
  const [adding, setAdding] = useState(false);
  const [service, setService] = useState(setup.services[0]?.code ?? 'mpesa_daraja');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const changed = (text?: string) => {
    if (text) setNotice({ kind: 'ok', text });
    router.refresh();
  };

  const saveUrl = async () => {
    setBusy(true);
    try {
      await updateCompanyPublicBaseUrlAction(baseUrl);
      setNotice({ kind: 'ok', text: 'Public address saved.' });
      router.refresh();
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : 'It could not be saved.' });
    }
    setBusy(false);
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await attempt(createProviderAction({ providerCode: service, displayName: newName.trim() || undefined }));
    setBusy(false);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setAdding(false);
    setNewName('');
    setOpen(res.data.id);
    changed('Provider added. Enter its credentials, test the connection, then add its payment methods.');
  };

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Payments"
        intro="Add each payment service once as a provider and enter its shared credentials. Under it, add a payment method for every branch, paybill, till or account you take money through, each with its own bank account and G/L account."
        actions={setup.can.createProvider ? <button type="button" className={primaryClass} aria-expanded={adding} onClick={() => setAdding(!adding)}>Add a provider</button> : null}
      />
      <Message notice={notice} />

      {adding ? (
        <form onSubmit={(e) => void add(e)} className={`${cardClass} space-y-3`} aria-label="Add a provider">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={`${uid}-s`} label="Payment service">
              <select id={`${uid}-s`} value={service} onChange={(e) => setService(e.target.value as typeof service)} className={fieldClass}>{setup.services.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select>
            </Field>
            <Field id={`${uid}-nn`} label="Name (optional)" hint="Shown in lists. Defaults to the service name."><input id={`${uid}-nn`} value={newName} onChange={(e) => setNewName(e.target.value)} className={fieldClass} maxLength={80} autoComplete="off" /></Field>
          </div>
          <div className="flex gap-2"><button type="submit" className={primaryClass} disabled={busy}>Add provider</button><button type="button" className={buttonClass} onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      ) : null}

      <section className={`${cardClass} space-y-2`} aria-label="Public address">
        <label htmlFor={`${uid}-url`} className="text-xs font-semibold text-fg-muted">Company public address (providers call back here)</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input id={`${uid}-url`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-shop.example" className={`${fieldClass} font-mono`} />
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void saveUrl()}>Save address</button>
        </div>
      </section>

      <div className="space-y-3">
        {setup.providers.map((p) => (
          <PaymentProviderCard key={p.id} setup={setup} provider={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChanged={changed} />
        ))}
      </div>

      {setup.financeSetUp && (setup.can.seed || setup.can.linkOrders) ? (
        <section className={`${cardClass} space-y-2`} aria-label="Standard setup">
          <h2 className="text-sm font-bold text-fg-strong">Standard setup</h2>
          <p className="text-xs text-fg-muted">Add the standard bank and cash accounts and payment methods for your chart of accounts (anything already there is left alone). They start under the Manual provider; move each to its real provider by editing it.</p>
          <div className="flex flex-wrap gap-2">
            {setup.can.seed ? <button type="button" className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); const r = await attempt(seedPaymentSetupAction()); setBusy(false); setNotice(r.ok ? { kind: 'ok', text: `Added ${r.data.bankAccounts} bank accounts and ${r.data.methods} payment methods.` } : { kind: 'error', text: r.error }); if (r.ok) router.refresh(); }}>Add the standard accounts and methods</button> : null}
            {setup.can.linkOrders ? <button type="button" className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); const r = await attempt(linkOrdersToMethodsAction()); setBusy(false); setNotice(r.ok ? { kind: 'ok', text: r.data.linked === 0 ? 'Every order that can be linked already is.' : `Linked ${r.data.linked} past orders to their payment method.` } : { kind: 'error', text: r.error }); }}>Link past orders to payment methods</button> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
