'use client';

import { useEffect, useRef, useState } from 'react';
import { previewQuotePricesAction } from '@/server/domains/pricing/actions';
import type { QuoteInput } from '@/server/domains/quotes/service';
import type { PriceTrace } from '@/server/domains/pricing/domain/types';

/**
 * Keeps the unit prices of "price list" lines in a quote being typed in step with the price lists:
 * when the customer, the payment type or a quantity changes, the lines are priced again on the
 * server and the answer is shown with its explanation. Typed (`manual`) and saved (`kept`) prices
 * are never touched. Saving prices on the server again, so this is only what the screen shows.
 */
export function useQuotePricePreview(
  input: QuoteInput,
  setInput: React.Dispatch<React.SetStateAction<QuoteInput>>,
) {
  const [traces, setTraces] = useState<Record<number, PriceTrace>>({});
  const [problems, setProblems] = useState<Record<number, string>>({});
  const latest = useRef('');

  const modes = input.lines.map((l) => l.priceMode ?? (l.unitPrice != null ? 'manual' : 'catalog'));
  const signature = JSON.stringify([
    input.customerId ?? null,
    input.paymentMethod,
    input.lines.map((l, i) => [l.productId, l.quantity, modes[i], l.unitId ?? null]),
  ]);

  useEffect(() => {
    latest.current = signature;
    const want = input.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => modes[i] === 'catalog' && l.productId && l.quantity > 0);
    if (want.length === 0) return;
    const timer = setTimeout(() => {
      void previewQuotePricesAction({
        customerId: input.customerId ?? null,
        paymentMethod: input.paymentMethod,
        lines: want.map(({ l }) => ({ productId: l.productId, quantity: l.quantity, unitId: l.unitId ?? null })),
      }).then((r) => {
        // An answer for lines that have since changed would be wrong; drop it.
        if (!r.ok || latest.current !== signature) return;
        const nextTraces: Record<number, PriceTrace> = {};
        const nextProblems: Record<number, string> = {};
        const prices = new Map<number, number | null>();
        want.forEach(({ i }, n) => {
          const a = r.data[n];
          if (!a) return;
          prices.set(i, a.unitPrice);
          nextTraces[i] = a.trace;
          if (a.unitPrice == null)
            nextProblems[i] = a.trace.steps.at(-1) ?? 'This line cannot be priced.';
        });
        setTraces(nextTraces);
        setProblems(nextProblems);
        setInput((cur) => {
          if (
            JSON.stringify([
              cur.customerId ?? null,
              cur.paymentMethod,
              cur.lines.map((l, i) => [
                l.productId,
                l.quantity,
                l.priceMode ?? (l.unitPrice != null ? 'manual' : 'catalog'),
                l.unitId ?? null,
              ]),
            ]) !== signature
          )
            return cur;
          return {
            ...cur,
            lines: cur.lines.map((l, i) => {
              const p = prices.get(i);
              return p == null ? l : { ...l, unitPrice: p };
            }),
          };
        });
      });
    }, 350);
    return () => clearTimeout(timer);
    // The signature carries everything the pricing depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { traces, problems };
}
