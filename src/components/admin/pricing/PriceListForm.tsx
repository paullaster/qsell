'use client';

import { useId, useState } from 'react';
import { type PriceListFormInput,
  type PriceListView,
  type PricingLookups,
} from '@/server/domains/pricing/actions';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Notice,
  buttonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { useBusinessTimeZone } from '@/components/business-time';
import { fromBusinessInput, toBusinessInput } from '@/lib/visit';
import { ScopeEditor } from './ScopeEditor';

/** ISO time → the value a datetime-local input wants: the wall clock of the business's time zone, no seconds. */
export const toLocalInput = (iso: string | null | undefined, timeZone: string) => (iso === null || iso === undefined || iso === '' ? '' : toBusinessInput(iso, timeZone));
/** What was typed in a datetime-local input, read on the business's clock (not the browser's), as an instant. */
export const fromLocalInput = (v: string, timeZone: string) => (v === '' ? null : fromBusinessInput(v, timeZone));

export interface FormResult {
  ok: boolean;
  error?: string;
  issues?: { message: string }[];
}

/** The same form creates a list and changes one; the code, currency and kind are fixed after creation. */
export function PriceListForm({
  mode,
  initial,
  lookups,
  names,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: PriceListView;
  lookups: PricingLookups;
  names: Partial<Record<string, Record<string, string>>>;
  submitLabel: string;
  onSubmit: (values: PriceListFormInput, reason: ReasonValue) => Promise<FormResult>;
  onCancel?: () => void;
}) {
  const uid = useId();
  const timeZone = useBusinessTimeZone();
  const [v, setV] = useState({
    code: initial?.code ?? '',
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    kind: initial?.kind ?? ('list' as const),
    currency: initial?.currency ?? lookups.baseCurrency,
    taxInclusive: initial?.taxInclusive ?? true,
    quantityMode: initial?.quantityMode ?? ('all_units' as const),
    priority: initial?.priority ?? 0,
    validFrom: toLocalInput(initial?.validFrom, timeZone),
    validTo: toLocalInput(initial?.validTo, timeZone),
    scopes: initial?.scopes ?? {},
  });
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) =>
    setV((s) => ({ ...s, [k]: val }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await onSubmit(
      {
        code: v.code,
        name: v.name,
        description: v.description || null,
        kind: v.kind,
        currency: v.currency,
        taxInclusive: v.taxInclusive,
        quantityMode: v.quantityMode,
        priority: Number(v.priority) || 0,
        validFrom: fromLocalInput(v.validFrom, timeZone),
        validTo: fromLocalInput(v.validTo, timeZone),
        scopes: v.scopes,
      },
      reason,
    );
    setBusy(false);
    if (!r.ok) {
      const more = r.issues && r.issues.length > 1 ? ` (${r.issues.length} problems)` : '';
      setMessage({ kind: 'error', text: `${r.error ?? 'That did not work.'}${more}` });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {mode === 'create' ? (
          <div>
            <label htmlFor={`${uid}-code`} className={labelClass}>
              Code
            </label>
            <input
              id={`${uid}-code`}
              className={fieldClass}
              value={v.code}
              onChange={(e) => set('code', e.target.value)}
              placeholder="WHOLESALE-A"
              required
              maxLength={40}
            />
          </div>
        ) : null}
        <div>
          <label htmlFor={`${uid}-name`} className={labelClass}>
            Name
          </label>
          <input
            id={`${uid}-name`}
            className={fieldClass}
            value={v.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-desc`} className={labelClass}>
            Description (optional)
          </label>
          <input
            id={`${uid}-desc`}
            className={fieldClass}
            value={v.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </div>
        {mode === 'create' ? (
          <>
            <div>
              <label htmlFor={`${uid}-kind`} className={labelClass}>
                Kind
              </label>
              <select
                id={`${uid}-kind`}
                className={fieldClass}
                value={v.kind}
                onChange={(e) => set('kind', e.target.value as 'list' | 'contract')}
              >
                <option value="list">Price list</option>
                <option value="contract">Contract price (outranks every ordinary list)</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-cur`} className={labelClass}>
                Currency
              </label>
              <select
                id={`${uid}-cur`}
                className={fieldClass}
                value={v.currency}
                onChange={(e) => set('currency', e.target.value)}
              >
                {lookups.currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        <div>
          <label htmlFor={`${uid}-tax`} className={labelClass}>
            Prices in this list
          </label>
          <select
            id={`${uid}-tax`}
            className={fieldClass}
            value={v.taxInclusive ? 'in' : 'ex'}
            onChange={(e) => set('taxInclusive', e.target.value === 'in')}
          >
            <option value="in">Include tax</option>
            <option value="ex">Exclude tax</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-qty`} className={labelClass}>
            Quantity breaks work
          </label>
          <select
            id={`${uid}-qty`}
            className={fieldClass}
            value={v.quantityMode}
            onChange={(e) => set('quantityMode', e.target.value as 'all_units' | 'incremental')}
          >
            <option value="all_units">On every unit (buy 100+, all at the lower price)</option>
            <option value="incremental">Step by step (only the units beyond each break)</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-prio`} className={labelClass}>
            Priority (higher wins a tie)
          </label>
          <input
            id={`${uid}-prio`}
            type="number"
            className={fieldClass}
            value={v.priority}
            onChange={(e) => set('priority', Number(e.target.value))}
          />
        </div>
        <div className="hidden sm:block" />
        <div>
          <label htmlFor={`${uid}-from`} className={labelClass}>
            In force from (business time)
          </label>
          <input
            id={`${uid}-from`}
            type="datetime-local"
            className={fieldClass}
            value={v.validFrom}
            onChange={(e) => set('validFrom', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${uid}-to`} className={labelClass}>
            Until, business time (leave empty for no end)
          </label>
          <input
            id={`${uid}-to`}
            type="datetime-local"
            className={fieldClass}
            value={v.validTo}
            onChange={(e) => set('validTo', e.target.value)}
          />
        </div>
      </div>
      <ScopeEditor
        value={v.scopes}
        onChange={(s) => set('scopes', s)}
        lookups={lookups}
        names={names}
      />
      <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
      <Notice message={message} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButtonClass} disabled={busy || !reason.code}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className={buttonClass} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
