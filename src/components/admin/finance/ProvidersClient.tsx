'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  saveProviderAction,
  setProviderCredentialsAction,
  setProviderEnabledAction,
  testProviderAction,
  type listProvidersAction,
} from '@/server/domains/finance/receivables/actions';
import { Chip, Field, Message, PageHeader, buttonClass, cardClass, fieldClass, primaryClass, type Notice, attempt } from './ui';

type View = Extract<Awaited<ReturnType<typeof listProvidersAction>>, { ok: true }>['data'];
type Provider = View['providers'][number];

/** The secret values each provider needs. They are written to the vault and never read back. */
const CREDENTIAL_FIELDS: Record<string, { key: string; label: string; multiline?: boolean }[]> = {
  mpesa_daraja: [
    { key: 'consumerKey', label: 'Consumer key' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'shortcode', label: 'Business shortcode (paybill or till)' },
    { key: 'passkey', label: 'Lipa na M-Pesa passkey' },
  ],
  pesapal_v3: [
    { key: 'consumerKey', label: 'Consumer key' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'ipnId', label: 'IPN id (optional)' },
  ],
  jenga_hq: [
    { key: 'merchantCode', label: 'Merchant code' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'apiKey', label: 'API key' },
    { key: 'privateKeyPem', label: 'Private key (PEM)', multiline: true },
  ],
  kcb_buni: [
    { key: 'consumerKey', label: 'Consumer key' },
    { key: 'consumerSecret', label: 'Consumer secret' },
    { key: 'orgShortCode', label: 'Organisation shortcode' },
    { key: 'orgPassKey', label: 'Organisation passkey (optional)' },
  ],
};

const CAPABILITY_LABEL: Record<string, string> = {
  collect: 'Collect payments',
  payout: 'Pay out',
  reverse: 'Reverse',
  status_query: 'Status check',
  register_urls: 'Register URLs',
  balance: 'Account balance',
  statement: 'Statements',
};

