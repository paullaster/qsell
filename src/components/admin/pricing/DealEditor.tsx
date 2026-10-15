'use client';

import { useId } from 'react';
import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import type { MixConfig } from '@/server/domains/pricing/domain/mix';
import { buttonClass, fieldClass, labelClass } from '../approvals/shared';
import { ProductPick } from './PriceLinesPanel';
import {
  TargetEditor,
  everything,
  stateToTarget,
  targetToState,
  type TargetState,
} from './TargetEditor';

type Reward = 'free' | 'percent' | 'price';

export interface DealState {
  type: 'buy_get' | 'mix_match' | 'bundle_deal' | 'gift';
  // buy and get
  buyQty: string;
  buyTarget: TargetState;
  getQty: string;
  getTarget: TargetState;
  sameSet: boolean;
  rewardKind: Reward;
  rewardValue: string;
  pick: 'cheapest' | 'most_expensive';
  // mix and match
  setTarget: TargetState;
  groupQty: string;
  groupKind: 'price' | 'percent';
  groupValue: string;
  // bundle deal
  slots: { target: TargetState; qty: string }[];
  bundlePrice: string;
  maxSets: string;
  // gift
  minOrderValue: string;
  minQuantity: string;
  giftTrigger: TargetState;
  gifts: { productId: string; label: string; qty: string }[];
}

export const newDeal = (type: DealState['type'] = 'buy_get'): DealState => ({
  type,
  buyQty: '2',
  buyTarget: everything(),
  getQty: '1',
  getTarget: everything(),
  sameSet: true,
  rewardKind: 'free',
  rewardValue: '',
  pick: 'cheapest',
  setTarget: everything(),
  groupQty: '3',
  groupKind: 'price',
  groupValue: '',
  slots: [
    { target: { ...everything(), all: false }, qty: '1' },
    { target: { ...everything(), all: false }, qty: '1' },
  ],
  bundlePrice: '',
  maxSets: '',
  minOrderValue: '',
  minQuantity: '',
  giftTrigger: everything(),
  gifts: [],
});

const num = (v: string): number | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** The deal as the engine wants it. */
export function dealToMix(d: DealState): MixConfig {
  const maxSets = num(d.maxSets);
  const ms = maxSets != null ? { maxSets } : {};
  switch (d.type) {
    case 'buy_get':
      return {
        type: 'buy_get',
        sameSet: d.sameSet,
        buy: { target: stateToTarget(d.buyTarget), quantity: num(d.buyQty) ?? 0 },
        get: {
          target: stateToTarget(d.sameSet ? d.buyTarget : d.getTarget),
          quantity: num(d.getQty) ?? 0,
          reward: {
            kind: d.rewardKind,
            ...(d.rewardKind === 'free' ? {} : { value: num(d.rewardValue) ?? 0 }),
          },
          pick: d.pick,
        },
        ...ms,
      };
    case 'mix_match':
      return {
        type: 'mix_match',
        set: stateToTarget(d.setTarget),
        quantity: num(d.groupQty) ?? 0,
        reward: { kind: d.groupKind, value: num(d.groupValue) ?? 0 },
        ...ms,
      };
    case 'bundle_deal':
      return {
        type: 'bundle_deal',
        price: num(d.bundlePrice) ?? 0,
        slots: d.slots.map((s) => ({ target: stateToTarget(s.target), quantity: num(s.qty) ?? 0 })),
        ...ms,
      };
    case 'gift': {
      const t = d.giftTrigger.all ? undefined : stateToTarget(d.giftTrigger);
      return {
        type: 'gift',
        trigger: {
          ...(num(d.minOrderValue) != null ? { minOrderValue: num(d.minOrderValue) } : {}),
          ...(num(d.minQuantity) != null ? { minQuantity: num(d.minQuantity) } : {}),
          ...(t ? { target: t } : {}),
        },
        gifts: d.gifts.map((g) => ({ productId: g.productId, quantity: num(g.qty) ?? 0 })),
      };
    }
  }
}

/** A saved deal as the form holds it. */
export function mixToDeal(m: MixConfig | null, names: Record<string, string>): DealState {
  const d = newDeal(m?.type ?? 'buy_get');
  if (!m) return d;
  const s = (t: Parameters<typeof targetToState>[0]) => targetToState(t, names);
  const ms = 'maxSets' in m && m.maxSets != null ? String(m.maxSets) : '';
  switch (m.type) {
    case 'buy_get':
      return {
        ...d,
        buyQty: String(m.buy.quantity),
        buyTarget: s(m.buy.target),
        getQty: String(m.get.quantity),
        getTarget: s(m.get.target),
        sameSet: m.sameSet === true,
        rewardKind: m.get.reward.kind,
        rewardValue: m.get.reward.value != null ? String(m.get.reward.value) : '',
        pick: m.get.pick ?? 'cheapest',
        maxSets: ms,
      };
    case 'mix_match':
      return {
        ...d,
        setTarget: s(m.set),
        groupQty: String(m.quantity),
        groupKind: m.reward.kind,
        groupValue: String(m.reward.value),
        maxSets: ms,
      };
    case 'bundle_deal':
      return {
        ...d,
        slots: m.slots.map((x) => ({ target: s(x.target), qty: String(x.quantity) })),
        bundlePrice: String(m.price),
        maxSets: ms,
      };
    case 'gift':
      return {
        ...d,
        minOrderValue: m.trigger.minOrderValue != null ? String(m.trigger.minOrderValue) : '',
        minQuantity: m.trigger.minQuantity != null ? String(m.trigger.minQuantity) : '',
        giftTrigger: s(m.trigger.target),
        gifts: m.gifts.map((g) => ({
          productId: g.productId,
          label: names[g.productId] ?? g.productId,
          qty: String(g.quantity),
        })),
      };
  }
}

