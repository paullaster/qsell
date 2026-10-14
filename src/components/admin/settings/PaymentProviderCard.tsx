'use client';

import { useId, useState } from 'react';
import { setPaymentMethodEnabledAction, deletePaymentMethodAction } from '@/server/domains/finance/receivables/actions';
import {
  deleteProviderAction,
  saveProviderAction,
  setProviderCredentialsAction,
  setProviderEnabledAction,
  testProviderAction,
  type paymentSetupAction,
} from '@/server/domains/finance/payment-setup-actions';
import { Chip, Field, Message, buttonClass, cardClass, dangerClass, fieldClass, primaryClass, type Notice, attempt } from '../finance/ui';
import { CAPABILITY_LABEL, CREDENTIAL_FIELDS } from './payment-credential-fields';
import { DarajaPanel } from './DarajaPanel';
import { PaymentMethodForm, type SetupMethod } from './PaymentMethodForm';

type Setup = Extract<Awaited<ReturnType<typeof paymentSetupAction>>, { ok: true }>['data'];
type Provider = Setup['providers'][number];

const KIND_WORDS: Record<string, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', bank_deposit: 'Bank deposit', cheque: 'Cheque', mobile_money: 'Mobile money', card: 'Card', gateway: 'Online gateway', other: 'Other' };

