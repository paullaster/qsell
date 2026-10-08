'use client';

import { useId, useState } from 'react';
import { searchCustomersAction } from '@/server/domains/pricing/actions';
import { simulateDiscountsAction } from '@/server/domains/pricing/discount-actions';
import type { SimulationResult } from '@/server/domains/pricing/discount-config-service';
import {
  Chip,
  Notice,
  buttonClass,
  cardClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { ProductPick } from './PriceLinesPanel';

const money = (n: number | null) =>
  n == null
    ? '—'
    : n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const OUTCOME_TONE: Record<string, 'green' | 'grey' | 'amber' | 'red'> = {
  applied: 'green',
  lost: 'grey',
  blocked: 'red',
  not_applicable: 'amber',
};
const OUTCOME_LABEL: Record<string, string> = {
  applied: 'Applied',
  lost: 'Not used',
  blocked: 'Blocked',
  not_applicable: 'Did not apply',
};

/**
 * Tries a basket as a sale would be priced, discounts included, and says why each rule did or did
 * not apply. A draft or paused rule can be tried as if it were in force, before it is.
 */
export function DiscountSimulator({
  tryRule,
}: {
  /** A rule that is not in force yet, to try as if it were. */
  tryRule?: { id: string; code: string } | null;
}) {
  const uid = useId();
  const [lines, setLines] = useState<Array<{ productId: string; label: string; quantity: string }>>(
    [],
  );
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Array<{ id: string; name: string; number: string }>>([]);
  const [coupons, setCoupons] = useState('');
  const [payment, setPayment] = useState('');
  const [tryIt, setTryIt] = useState(true);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const search = async (term: string) => {
    setQ(term);
    if (term.trim().length < 2) return setFound([]);
    const r = await searchCustomersAction(term);
    if (r.ok) setFound(r.data);
  };

  const run = async () => {
    setBusy(true);
    setMessage(null);
    const r = await simulateDiscountsAction({
      customerId: customer?.id ?? null,
      paymentMethod: payment || null,
      couponCodes: coupons
        .split(/[\s,;]+/)
        .map((c) => c.trim())
        .filter(Boolean),
      tryRuleId: tryRule && tryIt ? tryRule.id : null,
      lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) || 1 })),
    });
    setBusy(false);
    if (r.ok) setResult(r.data);
    else setMessage({ kind: 'error', text: r.error });
  };

  return (
    <section aria-label="Try a sale" className={`${cardClass} space-y-4`}>
      <div>
        <h3 className="text-sm font-bold text-fg-strong">Try a sale</h3>
        <p className="text-xs text-fg-muted">
          Pick products and see the price each would get, with the discounts applied and why.
        </p>
      </div>

      <div>
        <ProductPick
          value=""
          onPick={(p) =>
            setLines((cur) =>
              cur.some((l) => l.productId === p.id)
                ? cur
                : [...cur, { productId: p.id, label: `${p.name} (${p.sku})`, quantity: '1' }],
            )
          }
          onClear={() => undefined}
        />
        {lines.length > 0 ? (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {lines.map((l, i) => (
              <li
                key={l.productId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span>{l.label}</span>
                <span className="flex items-center gap-2">
                  <label htmlFor={`${uid}-q${i}`} className="text-xs text-fg-muted">
                    Quantity
                  </label>
                  <input
                    id={`${uid}-q${i}`}
                    type="number"
                    min={1}
                    className={`${fieldClass} w-24`}
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((cur) =>
                        cur.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setLines((cur) => cur.filter((_, n) => n !== i))}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${uid}-cust`} className={labelClass}>
            Customer (optional)
          </label>
          {customer ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-fg-strong">{customer.name}</span>
              <button type="button" className={buttonClass} onClick={() => setCustomer(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                id={`${uid}-cust`}
                className={fieldClass}
                value={q}
                placeholder="Type a name or number…"
                onChange={(e) => void search(e.target.value)}
              />
              {found.length > 0 ? (
                <ul className="mt-1 max-h-40 divide-y divide-line overflow-auto rounded-lg border border-line">
                  {found.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        className="min-h-10 w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-hover"
                        onClick={() => {
                          setCustomer({ id: f.id, name: f.name });
                          setFound([]);
                          setQ('');
                        }}
                      >
                        {f.name} <span className="text-fg-muted">{f.number}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <div>
          <label htmlFor={`${uid}-cp`} className={labelClass}>
            Coupon codes (optional)
          </label>
          <input
            id={`${uid}-cp`}
            className={fieldClass}
            value={coupons}
            onChange={(e) => setCoupons(e.target.value)}
            placeholder="WELCOME10"
          />
        </div>
        <div>
          <label htmlFor={`${uid}-pay`} className={labelClass}>
            Paid by
          </label>
          <select
            id={`${uid}-pay`}
            className={fieldClass}
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
          >
            <option value="">Not stated</option>
            <option value="on_account">On account</option>
            <option value="mpesa_daraja">M-Pesa</option>
            <option value="card_direct">Card</option>
          </select>
        </div>
      </div>

      {tryRule ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={tryIt}
            onChange={(e) => setTryIt(e.target.checked)}
          />
          Include {tryRule.code} as if it were in force
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryButtonClass}
          disabled={busy || lines.length === 0}
          onClick={() => void run()}
        >
          {busy ? 'Working it out…' : 'Price it'}
        </button>
      </div>
      <Notice message={message} />

      {result ? (
        <div role="status" className="space-y-3 text-sm">
          {result.couponProblems.map((p) => (
            <p key={p.code} role="alert" className="text-red-700">
              Coupon {p.code}: {p.reason}
            </p>
          ))}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <thead className="border-b border-line text-fg-muted">
                <tr>
                  <th className="py-2 pr-3">Product</th>
                  <th className="py-2 pr-3 text-right">Qty</th>
                  <th className="py-2 pr-3 text-right">Before</th>
                  <th className="py-2 pr-3 text-right">After</th>
                  <th className="py-2">What happened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.lines.map((l) => (
                  <tr key={l.productId} className="align-top">
                    <td className="py-2 pr-3 font-semibold text-fg-strong">{l.name}</td>
                    <td className="py-2 pr-3 text-right font-mono">{l.quantity}</td>
                    <td className="py-2 pr-3 text-right font-mono">{money(l.lineTotalBefore)}</td>
                    <td className="py-2 pr-3 text-right font-mono font-semibold">
                      {money(l.lineTotalAfter)}
                    </td>
                    <td className="py-2">
                      {l.problem ? <span className="text-red-700">{l.problem}</span> : null}
                      {l.applied.map((a) => (
                        <div key={`${a.code}-${a.level}`}>
                          <Chip tone="green">{a.code}</Chip> {a.how}, takes off {money(a.amount)}
                        </div>
                      ))}
                      {l.considered.length > 0 ? (
                        <details className="mt-1">
                          <summary className="min-h-8 cursor-pointer text-indigo-700">
                            Why these rules
                          </summary>
                          <ul className="mt-1 space-y-1">
                            {l.considered.map((c, i) => (
                              <li key={i}>
                                <Chip tone={OUTCOME_TONE[c.outcome] ?? 'grey'}>
                                  {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                                </Chip>{' '}
                                <span className="font-semibold">{c.code}</span>: {c.why}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.orderConsidered.length > 0 ? (
            <details>
              <summary className="min-h-8 cursor-pointer text-xs text-indigo-700">
                Order rules: why
              </summary>
              <ul className="mt-1 space-y-1 text-xs">
                {result.orderConsidered.map((c, i) => (
                  <li key={i}>
                    <Chip tone={OUTCOME_TONE[c.outcome] ?? 'grey'}>
                      {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                    </Chip>{' '}
                    <span className="font-semibold">{c.code}</span>: {c.why}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {result.gifts.length > 0 ? (
            <ul className="text-sm text-emerald-700">
              {result.gifts.map((g, i) => (
                <li key={i}>
                  Free gift: {g.quantity} × {g.productName} (worth {money(g.value)}) from {g.code}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-sm font-semibold text-fg-strong">
            Total {money(result.totalBefore)} before, {money(result.totalAfter)} after:{' '}
            {result.totalDiscount > 0 ? `${money(result.totalDiscount)} off.` : 'no discount.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
