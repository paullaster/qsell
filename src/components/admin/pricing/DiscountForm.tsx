'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  checkDiscountRuleAction,
  saveDiscountRuleAction,
  type DiscountFormInput,
  type DiscountLookups,
  type DiscountRuleDto,
} from '@/server/domains/pricing/discount-actions';
import { listPricingReasonsAction, type PricingLookups } from '@/server/domains/pricing/actions';
import {
  summariseDiscount,
  type DiscountRuleInput,
} from '@/server/domains/pricing/domain/discount-rules';
import type { RuleIssue } from '@/server/domains/pricing/domain/rules';
import {
  NO_REWARD,
  type DiscountKind,
  type DiscountReward,
  type Stacking,
} from '@/server/domains/pricing/domain/discounts';
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
import { DealEditor, dealToMix, mixToDeal, type DealState } from './DealEditor';
import {
  Multi,
  TargetEditor,
  stateToTarget,
  targetToState,
  type TargetState,
} from './TargetEditor';
import { fromLocalInput, toLocalInput } from './PriceListForm';

const DAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 0, label: 'Sun' },
];

const LINE_REWARDS = [
  { value: 'percent', label: 'Percentage off the line' },
  { value: 'amount_per_unit', label: 'Amount off each unit' },
  { value: 'amount_per_line', label: 'Amount off the line' },
  { value: 'set_price', label: 'Set the unit price' },
];
const ORDER_REWARDS = [
  { value: 'percent', label: 'Percentage off the order' },
  { value: 'amount', label: 'Amount off the order' },
];

const KINDS: Array<{ value: DiscountKind; label: string }> = [
  { value: 'line', label: 'A line (each product on its own)' },
  { value: 'order', label: 'The whole order (what the lines come to)' },
  { value: 'mix', label: 'A product deal (buy and get, mix and match, bundle)' },
  { value: 'gift', label: 'A free gift' },
];

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
  kind: DiscountKind;
  priority: string;
  stacking: Stacking;
  rewardType: string;
  rewardValue: string;
  tiers: Array<{ from: string; value: string }>;
  target: TargetState;
  deal: DealState;
  scopes: Scopes;
  minQuantity: string;
  minOrderValue: string;
  paymentMethods: string[];
  requiresCoupon: boolean;
  validFrom: string;
  validTo: string;
  days: number[];
  from: string;
  to: string;
  maxUses: string;
  maxUsesPerCustomer: string;
  budget: string;
  maxDiscountPercent: string;
  strictLimits: boolean;
  appliesToContract: boolean;
}

function initialState(r: DiscountRuleDto | undefined, names: Record<string, string>): State {
  return {
    code: r?.code ?? '',
    name: r?.name ?? '',
    description: r?.description ?? '',
    kind: r?.kind ?? 'line',
    priority: String(r?.priority ?? 0),
    stacking: r?.stacking ?? 'exclusive',
    rewardType: r?.reward.type ?? 'percent',
    rewardValue: r && (r.kind === 'line' || r.kind === 'order') ? String(r.reward.value) : '10',
    tiers: (r?.reward.tiers ?? []).map((x) => ({ from: String(x.from), value: String(x.value) })),
    target: targetToState(r?.target, names),
    deal: mixToDeal(r?.mix ?? null, names),
    scopes: r?.scopes ?? {},
    minQuantity: r?.conditions.minQuantity != null ? String(r.conditions.minQuantity) : '',
    minOrderValue: r?.conditions.minOrderValue != null ? String(r.conditions.minOrderValue) : '',
    paymentMethods: r?.conditions.paymentMethods ?? [],
    requiresCoupon: r?.requiresCoupon ?? false,
    validFrom: toLocalInput(r?.validFrom ?? new Date().toISOString()),
    validTo: toLocalInput(r?.validTo ?? null),
    days: r?.schedule.days ?? [],
    from: r?.schedule.from ?? '',
    to: r?.schedule.to ?? '',
    maxUses: r?.limits.maxUses != null ? String(r.limits.maxUses) : '',
    maxUsesPerCustomer:
      r?.limits.maxUsesPerCustomer != null ? String(r.limits.maxUsesPerCustomer) : '',
    budget: r?.limits.budget != null ? String(r.limits.budget) : '',
    maxDiscountPercent:
      r?.limits.maxDiscountPercent != null ? String(r.limits.maxDiscountPercent) : '',
    strictLimits: r?.strictLimits ?? false,
    appliesToContract: r?.appliesToContract ?? false,
  };
}

