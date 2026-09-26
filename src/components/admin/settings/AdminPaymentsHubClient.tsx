'use client';

import React, { use, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { Wallet, Save, CheckCircle2, XCircle, ChevronDown } from 'lucide-react';
import type { BranchRow } from '@/server/db/drizzle/schema';
import type { PaymentConfigAdminView } from '@/server/domains/payments/actions';
import {
  listPaymentConfigsAction,
  savePaymentConfigAction,
  updateCompanyPublicBaseUrlAction,
} from '@/server/domains/payments/actions';
import {
  PAYMENT_PROVIDER_META,
  type PaymentProviderCode,
  type PaymentProviderEnvironment,
} from '@/server/domains/payments/types';

const CREDENTIAL_FIELDS: Record<
  PaymentProviderCode,
  { key: string; label: string; textarea?: boolean; placeholder?: string }[]
> = {
  mpesa_daraja: [
    { key: 'consumerKey', label: 'Consumer Key' },
    { key: 'consumerSecret', label: 'Consumer Secret' },
    { key: 'shortcode', label: 'Shortcode (Paybill / Till)' },
    { key: 'passkey', label: 'Passkey' },
  ],
  pesapal_v3: [
    { key: 'consumerKey', label: 'Consumer Key' },
    { key: 'consumerSecret', label: 'Consumer Secret' },
    { key: 'ipnId', label: 'IPN ID (optional)' },
  ],
  jenga_hq: [
    { key: 'merchantCode', label: 'Merchant Code' },
    { key: 'consumerSecret', label: 'Consumer Secret' },
    { key: 'apiKey', label: 'API Key' },
    {
      key: 'privateKeyPem',
      label: 'RSA Private Key (PEM)',
      textarea: true,
      placeholder: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
    },
  ],
  kcb_buni: [
    { key: 'consumerKey', label: 'Consumer Key' },
    { key: 'consumerSecret', label: 'Consumer Secret' },
    { key: 'orgShortCode', label: 'Org Short Code' },
    { key: 'orgPassKey', label: 'Org Pass Key (optional)' },
    { key: 'invoiceNumber', label: 'Invoice / Account Number (optional)' },
  ],
};

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

type ProviderDraft = {
  isEnabled: boolean;
  environment: PaymentProviderEnvironment;
  apiBaseUrl: string;
  credValues: Record<string, string>;
  message: string | null;
  error: string | null;
};

function emptyDraft(
  config: PaymentConfigAdminView | undefined,
  code: PaymentProviderCode,
): ProviderDraft {
  const meta = PAYMENT_PROVIDER_META[code];
  const environment = config?.environment ?? 'staging';
  return {
    isEnabled: config?.isEnabled ?? false,
    environment,
    apiBaseUrl:
      config?.apiBaseUrl ||
      (environment === 'production' ? meta.defaultProductionBaseUrl : meta.defaultStagingBaseUrl),
    credValues: {},
    message: null,
    error: null,
  };
}

function ProviderPanel({
  code,
  config,
  branchId,
  open,
  onToggle,
  draft,
  onChange,
  onSaved,
}: {
  code: PaymentProviderCode;
  config: PaymentConfigAdminView | undefined;
  branchId: string;
  open: boolean;
  onToggle: () => void;
  draft: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  onSaved: () => void;
}) {
  const meta = PAYMENT_PROVIDER_META[code];
  const fields = CREDENTIAL_FIELDS[code];
  const [pending, startTransition] = useTransition();

  const handleSave = () => {
    startTransition(async () => {
      try {
        onChange({ ...draft, error: null, message: null });
        await savePaymentConfigAction({
          branchId,
          providerCode: code,
          isEnabled: draft.isEnabled,
          environment: draft.environment,
          apiBaseUrl: draft.apiBaseUrl,
          credentials: Object.keys(draft.credValues).length ? draft.credValues : null,
        });
        onChange({
          ...draft,
          credValues: {},
          error: null,
          message: 'Saved. Credentials are encrypted at rest.',
        });
        onSaved();
      } catch (err) {
        onChange({
          ...draft,
          message: null,
          error: err instanceof Error ? err.message : 'Save failed',
        });
      }
    });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface-sunken/50">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover/80"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-fg-strong">{meta.label}</h3>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                draft.isEnabled
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-surface-sunken text-fg-muted'
              }`}
            >
              {draft.isEnabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-fg-muted">
              {draft.environment}
            </span>
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-fg-muted">
              {config?.hasCredentials ? 'Credentials set' : 'No credentials'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-subtle">{meta.description}</p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-fg-subtle transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open ? (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-fg-muted">
                Environment
              </label>
              <select
                value={draft.environment}
                onChange={(e) => {
                  const environment = e.target.value as PaymentProviderEnvironment;
                  onChange({
                    ...draft,
                    environment,
                    apiBaseUrl:
                      environment === 'production'
                        ? meta.defaultProductionBaseUrl
                        : meta.defaultStagingBaseUrl,
                  });
                }}
                className={fieldClass}
              >
                <option value="staging">Staging / UAT</option>
                <option value="production">Production</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-fg-muted">
                API base URL
              </label>
              <input
                value={draft.apiBaseUrl}
                onChange={(e) => onChange({ ...draft, apiBaseUrl: e.target.value })}
                className={`${fieldClass} font-mono text-xs`}
                placeholder="https://…"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-fg sm:col-span-2">
              <input
                type="checkbox"
                checked={draft.isEnabled}
                onChange={(e) => onChange({ ...draft, isEnabled: e.target.checked })}
                className="rounded border-line-strong"
              />
              Enable for this branch (shown at checkout when enabled)
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-fg-strong">Credentials</h4>
              {config?.hasCredentials ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Saved (masked)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-600">
                  <XCircle className="h-3.5 w-3.5" /> Not configured
                </span>
              )}
            </div>
            <p className="text-[11px] text-fg-subtle">
              Leave a field blank to keep the existing secret. Enter a new value only when rotating.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <div key={f.key} className={f.textarea ? 'sm:col-span-2' : ''}>
                  <label className="mb-1 block text-[11px] font-semibold text-fg-muted">
                    {f.label}
                    {config?.maskedCredentials?.[f.key] ? (
                      <span className="ml-2 font-mono font-normal text-fg-faint">
                        current: {config.maskedCredentials[f.key]}
                      </span>
                    ) : null}
                  </label>
                  {f.textarea ? (
                    <textarea
                      rows={5}
                      value={draft.credValues[f.key] || ''}
                      onChange={(e) =>
                        onChange({
                          ...draft,
                          credValues: { ...draft.credValues, [f.key]: e.target.value },
                        })
                      }
                      placeholder={f.placeholder || 'Paste new value to update'}
                      className={`${fieldClass} font-mono text-xs`}
                    />
                  ) : (
                    <input
                      type="password"
                      autoComplete="off"
                      value={draft.credValues[f.key] || ''}
                      onChange={(e) =>
                        onChange({
                          ...draft,
                          credValues: { ...draft.credValues, [f.key]: e.target.value },
                        })
                      }
                      placeholder="Enter new value to update"
                      className={`${fieldClass} font-mono`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {draft.error ? (
            <div className="rounded-lg border border-red-800 bg-red-50 px-3 py-2 text-xs text-red-800">
              {draft.error}
            </div>
          ) : null}
          {draft.message ? (
            <div className="rounded-lg border border-emerald-800 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              {draft.message}
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleSave}
            disabled={pending || !branchId}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {pending ? 'Saving…' : `Save ${meta.label}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function AdminPaymentsHubClient({
  branchesPromise,
  configsPromise,
  publicBaseUrl,
  providers,
}: {
  branchesPromise: Promise<BranchRow[]>;
  configsPromise: Promise<PaymentConfigAdminView[]>;
  publicBaseUrl: string | null;
  providers: PaymentProviderCode[];
}) {
  const branches = use(branchesPromise);
  const initialConfigs = use(configsPromise);
  const [configs, setConfigs] = useState(initialConfigs);
  const [branchId, setBranchId] = useState(
    branches.find((b) => b.isDefault)?.id || branches[0]?.id || '',
  );
  const [baseUrl, setBaseUrl] = useState(publicBaseUrl || '');
  const [urlMsg, setUrlMsg] = useState<string | null>(null);
  const [urlPending, startUrlTransition] = useTransition();
  const [openCode, setOpenCode] = useState<PaymentProviderCode | null>(providers[0] ?? null);
  const [drafts, setDrafts] = useState<Record<PaymentProviderCode, ProviderDraft>>(() => {
    const next = {} as Record<PaymentProviderCode, ProviderDraft>;
    const defaultBranch = branches.find((b) => b.isDefault)?.id || branches[0]?.id || '';
    for (const code of providers) {
      const cfg = initialConfigs.find(
        (c) => c.branchId === defaultBranch && c.providerCode === code,
      );
      next[code] = emptyDraft(cfg, code);
    }
    return next;
  });

  useEffect(() => {
    setDrafts(() => {
      const next = {} as Record<PaymentProviderCode, ProviderDraft>;
      for (const code of providers) {
        const cfg = configs.find((c) => c.branchId === branchId && c.providerCode === code);
        next[code] = emptyDraft(cfg, code);
      }
      return next;
    });
    // Rebuild drafts only when switching branch — not after every config refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: branch-scoped reset
  }, [branchId, providers]);

  const refreshConfigs = async () => {
    setConfigs(await listPaymentConfigsAction());
  };

  if (!branchId) {
    return (
      <p className="text-sm text-fg-muted">
        Create a branch first under{' '}
        <Link href="/admin/settings/branches" className="text-indigo-400 hover:underline">
          Settings → Branches
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
          <Wallet className="h-5 w-5 text-indigo-400" />
          Payments
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Configure all payment providers for a branch on this page. Callback URLs use a unique
          UUIDv7 per payment attempt — set the public base URL below.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-line bg-surface-sunken/50 p-4">
        <label className="block text-[11px] font-semibold text-fg-muted">
          Company public base URL (for callbacks)
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-staging-host.example"
            className={`${fieldClass} font-mono`}
          />
          <button
            type="button"
            disabled={urlPending}
            onClick={() =>
              startUrlTransition(async () => {
                await updateCompanyPublicBaseUrlAction(baseUrl);
                setUrlMsg('Public base URL saved');
              })
            }
            className="rounded-lg bg-surface-sunken px-4 py-2 text-sm font-semibold text-fg-strong hover:bg-hover"
          >
            Save URL
          </button>
        </div>
        {urlMsg ? <p className="text-[11px] text-emerald-600">{urlMsg}</p> : null}
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-semibold text-fg-muted">Branch</label>
        <select
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
          className={`${fieldClass} max-w-md`}
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
              {b.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-3">
        {providers.map((code) => (
          <ProviderPanel
            key={code}
            code={code}
            config={configs.find((c) => c.branchId === branchId && c.providerCode === code)}
            branchId={branchId}
            open={openCode === code}
            onToggle={() => setOpenCode((cur) => (cur === code ? null : code))}
            draft={drafts[code]}
            onChange={(next) => setDrafts((prev) => ({ ...prev, [code]: next }))}
            onSaved={() => {
              void refreshConfigs();
            }}
          />
        ))}
      </div>
    </div>
  );
}
