'use client';

import { useId, useState } from 'react';
import type { KraConfigInput, KraConfigView } from '@/server/domains/kra/actions';
import type { SettingsResult } from '@/server/domains/settings/action-runner';
import { SIGNING_MODULES, SIGNING_MODULE_LABELS, type ModuleSigning, type SigningModule } from '@/server/domains/kra/signing/types';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { attempt, Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { CONNECTIONS, ENVIRONMENTS, inheritedWords, kraFormFrom, labelOfConnection, labelOfEnvironment, moduleChoiceOf, moduleChoices, MODES, withModuleSigning, type ModuleChoice } from '@/lib/kra-forms';

interface KraConfigFormProps {
  initial: KraConfigView | null;
  onSave: (input: KraConfigInput) => Promise<SettingsResult<KraConfigView>>;
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

export function KraConfigForm({ initial, onSave, label, onSaved, scope, companyModuleSigning = {} }: KraConfigFormProps) {
  const uid = useId();
  const [saved, setSaved] = useState<KraConfigView | null>(initial);
  const [form, setForm] = useState<KraConfigInput>(() => kraFormFrom(initial));
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof KraConfigInput>(key: K, value: KraConfigInput[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const id = (name: string) => `${uid}-${name}`;

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await attempt(onSave(form));
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.error });
      return;
    }
    setSaved(res.data);
    setForm(kraFormFrom(res.data));
    setMessage({ kind: 'ok', text: `${label} KRA mode saved.` });
    onSaved?.(res.data);
  };

  const setModule = (module: SigningModule, choice: ModuleChoice) => setForm((prev) => ({ ...prev, moduleSigning: withModuleSigning(prev.moduleSigning, module, choice) }));

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5" aria-label={`${label} KRA mode`}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-fg">Mode</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MODES.map((m) => (
            <label key={m.value} className={`flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border p-3 ${form.mode === m.value ? 'border-indigo-500 bg-indigo-600/15' : 'border-line-strong bg-surface-sunken/60 text-fg-muted'}`}>
              <input type="radio" name={id('mode')} value={m.value} checked={form.mode === m.value} onChange={() => set('mode', m.value)} className="mt-1" />
              <span>
                <span className="block text-sm font-semibold text-fg-strong">{m.title}</span>
                <span className="block text-xs text-fg-muted">{m.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ChoicePicker
          label="Environment"
          source="kra-environments"
          choice={{ id: form.environment, label: labelOfEnvironment(form.environment) }}
          onChoice={(c) => set('environment', (ENVIRONMENTS.find((e) => e.id === c?.id)?.id ?? form.environment))}
          clearable={false}
        />
        <label className="flex min-h-10 cursor-pointer items-center gap-2 self-end text-sm text-fg">
          <input type="checkbox" checked={form.isEnabled} onChange={(e) => set('isEnabled', e.target.checked)} />
          Enabled
        </label>
      </div>

      {form.mode === 'etims' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field id={id('url')} label="eTIMS gateway URL">
              <input id={id('url')} type="url" inputMode="url" placeholder="https://gateway.example/api/v1" value={form.apiBaseUrl} onChange={(e) => set('apiBaseUrl', e.target.value)} className={fieldClass} />
            </Field>
          </div>
          <Field id={id('user')} label="Username">
            <input id={id('user')} autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} className={fieldClass} />
          </Field>
          <Field id={id('pass')} label="Password">
            <input id={id('pass')} type="password" autoComplete="new-password" placeholder={saved?.hasPassword === true ? 'Saved — leave blank to keep' : ''} value={form.password} onChange={(e) => set('password', e.target.value)} className={fieldClass} />
          </Field>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field id={id('zfp')} label="ZFPLabServer URL">
              <input id={id('zfp')} type="url" inputMode="url" placeholder="http://localhost:4444" value={form.zfpLabServerUrl} onChange={(e) => set('zfpLabServerUrl', e.target.value)} className={fieldClass} />
            </Field>
          </div>
          <ChoicePicker
            label="Device connection"
            source="kra-connections"
            choice={{ id: form.connection, label: labelOfConnection(form.connection) }}
            onChoice={(c) => set('connection', (CONNECTIONS.find((x) => x.id === c?.id)?.id ?? form.connection))}
            clearable={false}
          />
          <Field id={id('cu')} label="Control unit serial">
            <input id={id('cu')} autoComplete="off" value={form.cuSerial} onChange={(e) => set('cuSerial', e.target.value)} className={`${fieldClass} font-mono`} />
          </Field>
        </div>
      )}

      <fieldset className="space-y-4 rounded-lg border border-line p-4">
        <legend className="px-1 text-xs font-semibold text-fg">Signing with KRA</legend>
        <p className="text-xs text-fg-muted">Nothing is sent to KRA unless signing is explicitly allowed here. Each of these is off until you turn it on, and a customer set to opt out is never signed.</p>

        <div className="space-y-1">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="h-5 w-5" checked={form.allowEtimsSigning} onChange={(e) => set('allowEtimsSigning', e.target.checked)} />
            Allow signing invoices with eTIMS
          </label>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="h-5 w-5" checked={form.allowTimsSigning} onChange={(e) => set('allowTimsSigning', e.target.checked)} />
            Allow signing invoices with TIMS
          </label>
          <p className="text-[11px] text-fg-muted">Only the switch matching the mode above is used. Changing the mode never turns signing on by itself.</p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-fg">Sign invoices from</p>
          <div className="divide-y divide-line/60">
            {SIGNING_MODULES.map((module) => {
              const value = form.moduleSigning[module];
              const inherited = inheritedWords(companyModuleSigning[module]);
              return (
                <div key={module} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                  {scope === 'company' ? (
                    <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                      <input type="checkbox" className="h-5 w-5" checked={value === true} onChange={(e) => setModule(module, e.target.checked ? 'on' : 'off')} />
                      {SIGNING_MODULE_LABELS[module]}
                    </label>
                  ) : (
                    <>
                      <span className="text-sm text-fg">{SIGNING_MODULE_LABELS[module]}</span>
                      <div className="sm:w-72">
                        <ChoicePicker
                          label={`${SIGNING_MODULE_LABELS[module]} signing for this branch`}
                          source="kra-module-signing"
                          filters={{ inherited }}
                          choice={{ id: moduleChoiceOf(value), label: moduleChoices(inherited).find((c) => c.id === moduleChoiceOf(value))?.label ?? '' }}
                          onChoice={(c) => setModule(module, (c?.id ?? '') as ModuleChoice)}
                          clearable={false}
                          hideLabel
                        />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-fg-muted">Quotes only ever produce proforma invoices, which are never signed. A quote is signed once it becomes a sales order.</p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={primaryClass}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <p role={message?.kind === 'error' ? 'alert' : 'status'} aria-live="polite" className={`text-sm ${message?.kind === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
          {message?.text}
        </p>
      </div>
    </form>
  );
}