function toFormInput(s: State): DiscountFormInput {
  const priceRule = s.kind === 'line' || s.kind === 'order';
  const tiers = s.tiers
    .map((t) => ({ from: num(t.from), value: num(t.value) }))
    .filter((t): t is { from: number; value: number } => t.from != null && t.value != null);
  const reward: DiscountReward = {
    type: s.rewardType as DiscountReward['type'],
    value: num(s.rewardValue) ?? 0,
    ...(tiers.length > 0 ? { tiers } : {}),
  };
  return {
    code: s.code,
    name: s.name,
    description: s.description || null,
    kind: s.kind,
    priority: Math.trunc(num(s.priority) ?? 0),
    stacking: priceRule ? s.stacking : 'exclusive',
    validFrom: fromLocalInput(s.validFrom) ?? new Date().toISOString(),
    validTo: fromLocalInput(s.validTo),
    schedule: {
      ...(s.days.length > 0 ? { days: s.days } : {}),
      ...(s.from ? { from: s.from } : {}),
      ...(s.to ? { to: s.to } : {}),
    },
    scopes: s.scopes,
    // A deal or gift is described by its deal; a price rule by its target and reward.
    target: priceRule ? stateToTarget(s.target) : { all: true },
    conditions: {
      ...(s.kind === 'line' && num(s.minQuantity) != null
        ? { minQuantity: num(s.minQuantity) }
        : {}),
      ...(s.kind === 'order' && num(s.minOrderValue) != null
        ? { minOrderValue: num(s.minOrderValue) }
        : {}),
      ...(s.paymentMethods.length > 0 ? { paymentMethods: s.paymentMethods } : {}),
    },
    reward: priceRule ? reward : NO_REWARD,
    mix: priceRule ? null : dealToMix(s.deal),
    requiresCoupon: s.requiresCoupon,
    limits: {
      ...(num(s.maxUses) != null ? { maxUses: num(s.maxUses) } : {}),
      ...(num(s.maxUsesPerCustomer) != null
        ? { maxUsesPerCustomer: num(s.maxUsesPerCustomer) }
        : {}),
      ...(num(s.budget) != null ? { budget: num(s.budget) } : {}),
      ...(priceRule && num(s.maxDiscountPercent) != null
        ? { maxDiscountPercent: num(s.maxDiscountPercent) }
        : {}),
    },
    strictLimits: s.strictLimits,
    appliesToContract: s.appliesToContract,
  };
}

/** The form's input as the plain-language summary wants it. */
function asRuleInput(f: DiscountFormInput): DiscountRuleInput {
  return {
    ...f,
    validFrom: new Date(f.validFrom),
    validTo: f.validTo ? new Date(f.validTo) : null,
  };
}

/**
 * Makes or changes a discount rule. A sentence at the top says in plain words what the rule as
 * filled in will do, and the checks run as you type, so nothing is learned at the last step.
 */