function ProviderCard({ p, can }: { p: Provider; can: View['can'] }) {
  const uid = useId();
  const router = useRouter();
  const [busy, setBusy] = useState<'save' | 'creds' | 'test' | 'enable' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [env, setEnv] = useState(p.environment);
  const [url, setUrl] = useState(p.apiBaseUrl);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const fields = CREDENTIAL_FIELDS[p.providerCode] ?? [];
  const done = (kind: Notice) => {
    setNotice(kind);
    router.refresh();
  };

  const saveConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save');
    const res = await attempt(saveProviderAction({ id: p.id, environment: env, apiBaseUrl: url }));
    setBusy(null);
    done(res.ok ? { kind: 'ok', text: 'Connection saved. Run "Test connection" again.' } : { kind: 'error', text: res.error });
  };
  const saveCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('creds');
    const res = await attempt(setProviderCredentialsAction(p.id, creds));
    setBusy(null);
    if (res.ok) setCreds({});
    done(res.ok ? { kind: 'ok', text: 'Credentials saved. They are stored sealed and cannot be shown again.' } : { kind: 'error', text: res.error });
  };
  const test = async () => {
    setBusy('test');
    const res = await attempt(testProviderAction(p.id));
    setBusy(null);
    done(res.ok ? { kind: res.data.ok ? 'ok' : 'error', text: res.data.message } : { kind: 'error', text: res.error });
  };
  const toggle = async () => {
    setBusy('enable');
    const res = await attempt(setProviderEnabledAction(p.id, !p.isEnabled));
    setBusy(null);
    done(res.ok ? { kind: 'ok', text: p.isEnabled ? `${p.label} is switched off.` : `${p.label} is live.` } : { kind: 'error', text: res.error });
  };

  return (
    <li className={`${cardClass} space-y-4`} aria-labelledby={`${uid}-h`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`${uid}-h`} className="text-sm font-bold text-fg-strong">{p.label} <span className="font-normal text-fg-muted">· {p.branchName}</span></h3>
          <p className="text-xs text-fg-muted">{p.description}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {p.isEnabled ? <Chip tone="green">Live</Chip> : <Chip tone="gray">Off</Chip>}
          <Chip tone={p.environment === 'production' ? 'amber' : 'sky'}>{p.environment === 'production' ? 'Production' : 'Sandbox'}</Chip>
          {p.hasCredentials ? <Chip tone="green">Credentials saved</Chip> : <Chip tone="red">No credentials</Chip>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1" aria-label="What this provider can do here">
        {p.capabilities.map((c) => <Chip key={c} tone="gray">{CAPABILITY_LABEL[c] ?? c}</Chip>)}
      </div>

      <form onSubmit={saveConnection} className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label={`Connection for ${p.label}`}>
        <Field id={`${uid}-env`} label="Environment">
          <select id={`${uid}-env`} value={env} onChange={(e) => setEnv(e.target.value as typeof env)} className={fieldClass} disabled={!can.edit}>
            <option value="staging">Sandbox / staging</option>
            <option value="production">Production</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field id={`${uid}-url`} label="Provider address (base URL)" hint="Must start with https://.">
            <input id={`${uid}-url`} value={url} onChange={(e) => setUrl(e.target.value)} className={fieldClass} disabled={!can.edit} inputMode="url" autoComplete="off" />
          </Field>
        </div>
        {can.edit ? (
          <div className="sm:col-span-3">
            <button type="submit" className={buttonClass} disabled={busy !== null || (env === p.environment && url === p.apiBaseUrl)}>Save connection</button>
          </div>
        ) : null}
      </form>

      {can.setCredentials ? (
        <form onSubmit={saveCreds} className="space-y-3" aria-label={`Credentials for ${p.label}`}>
          <p className="text-xs text-fg-muted">
            Secrets are sealed when saved and are never shown again. Leave a box empty to keep what is saved.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <Field key={f.key} id={`${uid}-c-${f.key}`} label={f.label}>
                {f.multiline ? (
                  <textarea
                    id={`${uid}-c-${f.key}`}
                    value={creds[f.key] ?? ''}
                    onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                    className={`${fieldClass} min-h-24 font-mono text-xs`}
                    placeholder={p.maskedCredentials?.[f.key] || 'Not saved'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                ) : (
                  <input
                    id={`${uid}-c-${f.key}`}
                    type="password"
                    value={creds[f.key] ?? ''}
                    onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })}
                    className={fieldClass}
                    placeholder={p.maskedCredentials?.[f.key] || 'Not saved'}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                )}
              </Field>
            ))}
          </div>
          <button type="submit" className={buttonClass} disabled={busy !== null || Object.values(creds).every((v) => !v.trim())}>Save credentials</button>
        </form>
      ) : null}

      <div className="space-y-1 text-xs">
        <p className="font-semibold text-fg">Callback address to register with the provider</p>
        {p.callbackUrl ? (
          <p className="break-all rounded-lg border border-line bg-surface-sunken p-2 font-mono text-[11px] text-fg-strong">{p.callbackUrl}</p>
        ) : (
          <p className="text-amber-700">Set the public address of this system first, so the exact callback address can be shown.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        {can.test ? <button type="button" className={primaryClass} disabled={busy !== null || !p.hasCredentials} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button> : null}
        {can.enable ? (
          <button type="button" className={buttonClass} disabled={busy !== null || (!p.isEnabled && p.lastTestOk !== true)} onClick={toggle} aria-label={`${p.isEnabled ? 'Switch off' : 'Switch on'} ${p.label}`}>
            {p.isEnabled ? 'Switch off' : 'Switch on'}
          </button>
        ) : null}
        <p className="text-xs text-fg-muted" aria-live="polite">
          {p.lastTestAt
            ? `Last test ${new Date(p.lastTestAt).toLocaleString()}: ${p.lastTestOk ? 'worked' : 'failed'}${p.lastTestOk ? '' : ` — ${p.lastTestMessage ?? ''}`}`
            : 'Not tested yet. A provider can be switched on only after a successful test.'}
        </p>
      </div>
      <Message notice={notice} />
    </li>
  );
}

export function ProvidersClient({ view }: { view: View }) {
  const httpsOk = view.publicBaseUrl ? /^https:\/\//i.test(view.publicBaseUrl) : false;
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title="Payment providers"
        intro="Connections to outside payment services. A provider holds credentials and addresses only; it has no accounting. Payment methods (your rules) point at a provider when one collects the money."
      />
      <div className={`${cardClass} text-sm`}>
        <p className="font-semibold text-fg-strong">Public address of this system</p>
        {view.publicBaseUrl ? (
          <p className="mt-1 break-all text-fg">
            {view.publicBaseUrl} {httpsOk ? null : <span className="text-amber-700">— providers need an https:// address to send payment confirmations.</span>}
          </p>
        ) : (
          <p className="mt-1 text-amber-700">Not set. Payment confirmations cannot reach this system until it is. Set it under Settings → Company.</p>
        )}
      </div>
      {view.providers.length === 0 ? (
        <p className="text-sm text-fg-muted">No provider accounts yet. They are created for each branch under Settings → Branches.</p>
      ) : (
        <ul className="space-y-4">
          {view.providers.map((p) => <ProviderCard key={p.id} p={p} can={view.can} />)}
        </ul>
      )}
    </div>
  );
}
