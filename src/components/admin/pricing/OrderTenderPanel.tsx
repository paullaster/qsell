'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  applyTenderAction,
  orderTenderInfoAction,
  type OrderTenderInfo,
} from '@/server/domains/pricing/retrospective-actions';
import {
  Notice,
  buttonClass,
  fieldClass,
  labelClass,
  primaryButtonClass,
  type Message,
} from '../approvals/shared';
import { money } from './DiscountsClient';

/**
 * Paying an order with a gift card or loyalty points, from the order screen. It is a payment, so
 * the total stays as it was and what is left is what a payment gateway is asked for.
 */
export function OrderTenderPanel({
  orderId,
  onChanged,
}: {
  orderId: string;
  onChanged?: () => void;
}) {
  const uid = useId();
  const [info, setInfo] = useState<OrderTenderInfo | null>(null);
  const [code, setCode] = useState('');
  const [points, setPoints] = useState('');
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await orderTenderInfoAction(orderId);
    setInfo(r.ok ? r.data : null);
  }, [orderId]);

  useEffect(() => {
    setInfo(null);
    setMessage(null);
    void load();
  }, [load]);

  if (!info) return null;
  // Nothing to show on an order that never used a card and cannot take one.
  if (!info.canPay && info.applied.length === 0) return null;

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await applyTenderAction(orderId, {
      giftCards: code.trim() ? [{ code }] : undefined,
      loyaltyPoints: points.trim()
        ? points.trim().toLowerCase() === 'all'
          ? 'all'
          : Math.trunc(Number(points))
        : undefined,
    });
    setBusy(false);
    if (!r.ok) return setMessage({ kind: 'error', text: r.error });
    setCode('');
    setPoints('');
    setMessage({
      kind: r.data.warning ? 'error' : 'ok',
      text: r.data.warning
        ? r.data.warning
        : r.data.paid
          ? 'The order is paid in full.'
          : `Applied. ${money(r.data.due)} is still to pay.`,
    });
    await load();
    onChanged?.();
  };

  return (
    <section
      aria-label="Pay with a gift card or points"
      className="space-y-3 rounded-xl border border-line p-4"
    >
      <h3 className="text-sm font-bold text-fg-strong">Gift cards and points</h3>
      <p className="text-xs text-fg-muted" role="status">
        Total {money(info.total)}
        {info.tendered > 0 ? ` · paid with cards or points ${money(info.tendered)}` : ''} · still to
        pay <strong>{money(info.due)}</strong>
      </p>
      {info.applied.length > 0 ? (
        <ul className="text-sm">
          {info.applied.map((a, i) => (
            <li key={i}>
              {a.kind === 'gift_card' ? 'Gift card' : `${a.points ?? 0} loyalty points`}:{' '}
              <span className="font-mono">{money(a.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {info.canPay ? (
        <form onSubmit={apply} className="space-y-3" aria-label="Apply a gift card or points">
          <div>
            <label htmlFor={`${uid}-code`} className={labelClass}>
              Gift card code
            </label>
            <input
              id={`${uid}-code`}
              className={`${fieldClass} font-mono sm:max-w-sm`}
              value={code}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          {info.loyalty ? (
            <div>
              <label htmlFor={`${uid}-pts`} className={labelClass}>
                Loyalty points to use ({info.loyalty.balance.toLocaleString()} available, up to{' '}
                {info.loyalty.maxPercent}% of the order; type all for as many as can be used)
              </label>
              <input
                id={`${uid}-pts`}
                className={`${fieldClass} sm:max-w-xs`}
                value={points}
                inputMode="numeric"
                onChange={(e) => setPoints(e.target.value)}
              />
            </div>
          ) : null}
          <Notice message={message} />
          <button
            type="submit"
            className={primaryButtonClass}
            disabled={busy || (!code.trim() && !points.trim())}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </form>
      ) : (
        <>
          <Notice message={message} />
          {info.cannotBecause ? (
            <p className="text-xs text-fg-muted">{info.cannotBecause}</p>
          ) : null}
        </>
      )}
      <button type="button" className={`${buttonClass} sr-only`} onClick={() => void load()}>
        Refresh
      </button>
    </section>
  );
}
