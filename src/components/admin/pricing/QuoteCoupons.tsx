'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { previewQuoteDiscountsAction } from '@/server/domains/pricing/discount-actions';
import type { QuoteInput } from '@/server/domains/quotes/service';

const money = (n: number) =>
  n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Preview = Extract<
  Awaited<ReturnType<typeof previewQuoteDiscountsAction>>,
  { ok: true }
>['data'];

/**
 * Where a coupon code is entered on a quote, with what order discounts and coupons would take off
 * as it stands. Only a hint on screen: saving works the discounts out again on the server, and a
 * code that cannot be used stops the save, saying why.
 */
export function QuoteCoupons({
  input,
  onCodes,
}: {
  input: QuoteInput;
  onCodes: (codes: string[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState((input.couponCodes ?? []).join(', '));
  const [preview, setPreview] = useState<Preview | null>(null);
  const latest = useRef('');

  const codes = (input.couponCodes ?? []).join(',');
  const signature = JSON.stringify([
    input.customerId ?? null,
    input.paymentMethod,
    codes,
    input.lines.map((l) => [l.productId, l.quantity, l.unitPrice ?? null, l.discountPercent]),
  ]);

  useEffect(() => {
    latest.current = signature;
    const lines = input.lines.filter((l) => l.productId && l.unitPrice != null && l.quantity > 0);
    if (lines.length === 0) {
      return;
    }
    const timer = setTimeout(() => {
      void previewQuoteDiscountsAction({
        customerId: input.customerId ?? null,
        paymentMethod: input.paymentMethod,
        couponCodes: input.couponCodes ?? [],
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice!,
          discountPercent: l.discountPercent,
        })),
      }).then((r) => {
        if (r.ok && latest.current === signature) setPreview(r.data);
      });
    }, 600);
    return () => clearTimeout(timer);
    // The signature carries everything the preview depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <div className="space-y-1 sm:col-span-2">
      <label htmlFor={`${id}-codes`} className="block text-sm font-medium text-fg">
        Coupon code (optional)
      </label>
      <input
        id={`${id}-codes`}
        type="text"
        value={text}
        placeholder="WELCOME10"
        onChange={(event) => {
          setText(event.target.value);
          onCodes(
            event.target.value
              .split(/[\s,;]+/)
              .map((c) => c.trim().toUpperCase())
              .filter(Boolean),
          );
        }}
        className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong sm:max-w-sm"
      />
      <div aria-live="polite" className="text-xs">
        {preview?.couponProblems.map((p) => (
          <p key={p.code} role="alert" className="text-red-700">
            Coupon {p.code}: {p.reason} The quote cannot be saved with it.
          </p>
        ))}
        {preview?.applied.map((a) => (
          <p key={a.code} className="text-emerald-700">
            {a.name}: {a.how}, takes off {money(a.amount)}
            {a.couponCode ? ` (coupon ${a.couponCode})` : ''}
          </p>
        ))}
        {preview?.gifts.map((g) => (
          <p key={g.code + g.name} className="text-emerald-700">
            Free gift: {g.quantity} × {g.name} (worth {money(g.value)}), added when the quote is
            saved.
          </p>
        ))}
      </div>
    </div>
  );
}
