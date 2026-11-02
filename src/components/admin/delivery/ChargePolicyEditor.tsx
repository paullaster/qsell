'use client';

import { useId, useState } from 'react';
import { createChargePolicyDraftAction, saveChargePolicyDraftAction, type PolicySummary, type PolicyView } from '@/server/domains/delivery/policy-actions';
import { ChargeScopes } from './ChargeScopes';
import { ChargeBands, ChargeRateCard } from './ChargeRateCard';
import { ChargeSurcharges, ChargeTiers } from './ChargeExtras';
import { Field, Message, attempt, buttonClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { emptyPolicyForm, formFromPolicy, payloadFromForm, type PolicyForm } from '@/lib/charge-policy-form';
import { CHARGE_METHODS, CHARGE_METHOD_WORDS, DISTANCE_BASES, DISTANCE_BASIS_WORDS } from '@/server/domains/delivery/domain/types';

/** Writes a charge policy, or shows one that is in force or retired (which cannot be changed: a new version is written instead). */
export function ChargePolicyEditor({ policy, currency, onCancel, onSaved }: { policy: PolicyView | null; currency: string; onCancel: () => void; onSaved: (saved: PolicySummary) => void }) {
  const uid = useId();
  const [form, setForm] = useState<PolicyForm>(() => (policy === null ? emptyPolicyForm(currency) : formFromPolicy(policy, { zones: policy.zoneNames, scopes: policy.scopeNames })));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const readOnly = policy !== null && policy.status !== 'draft';
  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const payload = payloadFromForm(form);
    const res = await attempt(policy === null ? createChargePolicyDraftAction(form.code, payload) : saveChargePolicyDraftAction(policy.id, payload, policy.revision));
    setBusy(false);
    if (res.ok) onSaved(res.data);
    else setNotice({ kind: 'error', text: res.error });
  };

  const distance = form.method === 'distance';
  const saveWords = policy === null ? 'Save as draft' : 'Save changes';
  return (
    <form
      className="space-y-5"
      aria-label={policy === null ? 'New charge policy' : `${policy.code} version ${String(policy.version)}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly) void save();
      }}
    >
      <Message notice={notice} />
      {readOnly ? <p className="rounded-lg border border-line bg-surface-sunken p-3 text-xs text-fg">This policy is {policy.status === 'in_force' ? 'in force' : 'retired'} and cannot be changed, so every past charge can still be explained. To change it, make a new version.</p> : null}

      <fieldset className="space-y-3" disabled={readOnly || busy}>
        <legend className="text-xs font-semibold text-fg">The policy</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${uid}-code`} label="Code" hint={policy === null ? 'Short and unique, such as STANDARD. Versions share it.' : 'The code stays the same across versions.'}>
            <input id={`${uid}-code`} value={form.code} onChange={(e) => set('code', e.target.value)} className={fieldClass} maxLength={30} autoComplete="off" disabled={policy !== null} />
          </Field>
          <Field id={`${uid}-name`} label="Name">
            <input id={`${uid}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} className={fieldClass} maxLength={80} autoComplete="off" />
          </Field>
          <div className="sm:col-span-2">
            <Field id={`${uid}-description`} label="Description (optional)">
              <input id={`${uid}-description`} value={form.description} onChange={(e) => set('description', e.target.value)} className={fieldClass} maxLength={300} autoComplete="off" />
            </Field>
          </div>
          <Field id={`${uid}-currency`} label="Currency">
            <input id={`${uid}-currency`} value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} className={`${fieldClass} font-mono`} maxLength={3} autoComplete="off" />
          </Field>
          <Field id={`${uid}-priority`} label="Priority" hint="When two policies fit equally, the higher number wins.">
            <input id={`${uid}-priority`} inputMode="numeric" value={form.priority} onChange={(e) => set('priority', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-first`} label="First day it applies" hint="Empty: from today.">
            <input id={`${uid}-first`} type="date" value={form.firstDay} onChange={(e) => set('firstDay', e.target.value)} className={fieldClass} />
          </Field>
          <Field id={`${uid}-last`} label="Last day (optional)" hint="Empty: no end.">
            <input id={`${uid}-last`} type="date" value={form.lastDay} onChange={(e) => set('lastDay', e.target.value)} className={fieldClass} />
          </Field>
        </div>
      </fieldset>

      <ChargeScopes value={form.scopes} onChange={(next) => set('scopes', next)} disabled={readOnly || busy} />

      <fieldset className="space-y-3" disabled={readOnly || busy}>
        <legend className="text-xs font-semibold text-fg">How the charge is worked out</legend>
        <div role="radiogroup" aria-label="How the charge is worked out" className="grid gap-2 sm:grid-cols-3">
          {CHARGE_METHODS.map((m) => (
            <label key={m} className={`flex min-h-10 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${form.method === m ? 'border-indigo-500 bg-indigo-500/5' : 'border-line'}`}>
              <input type="radio" name={`${uid}-method`} className="mt-1" checked={form.method === m} onChange={() => set('method', m)} />
              <span>
                <span className="block font-semibold text-fg-strong">{CHARGE_METHOD_WORDS[m].name}</span>
                <span className="block text-xs text-fg-muted">{CHARGE_METHOD_WORDS[m].means}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {distance ? (
        <>
          <ChargeBands bands={form.bands} onChange={(next) => set('bands', next)} disabled={readOnly || busy} />
          <fieldset className="space-y-3" disabled={readOnly || busy}>
            <legend className="text-xs font-semibold text-fg">Measuring the distance</legend>
            <div role="radiogroup" aria-label="How the distance is measured" className="space-y-1">
              {DISTANCE_BASES.map((b) => (
                <label key={b} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input type="radio" name={`${uid}-basis`} checked={form.distanceBasis === b} onChange={() => set('distanceBasis', b)} />
                  {DISTANCE_BASIS_WORDS[b]}
                </label>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id={`${uid}-range`} label="Furthest distance (km)" hint="Empty: no limit. Measured one way.">
                <input id={`${uid}-range`} inputMode="decimal" value={form.maxRangeKm} onChange={(e) => set('maxRangeKm', e.target.value)} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-permin`} label="For each minute of travel" hint="Empty: not charged.">
                <input id={`${uid}-permin`} inputMode="decimal" value={form.perMinute} onChange={(e) => set('perMinute', e.target.value)} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-incl`} label="Weight carried free (kg)" hint="Empty: weight is not charged.">
                <input id={`${uid}-incl`} inputMode="decimal" value={form.includedKg} onChange={(e) => set('includedKg', e.target.value)} className={fieldClass} autoComplete="off" />
              </Field>
              <Field id={`${uid}-extra`} label="For each kg over that">
                <input id={`${uid}-extra`} inputMode="decimal" value={form.perExtraKg} onChange={(e) => set('perExtraKg', e.target.value)} className={fieldClass} autoComplete="off" />
              </Field>
            </div>
          </fieldset>
        </>
      ) : (
        <ChargeRateCard method={form.method} rates={form.rates} onChange={(next) => set('rates', next)} disabled={readOnly || busy} />
      )}

      <fieldset className="space-y-3" disabled={readOnly || busy}>
        <legend className="text-xs font-semibold text-fg">Limits and rounding</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id={`${uid}-min`} label="Least charge" hint="Empty: none.">
            <input id={`${uid}-min`} inputMode="decimal" value={form.minCharge} onChange={(e) => set('minCharge', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-max`} label="Most charge" hint="Empty: none.">
            <input id={`${uid}-max`} inputMode="decimal" value={form.maxCharge} onChange={(e) => set('maxCharge', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-heavy`} label="Heaviest order (kg)" hint="Empty: no limit.">
            <input id={`${uid}-heavy`} inputMode="decimal" value={form.maxWeightKg} onChange={(e) => set('maxWeightKg', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <Field id={`${uid}-round`} label="Round to" hint="Such as 10. Empty: no rounding.">
            <input id={`${uid}-round`} inputMode="decimal" value={form.roundTo} onChange={(e) => set('roundTo', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
        </div>
        <div role="radiogroup" aria-label="How the charge is rounded" className="flex flex-wrap gap-x-4">
          {(['nearest', 'up'] as const).map((mode) => (
            <label key={mode} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${uid}-roundmode`} checked={form.roundMode === mode} onChange={() => set('roundMode', mode)} />
              {mode === 'nearest' ? 'To the nearest' : 'Always up'}
            </label>
          ))}
        </div>
        <p className="text-xs text-fg-muted">The least and most charge must be multiples of the rounding unit, so rounding can never break them.</p>
      </fieldset>

      <fieldset className="space-y-3" disabled={readOnly || busy}>
        <legend className="text-xs font-semibold text-fg">Tax on the delivery charge</legend>
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field id={`${uid}-tax`} label="Tax rate (%)" hint="Such as 16 for VAT. Empty: no tax on delivery.">
            <input id={`${uid}-tax`} inputMode="decimal" value={form.taxRate} onChange={(e) => set('taxRate', e.target.value)} className={fieldClass} autoComplete="off" />
          </Field>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input type="checkbox" className="size-4" checked={form.taxInclusive} onChange={(e) => set('taxInclusive', e.target.checked)} />
            The amounts above already include the tax
          </label>
        </div>
        <p className="text-xs text-fg-muted">When the amounts do not include tax, the customer pays the charge plus the tax. When they do, the customer pays the charge as worked out and the tax is taken out of it. The tax is added to the order’s tax and shown on the invoice.</p>
      </fieldset>

      <ChargeTiers tiers={form.tiers} onChange={(next) => set('tiers', next)} disabled={readOnly || busy} />
      <ChargeSurcharges surcharges={form.surcharges} onChange={(next) => set('surcharges', next)} disabled={readOnly || busy} />

      <div className="flex flex-wrap gap-2">
        {readOnly ? null : (
          <button type="submit" className={primaryClass} disabled={busy}>
            {busy ? 'Saving…' : saveWords}
          </button>
        )}
        <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
      </div>
    </form>
  );
}