/** One provider: the connection and its shared credentials, and the payment methods that go through it. */
export function PaymentProviderCard({ setup, provider: p, open, onToggle, onChanged }: { setup: Setup; provider: Provider; open: boolean; onToggle: () => void; onChanged: (text?: string) => void }) {
  const uid = useId();
  const can = setup.can;
  const manual = p.isSystem;
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [name, setName] = useState(p.label);
  const [env, setEnv] = useState(p.environment);
  const [url, setUrl] = useState(p.apiBaseUrl);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ method: SetupMethod | null } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const fields = CREDENTIAL_FIELDS[p.providerCode] ?? [];
  const methods = setup.methods.filter((m) => m.providerId === p.id);

  const run = async (key: string, okText: string, call: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>) => {
    setBusy(key);
    setNotice(null);
    const res = await attempt(call());
    setBusy(null);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: 'ok', text: okText });
    onChanged();
    return res;
  };

  const test = async () => {
    setBusy('test');
    setNotice(null);
    const res = await attempt(testProviderAction(p.id));
    setBusy(null);
    if (!res.ok) return setNotice({ kind: 'error', text: res.error });
    setNotice({ kind: res.data.ok ? 'ok' : 'error', text: res.data.ok ? `Connected: ${res.data.message}` : `Could not connect: ${res.data.message}` });
    onChanged();
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface-raised" aria-label={p.label}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-fg-strong">{p.label}</span>
            {manual ? <Chip tone="gray">Built in</Chip> : <Chip tone={p.isEnabled ? 'green' : 'gray'}>{p.isEnabled ? 'On' : 'Off'}</Chip>}
            {!manual ? <Chip tone="gray">{p.environment === 'production' ? 'Production' : 'Testing'}</Chip> : null}
            {!manual ? <Chip tone={p.hasCredentials ? 'sky' : 'amber'}>{p.hasCredentials ? 'Credentials saved' : 'No credentials'}</Chip> : null}
            <Chip tone="gray">{methods.length} method{methods.length === 1 ? '' : 's'}</Chip>
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">{p.service} — {p.description}</span>
        </span>
        <span aria-hidden="true" className="text-fg-subtle">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="space-y-5 border-t border-line px-4 py-4">
          <Message notice={notice} />

          {!manual ? (
            <>
              <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run('save', 'Saved.', () => saveProviderAction({ id: p.id, displayName: name, environment: env, apiBaseUrl: url })); }}>
                <Field id={`${uid}-nm`} label="Name"><input id={`${uid}-nm`} value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} disabled={!can.editProvider} required maxLength={80} /></Field>
                <Field id={`${uid}-env`} label="Environment">
                  <select id={`${uid}-env`} value={env} onChange={(e) => setEnv(e.target.value as 'staging')} className={fieldClass} disabled={!can.editProvider}>
                    <option value="staging">Testing (sandbox)</option>
                    <option value="production">Production</option>
                  </select>
                </Field>
                <div className="sm:col-span-2"><Field id={`${uid}-url`} label="Service address"><input id={`${uid}-url`} value={url} onChange={(e) => setUrl(e.target.value)} className={`${fieldClass} font-mono text-xs`} disabled={!can.editProvider} /></Field></div>
                {can.editProvider ? <div><button type="submit" className={buttonClass} disabled={busy !== null}>Save connection</button></div> : null}
              </form>

              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run('creds', 'Credentials saved (sealed; they are not shown again).', async () => { const r = await setProviderCredentialsAction(p.id, creds); if (r.ok) setCreds({}); return r; }); }}>
                <h4 className="text-xs font-bold uppercase text-fg-muted">Credentials shared by every method under this provider</h4>
                <p className="text-xs text-fg-muted">Leave a field empty to keep what is saved. Enter a value only to set or replace it.</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {fields.map((f) => (
                    <div key={f.key} className={f.multiline ? 'sm:col-span-2' : ''}>
                      <Field id={`${uid}-c-${f.key}`} label={f.label} hint={p.maskedCredentials?.[f.key] ? `Saved: ${p.maskedCredentials[f.key]}` : undefined}>
                        {f.multiline ? (
                          <textarea id={`${uid}-c-${f.key}`} rows={4} value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} className={`${fieldClass} font-mono text-xs`} disabled={!can.setCredentials} autoComplete="off" />
                        ) : (
                          <input id={`${uid}-c-${f.key}`} type="password" value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} className={`${fieldClass} font-mono`} disabled={!can.setCredentials} autoComplete="new-password" />
                        )}
                      </Field>
                    </div>
                  ))}
                </div>
                {can.setCredentials ? <button type="submit" className={buttonClass} disabled={busy !== null || Object.values(creds).every((v) => !v.trim())}>Save credentials</button> : null}
              </form>

              <div className="space-y-2 text-xs">
                {p.capabilities.length > 0 ? <p className="flex flex-wrap items-center gap-1"><span className="text-fg-muted">Can:</span>{p.capabilities.map((c) => <Chip key={c} tone="gray">{CAPABILITY_LABEL[c] ?? c}</Chip>)}</p> : null}
                {p.callbackUrl ? <p className="break-all text-fg-muted">Callback address: <span className="font-mono">{p.callbackUrl}</span></p> : <p className="text-fg-muted">Set the company&apos;s public address above to see the callback address.</p>}
                {p.lastTestAt ? <p role="status" className={p.lastTestOk ? 'text-green-700' : 'text-red-700'}>Last test {new Date(p.lastTestAt).toLocaleString()}: {p.lastTestOk ? 'connected' : 'failed'} — {p.lastTestMessage}</p> : <p className="text-fg-muted">Not tested yet.</p>}
              </div>

              <div className="flex flex-wrap gap-2">
                {can.test ? <button type="button" className={buttonClass} disabled={busy !== null || !p.hasCredentials} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button> : null}
                {can.enable ? <button type="button" className={p.isEnabled ? buttonClass : primaryClass} disabled={busy !== null} onClick={() => void run('enable', p.isEnabled ? 'Switched off.' : 'Switched on.', () => setProviderEnabledAction(p.id, !p.isEnabled))}>{p.isEnabled ? 'Switch off' : 'Switch on'}</button> : null}
                {can.deleteProvider ? (confirm === 'provider'
                  ? <><button type="button" className={dangerClass} disabled={busy !== null} onClick={() => void run('delete', 'Provider deleted.', () => deleteProviderAction(p.id))}>Yes, delete {p.label}</button><button type="button" className={buttonClass} onClick={() => setConfirm(null)}>Keep it</button></>
                  : <button type="button" className={dangerClass} disabled={busy !== null || methods.length > 0} title={methods.length > 0 ? 'Move or delete its payment methods first' : undefined} onClick={() => setConfirm('provider')}>Delete provider</button>) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-fg-muted">Cash, cheques and manual bank deposits do not go through an outside company, so there is nothing to connect here. Add your cash, cheque and deposit methods below, with whatever names and G/L accounts you want.</p>
          )}

          {p.daraja ? <DarajaPanel setup={setup} provider={p} onChanged={onChanged} /> : null}

          <div className={`${cardClass} space-y-3 bg-surface-sunken/40`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-bold text-fg-strong">Payment methods under {p.label}</h4>
              {can.createMethod && setup.financeSetUp && !form ? <button type="button" className={primaryClass} onClick={() => setForm({ method: null })}>Add a payment method</button> : null}
            </div>
            {!setup.financeSetUp ? <p className="text-xs text-amber-700">Set up finance (apply a chart of accounts) before adding payment methods: each one posts to a G/L account.</p> : null}
            {methods.length === 0 && !form ? <p className="text-sm text-fg-muted">No payment methods yet.</p> : null}
            {form ? <PaymentMethodForm setup={setup} providerId={p.id} providerName={p.label} method={form.method} onCancel={() => setForm(null)} onDone={(t) => { setForm(null); onChanged(t); }} /> : null}
            <ul className="divide-y divide-line">
              {methods.map((m) => (
                <li key={m.id} className="space-y-2 py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-fg-strong">{m.name} <span className="font-normal text-fg-muted">· {m.code}</span> {!m.enabled ? <Chip tone="gray">Off</Chip> : null}</p>
                      <p className="text-xs text-fg-muted">{KIND_WORDS[m.kind] ?? m.kind} · {m.branchName ?? 'every branch'} · {m.bankLabel} · posts to {m.glLabel}{m.channelNumber ? ` · ${m.channelKind ?? 'number'} ${m.channelNumber}` : ''}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {can.editMethod ? <button type="button" className={buttonClass} onClick={() => setForm({ method: m })} aria-label={`Edit ${m.name}`}>Edit</button> : null}
                      {can.disableMethod ? <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run('m' + m.id, m.enabled ? `${m.name} switched off.` : `${m.name} switched on.`, () => setPaymentMethodEnabledAction(m.id, !m.enabled))} aria-label={`${m.enabled ? 'Switch off' : 'Switch on'} ${m.name}`}>{m.enabled ? 'Switch off' : 'Switch on'}</button> : null}
                      {can.deleteMethod ? (confirm === m.id
                        ? <><button type="button" className={dangerClass} onClick={() => void run('d' + m.id, 'Deleted.', async () => { setConfirm(null); return deletePaymentMethodAction(m.id); })}>Yes, delete</button><button type="button" className={buttonClass} onClick={() => setConfirm(null)}>Keep</button></>
                        : <button type="button" className={dangerClass} onClick={() => setConfirm(m.id)} aria-label={`Delete ${m.name}`}>Delete</button>) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
