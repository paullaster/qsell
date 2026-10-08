'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listPricingReasonsAction } from '@/server/domains/pricing/actions';
import {
  adjustLoyaltyAction,
  checkLoyaltyAction,
  loyaltyAccountAction,
  saveLoyaltyAction,
} from '@/server/domains/pricing/retrospective-actions';
import { summariseLoyalty, type LoyaltyConfig } from '@/server/domains/pricing/domain/loyalty';
import type { RuleIssue } from '@/server/domains/pricing/domain/rules';
import type {
  LoyaltyAccountView,
  LoyaltyProgramView,
} from '@/server/domains/pricing/loyalty-service';
import { ReasonField, type ReasonValue } from '../settings/numbering/ReasonField';
import {
  Chip,
  Notice,
  PageHeader,
  When,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { CustomerLookup, type PickedCustomer } from './CustomerLookup';

const num = (v: string): number | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const KIND: Record<string, string> = {
  earn: 'Earned on an order',
  redeem: 'Spent on an order',
  reverse_earn: 'Taken back (order cancelled or returned)',
  reverse_redeem: 'Given back (order cancelled)',
  adjust: 'Adjusted by staff',
  expire: 'Expired',
};

interface State {
  name: string;
  status: 'active' | 'paused';
  pointsPer100: string;
  pointValue: string;
  minRedeemPoints: string;
  maxRedeemPercent: string;
  expiryMonths: string;
  tiers: Array<{ name: string; fromPoints: string; multiplier: string }>;
}

const fromProgram = (p: LoyaltyProgramView | null): State => ({
  name: p?.name ?? 'Loyalty',
  status: p?.status ?? 'paused',
  pointsPer100: String(p?.config.pointsPer100 ?? 1),
  pointValue: String(p?.config.pointValue ?? 1),
  minRedeemPoints: String(p?.config.minRedeemPoints ?? 100),
  maxRedeemPercent: String(p?.config.maxRedeemPercent ?? 50),
  expiryMonths: p?.config.expiryMonths != null ? String(p.config.expiryMonths) : '',
  tiers: (p?.config.tiers ?? []).map((t) => ({
    name: t.name,
    fromPoints: String(t.fromPoints),
    multiplier: String(t.multiplier),
  })),
});

const toConfig = (s: State): LoyaltyConfig => ({
  pointsPer100: num(s.pointsPer100) ?? 0,
  pointValue: num(s.pointValue) ?? 0,
  minRedeemPoints: Math.trunc(num(s.minRedeemPoints) ?? 0),
  maxRedeemPercent: num(s.maxRedeemPercent) ?? 0,
  expiryMonths: num(s.expiryMonths) ?? null,
  tiers: s.tiers.map((t) => ({
    name: t.name,
    fromPoints: num(t.fromPoints) ?? 0,
    multiplier: num(t.multiplier) ?? 0,
  })),
});

export function LoyaltyClient({
  program,
  canManage,
}: {
  program: LoyaltyProgramView | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [s, setS] = useState<State>(() => fromProgram(program));
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ errors: RuleIssue[]; warnings: RuleIssue[] }>({
    errors: [],
    warnings: [],
  });
  const set = <K extends keyof State>(k: K, v: State[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const config = useMemo(() => toConfig(s), [s]);
  const signature = JSON.stringify(config);
  const summary = useMemo(() => summariseLoyalty(config), [config]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void checkLoyaltyAction(config).then((r) => {
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
    const r = await saveLoyaltyAction({ name: s.name, status: s.status, config }, reason);
    setBusy(false);
    if (!r.ok) return setMessage({ kind: 'error', text: r.error });
    setMessage({
      kind: 'ok',
      text:
        s.status === 'active'
          ? 'Saved. Orders now earn points.'
          : 'Saved. The programme is paused: no points are earned or spent.',
    });
    setReason({ code: '', text: '' });
    router.refresh();
  };

  const field = (
    id: string,
    label: string,
    value: string,
    on: (v: string) => void,
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
        value={value}
        onChange={(e) => on(e.target.value)}
        disabled={!canManage}
        {...extra}
      />
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Loyalty points">
        Customers earn points on what they spend and spend them like money on a later order. Points
        are never a price change: spending them is a payment, so the order&apos;s total, tax and
        invoice stay as they were. Cancelling an order takes the points it earned back and returns
        the ones it spent.
      </PageHeader>
      <Notice message={message} />

      <form onSubmit={save} className={`${cardClass} space-y-4`} aria-label="Loyalty programme">
        <div
          role="status"
          className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3 text-sm text-fg-strong"
        >
          <span className="block text-xs font-semibold text-indigo-700">
            The programme, in words
          </span>
          {summary}
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-status`} className={labelClass}>
              Status
            </label>
            <select
              id={`${uid}-status`}
              className={fieldClass}
              value={s.status}
              disabled={!canManage}
              onChange={(e) => set('status', e.target.value as 'active' | 'paused')}
            >
              <option value="active">In force: orders earn and can spend points</option>
              <option value="paused">Paused: nothing is earned or spent</option>
            </select>
          </div>
          {field(
            'per100',
            'Points earned for every 100 spent',
            s.pointsPer100,
            (v) => set('pointsPer100', v),
            { min: 0, step: '0.01' },
          )}
          {field(
            'value',
            'What one point is worth when spent',
            s.pointValue,
            (v) => set('pointValue', v),
            { min: 0, step: '0.01' },
          )}
          {field(
            'min',
            'Fewest points that can be spent at once',
            s.minRedeemPoints,
            (v) => set('minRedeemPoints', v),
            { min: 1 },
          )}
          {field(
            'max',
            'Most of an order points can pay for (%)',
            s.maxRedeemPercent,
            (v) => set('maxRedeemPercent', v),
            { min: 1, max: 100 },
          )}
          {field(
            'exp',
            'Points expire after (months, empty for never)',
            s.expiryMonths,
            (v) => set('expiryMonths', v),
            { min: 1 },
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-bold text-fg-strong">Tiers (optional)</legend>
          <p className="text-xs text-fg-muted">
            A customer who has earned enough points over time earns faster.
          </p>
          {s.tiers.map((t, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div>
                <label htmlFor={`${uid}-tn${i}`} className="text-xs text-fg-muted">
                  Tier name
                </label>
                <input
                  id={`${uid}-tn${i}`}
                  className={`${fieldClass} w-36`}
                  value={t.name}
                  disabled={!canManage}
                  onChange={(e) =>
                    set(
                      'tiers',
                      s.tiers.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <div>
                <label htmlFor={`${uid}-tf${i}`} className="text-xs text-fg-muted">
                  From lifetime points
                </label>
                <input
                  id={`${uid}-tf${i}`}
                  type="number"
                  min={0}
                  className={`${fieldClass} w-36`}
                  value={t.fromPoints}
                  disabled={!canManage}
                  onChange={(e) =>
                    set(
                      'tiers',
                      s.tiers.map((x, n) => (n === i ? { ...x, fromPoints: e.target.value } : x)),
                    )
                  }
                />
              </div>
              <div>
                <label htmlFor={`${uid}-tm${i}`} className="text-xs text-fg-muted">
                  Earns this many times
                </label>
                <input
                  id={`${uid}-tm${i}`}
                  type="number"
                  min={1}
                  max={10}
                  step="0.1"
                  className={`${fieldClass} w-28`}
                  value={t.multiplier}
                  disabled={!canManage}
                  onChange={(e) =>
                    set(
                      'tiers',
                      s.tiers.map((x, n) => (n === i ? { ...x, multiplier: e.target.value } : x)),
                    )
                  }
                />
              </div>
              {canManage ? (
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
          {canManage ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                set('tiers', [...s.tiers, { name: '', fromPoints: '', multiplier: '1.5' }])
              }
            >
              Add a tier
            </button>
          ) : null}
        </fieldset>

        {canManage ? (
          <>
            <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
            <button
              type="submit"
              className={primaryButtonClass}
              disabled={busy || !reason.code || checks.errors.length > 0}
            >
              {busy ? 'Saving…' : 'Save the programme'}
            </button>
          </>
        ) : null}
      </form>

      <CustomerPoints canManage={canManage} active={program?.status === 'active'} />
    </div>
  );
}

function CustomerPoints({ canManage, active }: { canManage: boolean; active: boolean }) {
  const uid = useId();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [account, setAccount] = useState<LoyaltyAccountView | null>(null);
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<ReasonValue>({ code: '', text: '' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!customer) {
      setAccount(null);
      return;
    }
    let live = true;
    void loyaltyAccountAction(customer.id).then((r) => {
      if (!live) return;
      if (r.ok) setAccount(r.data);
      else setMessage({ kind: 'error', text: r.error });
    });
    return () => {
      live = false;
    };
  }, [customer]);

  const adjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer) return;
    setBusy(true);
    setMessage(null);
    const r = await adjustLoyaltyAction(
      customer.id,
      Math.trunc(Number(points)),
      note || null,
      reason,
    );
    setBusy(false);
    if (!r.ok) return setMessage({ kind: 'error', text: r.error });
    setAccount(r.data);
    setPoints('');
    setNote('');
    setReason({ code: '', text: '' });
    setMessage({ kind: 'ok', text: 'The balance is updated.' });
  };

  return (
    <section aria-label="Customer points" className={`${cardClass} space-y-3`}>
      <h2 className="text-sm font-bold text-fg-strong">A customer&apos;s points</h2>
      <CustomerLookup value={customer} onChange={setCustomer} />
      <Notice message={message} />
      {account ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-strong" role="status">
            <strong>{account.customerName}</strong> has{' '}
            <strong>{account.balance.toLocaleString()}</strong> points
            {active
              ? ` (worth ${account.worth.toLocaleString('en-KE', { minimumFractionDigits: 2 })})`
              : ''}
            , {account.lifetimeEarned.toLocaleString()} earned in all.{' '}
            {account.tier ? <Chip tone="sky">{account.tier.name}</Chip> : null}
          </p>
          {canManage ? (
            <form
              onSubmit={adjust}
              className="space-y-3 rounded-lg border border-line p-3"
              aria-label="Adjust points"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${uid}-pts`} className={labelClass}>
                    Add or take away points (negative takes away)
                  </label>
                  <input
                    id={`${uid}-pts`}
                    type="number"
                    step={1}
                    className={fieldClass}
                    value={points}
                    onChange={(e) => setPoints(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor={`${uid}-note`} className={labelClass}>
                    Note (optional)
                  </label>
                  <input
                    id={`${uid}-note`}
                    className={fieldClass}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>
              <ReasonField value={reason} onChange={setReason} load={listPricingReasonsAction} />
              <button
                type="submit"
                className={primaryButtonClass}
                disabled={busy || !reason.code || !points}
              >
                {busy ? 'Saving…' : 'Adjust'}
              </button>
            </form>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <caption className="sr-only">Recent points activity</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-fg-muted">
                  <th className="py-2 pr-3 font-semibold">What happened</th>
                  <th className="py-2 pr-3 text-right font-semibold">Points</th>
                  <th className="py-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {account.ledger.map((l) => (
                  <tr key={l.id} className="border-b border-line/60">
                    <td className="py-2 pr-3">
                      {KIND[l.kind] ?? l.kind}
                      {l.note ? (
                        <span className="block text-xs text-fg-muted">{l.note}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {l.points > 0 ? `+${l.points}` : l.points}
                    </td>
                    <td className="py-2 text-xs text-fg-muted">
                      <When iso={l.createdAt} />
                    </td>
                  </tr>
                ))}
                {account.ledger.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-3 text-fg-muted">
                      No points activity yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
