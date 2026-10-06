'use client';

import { useId, useState, useTransition } from 'react';
import type { KraConfigInput, KraConfigView } from '@/server/domains/kra/actions';
import {
  SIGNING_MODULES,
  SIGNING_MODULE_LABELS,
  type ModuleSigning,
  type SigningModule,
} from '@/server/domains/kra/signing/types';

const fieldClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

const MODES = [
  {
    value: 'etims' as const,
    title: 'eTIMS',
    blurb: 'Invoices are sent to KRA online through the eTIMS gateway.',
  },
  {
    value: 'tims' as const,
    title: 'TIMS',
    blurb: 'Invoices are signed by a Tremol control unit through ZFPLabServer.',
  },
];

function toInput(view: KraConfigView | null): KraConfigInput {
  return {
    mode: view?.mode ?? 'etims',
    isEnabled: view?.isEnabled ?? false,
    environment: view?.environment ?? 'sandbox',
    apiBaseUrl: view?.apiBaseUrl ?? '',
    username: view?.username ?? '',
    password: '',
    zfpLabServerUrl: view?.zfpLabServerUrl ?? '',
    connection: view?.connection ?? 'tcp',
    cuSerial: view?.cuSerial ?? '',
    allowEtimsSigning: view?.allowEtimsSigning ?? false,
    allowTimsSigning: view?.allowTimsSigning ?? false,
    moduleSigning: view?.moduleSigning ?? {},
  };
}

interface KraConfigFormProps {
  initial: KraConfigView | null;
  onSave: (input: KraConfigInput) => Promise<KraConfigView>;
  /** Shown in the heading, e.g. "Company" or a branch name. */
  label: string;
  /** Called after a successful save, with the stored config. */
  onSaved?: (saved: KraConfigView) => void;
  /**
   * Company: each module is simply on or off. Branch: each module can also inherit the
   * company's setting, which is shown as `companyModuleSigning`.
   */
  scope: 'company' | 'branch';
  companyModuleSigning?: ModuleSigning;
}