export function DiscountForm({
  mode,
  initial,
  lookups,
  productNames,
  onSaved,
  onCancel,
}: {
  mode: 'create' | 'edit';
  initial?: DiscountRuleDto;
  lookups: DiscountLookups;
  /** Names of the products an existing rule names. */
  productNames: Record<string, string>;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [s, setS] = useState<State>(() => initialState(initial, productNames));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ errors: RuleIssue[]; warnings: RuleIssue[] }>({
    errors: [],
    warnings: [],
  });
  const set = <K extends keyof State>(k: K, v: State[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const priceRule = s.kind === 'line' || s.kind === 'order';

  const form = useMemo(() => toFormInput(s), [s]);
  const summary = useMemo(() => {
    const pairs = [
      ...s.target.products.map((p) => [p.id, p.label] as const),
      ...s.deal.gifts.map((g) => [g.productId, g.label] as const),
      ...[
        s.deal.buyTarget,
        s.deal.getTarget,
        s.deal.setTarget,
        s.deal.giftTrigger,
        ...s.deal.slots.map((x) => x.target),
      ].flatMap((t) => t.products.map((p) => [p.id, p.label] as const)),
    ];
    const names = {
      category: Object.fromEntries(lookups.categories.map((c) => [c.id, c.name])),
      group: Object.fromEntries(lookups.productGroups.map((g) => [g.id, g.name])),
      product: Object.fromEntries(pairs),
      customer_group: Object.fromEntries(lookups.customerGroups.map((g) => [g.id, g.name])),
      branch: Object.fromEntries(lookups.branches.map((b) => [b.id, b.name])),
    };
    try {
      return summariseDiscount(asRuleInput(form), names);
    } catch {
      return '';
    }
  }, [form, lookups, s.target.products, s.deal]);

  // Checks run a moment after typing stops; a late answer for older input is dropped.
  const signature = JSON.stringify(form);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void checkDiscountRuleAction(form).then((r) => {
        if (live && r.ok) setChecks(r.data);
      });
    }, 600);
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
    const r = await saveDiscountRuleAction(form, reason, initial?.id);
    setBusy(false);
    if (r.ok) onSaved(r.data.id);
    else
      setMessage({
        kind: 'error',
        text:
          r.issues && r.issues.length > 1
            ? `${r.error} ${r.issues
                .slice(1, 4)
                .map((i) => i.message)
                .join(' ')}`
            : r.error,
      });
  };

  const rewards = s.kind === 'line' ? LINE_REWARDS : ORDER_REWARDS;
  const lookupsForScopes: PricingLookups = {
    branches: lookups.branches,
    currencies: [],
    groups: lookups.customerGroups,
    channels: lookups.channels,
    salesTypes: lookups.salesTypes,
    baseCurrency: '',
  };
  const tierLabel = s.kind === 'line' ? 'From this many units' : 'From this order value';

  return (
    <form onSubmit={save} className={`${cardClass} space-y-5`} aria-label="Discount rule">
      <div
        role="status"
        className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-sm text-fg-strong"
      >
        <span className="block text-xs font-semibold text-indigo-700">This rule, in words</span>
        {summary || 'Fill in the rule and it is described here.'}
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
        <legend className="mb-1 text-sm font-bold text-fg-strong">The rule</legend>
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
            placeholder="SPRING10"
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
          <label htmlFor={`${uid}-kind`} className={labelClass}>
            Applies to
          </label>
          <select
            id={`${uid}-kind`}
            className={fieldClass}
            value={s.kind}
            disabled={mode === 'edit'}
            onChange={(e) => {
              const kind = e.target.value as DiscountKind;
              setS((cur) => ({
                ...cur,
                kind,
                rewardType: 'percent',
                tiers: [],
                deal:
                  kind === 'gift'
                    ? { ...cur.deal, type: 'gift' }
                    : kind === 'mix'
                      ? { ...cur.deal, type: cur.deal.type === 'gift' ? 'buy_get' : cur.deal.type }
                      : cur.deal,
              }));
            }}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {priceRule ? (
          <div>
            <label htmlFor={`${uid}-stack`} className={labelClass}>
              Combining with other rules
            </label>
            <select
              id={`${uid}-stack`}
              className={fieldClass}
              value={s.stacking}
              onChange={(e) => set('stacking', e.target.value as Stacking)}
            >
              <option value="exclusive">Applies alone (the best exclusive rule wins)</option>
              <option value="stackable">Can combine with other stackable rules</option>
            </select>
          </div>
        ) : null}
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
        <div>
          <label htmlFor={`${uid}-prio`} className={labelClass}>
            Priority (higher wins a tie)
          </label>
          <input
            id={`${uid}-prio`}
            type="number"
            className={fieldClass}
            value={s.priority}
            onChange={(e) => set('priority', e.target.value)}
          />
        </div>
      </fieldset>

      {priceRule ? (
        <>
          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-bold text-fg-strong">What it gives</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`${uid}-rt`} className={labelClass}>
                  Reward
                </label>
                <select
                  id={`${uid}-rt`}
                  className={fieldClass}
                  value={s.rewardType}
                  onChange={(e) => {
                    const t = e.target.value;
                    setS((cur) => ({
                      ...cur,
                      rewardType: t,
                      // A set price cannot be combined with other rules.
                      stacking: t === 'set_price' ? 'exclusive' : cur.stacking,
                    }));
                  }}
                >
                  {rewards.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-rv`} className={labelClass}>
                  {s.rewardType === 'percent'
                    ? 'Percentage'
                    : s.rewardType === 'set_price'
                      ? 'Price'
                      : 'Amount'}
                </label>
                <input
                  id={`${uid}-rv`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  className={fieldClass}
                  value={s.rewardValue}
                  onChange={(e) => set('rewardValue', e.target.value)}
                  required
                />
              </div>
            </div>
            <div>
              <p className={labelClass}>Bigger rewards for bigger buys (optional)</p>
              {s.tiers.map((t, i) => (
                <div key={i} className="mb-2 flex flex-wrap items-end gap-2">
                  <div>
                    <label htmlFor={`${uid}-tf${i}`} className="text-xs text-fg-muted">
                      {tierLabel}
                    </label>
                    <input
                      id={`${uid}-tf${i}`}
                      type="number"
                      min={0}
                      className={`${fieldClass} w-36`}
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
                    <label htmlFor={`${uid}-tv${i}`} className="text-xs text-fg-muted">
                      The reward becomes
                    </label>
                    <input
                      id={`${uid}-tv${i}`}
                      type="number"
                      min={0}
                      step="0.01"
                      className={`${fieldClass} w-32`}
                      value={t.value}
                      onChange={(e) =>
                        set(
                          'tiers',
                          s.tiers.map((x, n) => (n === i ? { ...x, value: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
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
                </div>
              ))}
              <button
                type="button"
                className={buttonClass}
                onClick={() => set('tiers', [...s.tiers, { from: '', value: '' }])}
              >
                Add a step
              </button>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-bold text-fg-strong">
              {s.kind === 'line' ? 'Which products' : 'Which goods count towards it'}
            </legend>
            <TargetEditor value={s.target} onChange={(v) => set('target', v)} lookups={lookups} />
          </fieldset>
        </>
      ) : (
        <DealEditor
          kind={s.kind === 'gift' ? 'gift' : 'mix'}
          value={s.deal}
          onChange={(v) => set('deal', v)}
          lookups={lookups}
        />
      )}

      <ScopeEditor
        value={s.scopes}
        onChange={(v) => set('scopes', v)}
        lookups={lookupsForScopes}
        names={{}}
        dimensions={['customer', 'customer_group', 'branch', 'sales_type', 'channel']}
      />

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-bold text-fg-strong">What must be true</legend>
        {priceRule ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {s.kind === 'line' ? (
              <div>
                <label htmlFor={`${uid}-mq`} className={labelClass}>
                  At least this many units of the line (optional)
                </label>
                <input
                  id={`${uid}-mq`}
                  type="number"
                  min={0}
                  className={fieldClass}
                  value={s.minQuantity}
                  onChange={(e) => set('minQuantity', e.target.value)}
                />
              </div>
            ) : (
              <div>
                <label htmlFor={`${uid}-mo`} className={labelClass}>
                  The matching goods come to at least (optional)
                </label>
                <input
                  id={`${uid}-mo`}
                  type="number"
                  min={0}
                  className={fieldClass}
                  value={s.minOrderValue}
                  onChange={(e) => set('minOrderValue', e.target.value)}
                />
              </div>
            )}
          </div>
        ) : null}
        <Multi
          legend="Only when paid by (leave empty for any)"
          options={lookups.paymentMethods.map((p) => ({ value: p.code, label: p.label }))}
          selected={s.paymentMethods}
          onChange={(v) => set('paymentMethods', v)}
          empty=""
        />
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={s.requiresCoupon}
            onChange={(e) => set('requiresCoupon', e.target.checked)}
          />
          Only with a coupon code (you add the codes after saving)
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-bold text-fg-strong">When it runs</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>
        <div>
          <p className={labelClass}>Only on these days (leave empty for every day)</p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => (
              <label
                key={d.n}
                className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={s.days.includes(d.n)}
                  onChange={(e) =>
                    set(
                      'days',
                      e.target.checked ? [...s.days, d.n] : s.days.filter((x) => x !== d.n),
                    )
                  }
                />
                {d.label}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <div>
            <label htmlFor={`${uid}-tf`} className={labelClass}>
              From time (Nairobi)
            </label>
            <input
              id={`${uid}-tf`}
              type="time"
              className={fieldClass}
              value={s.from}
              onChange={(e) => set('from', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-tt`} className={labelClass}>
              To time
            </label>
            <input
              id={`${uid}-tt`}
              type="time"
              className={fieldClass}
              value={s.to}
              onChange={(e) => set('to', e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-bold text-fg-strong">Limits and guards</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-mu`} className={labelClass}>
              Most times it can be used, in all
            </label>
            <input
              id={`${uid}-mu`}
              type="number"
              min={1}
              className={fieldClass}
              value={s.maxUses}
              onChange={(e) => set('maxUses', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-mc`} className={labelClass}>
              Most times one customer can use it
            </label>
            <input
              id={`${uid}-mc`}
              type="number"
              min={1}
              className={fieldClass}
              value={s.maxUsesPerCustomer}
              onChange={(e) => set('maxUsesPerCustomer', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-bd`} className={labelClass}>
              Most it can give away, in all
            </label>
            <input
              id={`${uid}-bd`}
              type="number"
              min={0}
              step="0.01"
              className={fieldClass}
              value={s.budget}
              onChange={(e) => set('budget', e.target.value)}
            />
          </div>
          {priceRule ? (
            <div>
              <label htmlFor={`${uid}-mp`} className={labelClass}>
                Never more than this % of a line
              </label>
              <input
                id={`${uid}-mp`}
                type="number"
                min={0}
                max={100}
                step="0.1"
                className={fieldClass}
                value={s.maxDiscountPercent}
                onChange={(e) => set('maxDiscountPercent', e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <label className="flex min-h-10 cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={s.strictLimits}
            onChange={(e) => set('strictLimits', e.target.checked)}
          />
          <span>
            Hold the limits exactly
            <span className="block text-xs text-fg-muted">
              Checks the limits one order at a time. Slower under heavy load; without it a limit can
              be passed by a few uses when many orders arrive at once.
            </span>
          </span>
        </label>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={s.appliesToContract}
            onChange={(e) => set('appliesToContract', e.target.checked)}
          />
          Also reduce lines that have a contract price
        </label>
        <p className="text-xs text-fg-muted">
          Whatever the rule says, a product is never taken below its price floor.
        </p>
      </fieldset>

      <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
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
