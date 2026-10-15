'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { type PricingLookups } from '@/server/domains/pricing/actions';
import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import {
  checkRebateAction,
  saveRebateAction,
  type RebateDto,
  type RebateFormInput,
} from '@/server/domains/pricing/retrospective-actions';
import {
  summariseRebate,
  type RebatePeriod,
  type TierMode,
} from '@/server/domains/pricing/domain/rebate';
import type { RuleIssue } from '@/server/domains/pricing/domain/rules';
import type { Scopes } from '@/server/domains/pricing/domain/types';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Notice,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { ScopeEditor } from './ScopeEditor';
import { TargetEditor, stateToTarget, targetToState, type TargetState } from './TargetEditor';
import { fromLocalInput, toLocalInput } from './PriceListForm';

const num = (v: string): number | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

interface State {
  code: string;
  name: string;
  description: string;
  period: RebatePeriod;
  tierMode: TierMode;
  tiers: { from: string; percent: string }[];
  scopes: Scopes;
  target: TargetState;
  validFrom: string;
  validTo: string;
}

function initial(r: RebateDto | undefined, names: Record<string, string>): State {
  return {
    code: r?.code ?? '',
    name: r?.name ?? '',
    description: r?.description ?? '',
    period: r?.period ?? 'quarter',
    tierMode: r?.tierMode ?? 'all_sales',
    tiers: (r?.tiers ?? [{ from: 0, percent: 0 }]).map((t) => ({
      from: String(t.from),
      percent: t.percent ? String(t.percent) : '',
    })),
    scopes: r?.scopes ?? {},
    target: targetToState(r?.target, names),
    validFrom: toLocalInput(r?.validFrom ?? new Date().toISOString()),
    validTo: toLocalInput(r?.validTo ?? null),
  };
}

function toForm(s: State): RebateFormInput {
  return {
    code: s.code,
    name: s.name,
    description: s.description || null,
    period: s.period,
    tierMode: s.tierMode,
    tiers: s.tiers
      .map((t) => ({ from: num(t.from), percent: num(t.percent) }))
      .filter((t): t is { from: number; percent: number } => t.from != null && t.percent != null),
    scopes: s.scopes,
    target: stateToTarget(s.target),
    validFrom: fromLocalInput(s.validFrom) ?? new Date().toISOString(),
    validTo: fromLocalInput(s.validTo),
  };
}