const DEAL_TYPES = [
  {
    value: 'buy_get',
    label: 'Buy some, get some (buy 2 get 1 free, buy a phone get accessories half price)',
  },
  { value: 'mix_match', label: 'Mix and match (any 3 for a set price)' },
  { value: 'bundle_deal', label: 'Bundle deal (burger + fries + drink for a fixed price)' },
];

/** Describes a product-mix deal, or a free gift. */
export function DealEditor({
  kind,
  value,
  onChange,
  lookups,
}: {
  kind: 'mix' | 'gift';
  value: DealState;
  onChange: (next: DealState) => void;
  lookups: DiscountLookups;
}) {
  const uid = useId();
  const set = <K extends keyof DealState>(k: K, v: DealState[K]) => onChange({ ...value, [k]: v });
  const field = (
    id: string,
    label: string,
    v: string,
    on: (x: string) => void,
    extra: object = {},
  ) => (
    <div>
      <label htmlFor={`${uid}-${id}`} className={labelClass}>
        {label}
      </label>
      <input
        id={`${uid}-${id}`}
        type="number"
        className={fieldClass}
        value={v}
        onChange={(e) => on(e.target.value)}
        {...extra}
      />
    </div>
  );

  if (kind === 'gift')
    return (
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-bold text-fg-strong">The free gift</legend>
        <p className="text-xs text-fg-muted">
          Added to the order at no charge once the matching goods come to enough. The gift comes out
          of stock like any sale, and what it would have cost counts against the rule&apos;s limits.
        </p>
        <div className="space-y-2">
          <p className={labelClass}>Gifts</p>
          {value.gifts.map((g, i) => (
            <div
              key={g.productId}
              className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2"
            >
              <span className="min-w-40 flex-1 text-sm font-semibold text-fg-strong">
                {g.label}
              </span>
              <div>
                <label htmlFor={`${uid}-g${i}`} className="text-xs text-fg-muted">
                  Units
                </label>
                <input
                  id={`${uid}-g${i}`}
                  type="number"
                  min={1}
                  className={`${fieldClass} w-24`}
                  value={g.qty}
                  onChange={(e) =>
                    set(
                      'gifts',
                      value.gifts.map((x, n) => (n === i ? { ...x, qty: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <button
                type="button"
                className={buttonClass}
                onClick={() =>
                  set(
                    'gifts',
                    value.gifts.filter((_, n) => n !== i),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          <ProductPick
            value=""
            onPick={(p) =>
              value.gifts.some((x) => x.productId === p.id)
                ? undefined
                : set('gifts', [
                    ...value.gifts,
                    { productId: p.id, label: `${p.name} (${p.sku})`, qty: '1' },
                  ])
            }
            onClear={() => undefined}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field(
            'mov',
            'When the matching goods come to at least (optional)',
            value.minOrderValue,
            (v) => set('minOrderValue', v),
            { min: 0 },
          )}
          {field(
            'mq',
            'Or when there are at least this many units (optional)',
            value.minQuantity,
            (v) => set('minQuantity', v),
            { min: 1 },
          )}
        </div>
        <div>
          <p className={labelClass}>Which goods count towards it</p>
          <TargetEditor
            value={value.giftTrigger}
            onChange={(v) => set('giftTrigger', v)}
            lookups={lookups}
            everythingLabel="Everything in the order"
          />
        </div>
      </fieldset>
    );

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-bold text-fg-strong">The deal</legend>
      <div>
        <label htmlFor={`${uid}-type`} className={labelClass}>
          Kind of deal
        </label>
        <select
          id={`${uid}-type`}
          className={fieldClass}
          value={value.type}
          onChange={(e) => set('type', e.target.value as DealState['type'])}
        >
          {DEAL_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-fg-muted">
        Each unit takes part in at most one deal. When deals compete for the same units, the one
        worth most to the customer goes first.
      </p>

      {value.type === 'buy_get' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            {field('bq', 'Buy (units)', value.buyQty, (v) => set('buyQty', v), { min: 1 })}
            {field('gq', 'Get (units)', value.getQty, (v) => set('getQty', v), { min: 1 })}
          </div>
          <label className="flex min-h-10 cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={value.sameSet}
              onChange={(e) => set('sameSet', e.target.checked)}
            />
            <span>
              The units to get come from the same products as the ones bought
              <span className="block text-xs text-fg-muted">
                The cheapest of each group are the ones that earn the reward (buy 2 get the cheapest
                free).
              </span>
            </span>
          </label>
          <div>
            <p className={labelClass}>The products to buy</p>
            <TargetEditor
              value={value.buyTarget}
              onChange={(v) => set('buyTarget', v)}
              lookups={lookups}
              everythingLabel="Any product"
            />
          </div>
          {!value.sameSet ? (
            <div>
              <p className={labelClass}>The products to get</p>
              <TargetEditor
                value={value.getTarget}
                onChange={(v) => set('getTarget', v)}
                lookups={lookups}
                everythingLabel="Any other product"
              />
              <div className="mt-2 sm:max-w-xs">
                <label htmlFor={`${uid}-pick`} className={labelClass}>
                  Which one earns the reward
                </label>
                <select
                  id={`${uid}-pick`}
                  className={fieldClass}
                  value={value.pick}
                  onChange={(e) => set('pick', e.target.value as DealState['pick'])}
                >
                  <option value="cheapest">The cheapest</option>
                  <option value="most_expensive">The most expensive</option>
                </select>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-rk`} className={labelClass}>
                The ones you get are
              </label>
              <select
                id={`${uid}-rk`}
                className={fieldClass}
                value={value.rewardKind}
                onChange={(e) => set('rewardKind', e.target.value as Reward)}
              >
                <option value="free">Free</option>
                <option value="percent">A percentage off</option>
                <option value="price">At a set price each</option>
              </select>
            </div>
            {value.rewardKind !== 'free'
              ? field(
                  'rv',
                  value.rewardKind === 'percent' ? 'Percentage off' : 'Price each',
                  value.rewardValue,
                  (v) => set('rewardValue', v),
                  { min: 0, step: '0.01' },
                )
              : null}
          </div>
        </div>
      ) : null}

      {value.type === 'mix_match' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {field('gq2', 'Any this many units', value.groupQty, (v) => set('groupQty', v), {
              min: 2,
            })}
            <div>
              <label htmlFor={`${uid}-gk`} className={labelClass}>
                For
              </label>
              <select
                id={`${uid}-gk`}
                className={fieldClass}
                value={value.groupKind}
                onChange={(e) => set('groupKind', e.target.value as 'price' | 'percent')}
              >
                <option value="price">A set price for the group</option>
                <option value="percent">A percentage off the group</option>
              </select>
            </div>
            {field(
              'gv',
              value.groupKind === 'price' ? 'Price for the group' : 'Percentage off',
              value.groupValue,
              (v) => set('groupValue', v),
              { min: 0, step: '0.01' },
            )}
          </div>
          <div>
            <p className={labelClass}>The products it covers</p>
            <TargetEditor
              value={value.setTarget}
              onChange={(v) => set('setTarget', v)}
              lookups={lookups}
              everythingLabel="Any product"
            />
          </div>
        </div>
      ) : null}

      {value.type === 'bundle_deal' ? (
        <div className="space-y-3">
          {value.slots.map((slot, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <p className="text-sm font-semibold text-fg-strong">Part {i + 1}</p>
                <div className="flex items-end gap-2">
                  <div>
                    <label htmlFor={`${uid}-s${i}`} className="text-xs text-fg-muted">
                      Units
                    </label>
                    <input
                      id={`${uid}-s${i}`}
                      type="number"
                      min={1}
                      className={`${fieldClass} w-24`}
                      value={slot.qty}
                      onChange={(e) =>
                        set(
                          'slots',
                          value.slots.map((x, n) => (n === i ? { ...x, qty: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                  {value.slots.length > 2 ? (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() =>
                        set(
                          'slots',
                          value.slots.filter((_, n) => n !== i),
                        )
                      }
                    >
                      Remove part
                    </button>
                  ) : null}
                </div>
              </div>
              <TargetEditor
                value={slot.target}
                onChange={(t) =>
                  set(
                    'slots',
                    value.slots.map((x, n) => (n === i ? { ...x, target: t } : x)),
                  )
                }
                lookups={lookups}
                everythingLabel="Any product"
              />
            </div>
          ))}
          {value.slots.length < 6 ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                set('slots', [
                  ...value.slots,
                  { target: { ...everything(), all: false }, qty: '1' },
                ])
              }
            >
              Add a part
            </button>
          ) : null}
          <div className="sm:max-w-xs">
            {field(
              'bp',
              'The whole bundle costs',
              value.bundlePrice,
              (v) => set('bundlePrice', v),
              { min: 0, step: '0.01' },
            )}
          </div>
        </div>
      ) : null}

      <div className="sm:max-w-xs">
        {field(
          'ms',
          'Most times it can apply in one order (optional)',
          value.maxSets,
          (v) => set('maxSets', v),
          { min: 1 },
        )}
      </div>
    </fieldset>
  );
}