export function KraConfigForm({
  initial,
  onSave,
  label,
  onSaved,
  scope,
  companyModuleSigning = {},
}: KraConfigFormProps) {
  const uid = useId();
  const [saved, setSaved] = useState<KraConfigView | null>(initial);
  const [form, setForm] = useState<KraConfigInput>(() => toInput(initial));
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof KraConfigInput>(key: K, value: KraConfigInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      try {
        setMessage(null);
        const next = await onSave(form);
        setSaved(next);
        setForm(toInput(next));
        setMessage({ kind: 'ok', text: `${label} KRA mode saved.` });
        onSaved?.(next);
      } catch (err) {
        setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed.' });
      }
    });
  };

  const id = (name: string) => `${uid}-${name}`;

  /** Branch tri-state: '' inherits the company's value, otherwise an explicit on/off. */
  const setModule = (module: SigningModule, value: '' | 'on' | 'off') =>
    setForm((prev) => {
      const next = { ...prev.moduleSigning };
      if (value === '') delete next[module];
      else next[module] = value === 'on';
      return { ...prev, moduleSigning: next };
    });

  return (
    <form onSubmit={submit} className="space-y-5" aria-label={`${label} KRA mode`}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-fg">Mode</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={`flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                form.mode === m.value
                  ? 'border-indigo-500 bg-indigo-600/15'
                  : 'border-line-strong bg-surface-sunken/60 text-fg-muted'
              }`}
            >
              <input
                type="radio"
                name={id('mode')}
                value={m.value}
                checked={form.mode === m.value}
                onChange={() => set('mode', m.value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-semibold text-fg-strong">{m.title}</span>
                <span className="block text-xs text-fg-muted">{m.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={id('env')} className="mb-1 block text-xs font-semibold text-fg">
            Environment
          </label>
          <select
            id={id('env')}
            value={form.environment}
            onChange={(e) => set('environment', e.target.value as KraConfigInput['environment'])}
            className={fieldClass}
          >
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </div>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 self-end text-sm text-fg">
          <input
            type="checkbox"
            checked={form.isEnabled}
            onChange={(e) => set('isEnabled', e.target.checked)}
          />
          Enabled
        </label>
      </div>

      {form.mode === 'etims' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={id('url')} className="mb-1 block text-xs font-semibold text-fg">
              eTIMS gateway URL
            </label>
            <input
              id={id('url')}
              type="url"
              inputMode="url"
              placeholder="https://gateway.example/api/v1"
              value={form.apiBaseUrl}
              onChange={(e) => set('apiBaseUrl', e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={id('user')} className="mb-1 block text-xs font-semibold text-fg">
              Username
            </label>
            <input
              id={id('user')}
              autoComplete="off"
              value={form.username}
              onChange={(e) => set('username', e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={id('pass')} className="mb-1 block text-xs font-semibold text-fg">
              Password
            </label>
            <input
              id={id('pass')}
              type="password"
              autoComplete="new-password"
              placeholder={saved?.hasPassword ? 'Saved — leave blank to keep' : ''}
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={id('zfp')} className="mb-1 block text-xs font-semibold text-fg">
              ZFPLabServer URL
            </label>
            <input
              id={id('zfp')}
              type="url"
              inputMode="url"
              placeholder="http://localhost:4444"
              value={form.zfpLabServerUrl}
              onChange={(e) => set('zfpLabServerUrl', e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={id('conn')} className="mb-1 block text-xs font-semibold text-fg">
              Device connection
            </label>
            <select
              id={id('conn')}
              value={form.connection}
              onChange={(e) => set('connection', e.target.value as 'tcp' | 'com')}
              className={fieldClass}
            >
              <option value="tcp">TCP / IP</option>
              <option value="com">Serial (COM)</option>
            </select>
          </div>
          <div>
            <label htmlFor={id('cu')} className="mb-1 block text-xs font-semibold text-fg">
              Control unit serial
            </label>
            <input
              id={id('cu')}
              autoComplete="off"
              value={form.cuSerial}
              onChange={(e) => set('cuSerial', e.target.value)}
              className={`${fieldClass} font-mono`}
            />
          </div>
        </div>
      )}

      <fieldset className="space-y-4 rounded-lg border border-line p-4">
        <legend className="px-1 text-xs font-semibold text-fg">Signing with KRA</legend>
        <p className="text-xs text-fg-muted">
          Nothing is sent to KRA unless signing is explicitly allowed here. Each of these is off
          until you turn it on, and a customer set to opt out is never signed.
        </p>

        <div className="space-y-1">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={form.allowEtimsSigning}
              onChange={(e) => set('allowEtimsSigning', e.target.checked)}
            />
            Allow signing invoices with eTIMS
          </label>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={form.allowTimsSigning}
              onChange={(e) => set('allowTimsSigning', e.target.checked)}
            />
            Allow signing invoices with TIMS
          </label>
          <p className="text-[11px] text-fg-muted">
            Only the switch matching the mode above is used. Changing the mode never turns signing
            on by itself.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-fg">Sign invoices from</p>
          <div className="divide-y divide-line/60">
            {SIGNING_MODULES.map((module) => {
              const value = form.moduleSigning[module];
              const inherited = companyModuleSigning[module] === true ? 'on' : 'off';
              return (
                <div
                  key={module}
                  className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  {scope === 'company' ? (
                    <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={value === true}
                        onChange={(e) => setModule(module, e.target.checked ? 'on' : 'off')}
                      />
                      {SIGNING_MODULE_LABELS[module]}
                    </label>
                  ) : (
                    <>
                      <label htmlFor={id(`mod-${module}`)} className="text-sm text-fg">
                        {SIGNING_MODULE_LABELS[module]}
                      </label>
                      <select
                        id={id(`mod-${module}`)}
                        value={value === undefined ? '' : value ? 'on' : 'off'}
                        onChange={(e) => setModule(module, e.target.value as '' | 'on' | 'off')}
                        className={`${fieldClass} sm:w-64`}
                      >
                        <option value="">Use company setting ({inherited})</option>
                        <option value="on">On for this branch</option>
                        <option value="off">Off for this branch</option>
                      </select>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-fg-muted">
            Quotes only ever produce proforma invoices, which are never signed. A quote is signed
            once it becomes a sales order.
          </p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <p
          role={message?.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`text-sm ${message?.kind === 'error' ? 'text-red-600' : 'text-emerald-600'}`}
        >
          {message?.text}
        </p>
      </div>
    </form>
  );
}