/** Makes or changes a rebate programme, with the plain-words sentence and the checks as you type. */
export function RebateForm({
  mode,
  initial: program,
  lookups,
  names,
  onSaved,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: RebateDto;
  lookups: DiscountLookups;
  names: Record<string, string>;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [s, setS] = useState<State>(() => initial(program, names));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ errors: RuleIssue[]; warnings: RuleIssue[] }>({
    errors: [],
    warnings: [],
  });
  const set = <K extends keyof State>(k: K, v: State[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const form = useMemo(() => toForm(s), [s]);
  const summary = useMemo(() => {
    try {
      return summariseRebate(
        {
          ...form,
          validFrom: new Date(form.validFrom),
          validTo: form.validTo ? new Date(form.validTo) : null,
        },
        {
          category: Object.fromEntries(lookups.categories.map((c) => [c.id, c.name])),
          group: Object.fromEntries(lookups.productGroups.map((g) => [g.id, g.name])),
        },
      );
    } catch {
      return '';
    }
  }, [form, lookups]);

  const signature = JSON.stringify(form);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void checkRebateAction(form).then((r) => {
        if (live && r.ok) setChecks(r.data);
      });
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // The signature stands for the whole form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await saveRebateAction(form, reason, program?.id);
    setBusy(false);
    if (r.ok) onSaved(r.data.id);
    else setMessage({ kind: 'error', text: r.error });
  };

  const scopeLookups: PricingLookups = {
    branches: lookups.branches,
    currencies: [],
    groups: lookups.customerGroups,
    channels: lookups.channels,
    salesTypes: lookups.salesTypes,
    baseCurrency: '',
  };

  return (
    <form onSubmit={save} className={`${cardClass} space-y-5`} aria-label="Rebate programme">
      <div
        role="status"
        className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-sm text-fg-strong"
      >
        <span className="block text-xs font-semibold text-indigo-700">
          This programme, in words
        </span>
        {summary || 'Fill in the programme and it is described here.'}
      </div>
      {checks.errors.length > 0 ? (
        <ul role="alert" className="list-disc space-y-0.5 pl-5 text-sm text-red-700">
          {checks.errors.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      ) : null}
      {checks.warnings.length > 0 ? (
        <ul role="status" className="list-disc space-y-0.5 pl-5 text-xs text-amber-700">
          {checks.warnings.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      ) : null}

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-bold text-fg-strong">The programme</legend>
        <div>
          <label htmlFor={`${uid}-code`} className={labelClass}>
            Code
          </label>
          <input
            id={`${uid}-code`}
            className={fieldClass}
            value={s.code}
            disabled={mode === 'edit'}
            onChange={(e) => set('code', e.target.value)}
            placeholder="DIST-QUARTERLY"
            required
          />
        </div>
        <div>
          <label htmlFor={`${uid}-name`} className={labelClass}>
            Name
          </label>
          <input
            id={`${uid}-name`}
            className={fieldClass}
            value={s.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor={`${uid}-period`} className={labelClass}>
            Totals are counted over a
          </label>
          <select
            id={`${uid}-period`}
            className={fieldClass}
            value={s.period}
            onChange={(e) => set('period', e.target.value as RebatePeriod)}
          >
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="year">Year</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-mode`} className={labelClass}>
            How the steps work
          </label>
          <select
            id={`${uid}-mode`}
            className={fieldClass}
            value={s.tierMode}
            onChange={(e) => set('tierMode', e.target.value as TierMode)}
          >
            <option value="all_sales">The step reached applies to everything bought</option>
            <option value="incremental">Each step applies only to what is bought above it</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${uid}-desc`} className={labelClass}>
            Notes (optional)
          </label>
          <input
            id={`${uid}-desc`}
            className={fieldClass}
            value={s.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-bold text-fg-strong">Steps</legend>
        {s.tiers.map((t, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`${uid}-tf${i}`} className="text-xs text-fg-muted">
                Once purchases reach
              </label>
              <input
                id={`${uid}-tf${i}`}
                type="number"
                min={0}
                className={`${fieldClass} w-40`}
                value={t.from}
                onChange={(e) =>
                  set(
                    'tiers',
                    s.tiers.map((x, n) => (n === i ? { ...x, from: e.target.value } : x)),
                  )
                }
              />
            </div>
            <div>
              <label htmlFor={`${uid}-tp${i}`} className="text-xs text-fg-muted">
                Give back (%)
              </label>
              <input
                id={`${uid}-tp${i}`}
                type="number"
                min={0}
                max={50}
                step="0.01"
                className={`${fieldClass} w-28`}
                value={t.percent}
                onChange={(e) =>
                  set(
                    'tiers',
                    s.tiers.map((x, n) => (n === i ? { ...x, percent: e.target.value } : x)),
                  )
                }
              />
            </div>
            {s.tiers.length > 1 ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() =>
                  set(
                    'tiers',
                    s.tiers.filter((_, n) => n !== i),
                  )
                }
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          className={buttonClass}
          onClick={() => set('tiers', [...s.tiers, { from: '', percent: '' }])}
        >
          Add a step
        </button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-bold text-fg-strong">What counts</legend>
        <TargetEditor
          value={s.target}
          onChange={(v) => set('target', v)}
          lookups={lookups}
          everythingLabel="Everything the customer buys"
        />
      </fieldset>

      <ScopeEditor
        value={s.scopes}
        onChange={(v) => set('scopes', v)}
        lookups={scopeLookups}
        names={{}}
        dimensions={['customer', 'customer_group', 'branch']}
      />

      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-bold text-fg-strong">When it runs</legend>
        <div>
          <label htmlFor={`${uid}-vf`} className={labelClass}>
            Starts
          </label>
          <input
            id={`${uid}-vf`}
            type="datetime-local"
            className={fieldClass}
            value={s.validFrom}
            onChange={(e) => set('validFrom', e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor={`${uid}-vt`} className={labelClass}>
            Ends (leave empty for no end)
          </label>
          <input
            id={`${uid}-vt`}
            type="datetime-local"
            className={fieldClass}
            value={s.validTo}
            onChange={(e) => set('validTo', e.target.value)}
          />
        </div>
      </fieldset>

      <ReasonField value={reason} onChange={setReason} source="pricing-reasons" />
      <Notice message={message} />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={primaryButtonClass}
          disabled={busy || !reason.code || checks.errors.length > 0}
        >
          {busy ? 'Saving…' : mode === 'create' ? 'Save as a draft' : 'Save changes'}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
